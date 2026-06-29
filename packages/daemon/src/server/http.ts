// @skillforge/daemon/server/http — the node:http control server + a tiny method/path router (§5, §9).
//
// Zero deps (node:http only). Responsibilities kept deliberately small:
//   • match METHOD + a `/path/with/:params` pattern → a handler (longest static prefix wins on ties);
//   • parse a BOUNDED JSON request body (reject a body over MAX_BODY_BYTES with 413) — an unbounded read
//     is a trivial local DoS;
//   • bind 127.0.0.1 ONLY (a local-first daemon is never exposed on a routable interface) on the
//     configured port (0 ⇒ ephemeral, used by every test);
//   • CORS for the local UI: reflect ONLY localhost/127.0.0.1 origins (a public page must not be able to
//     drive the daemon — DNS-rebinding/CSRF defence), and answer the preflight.
// A handler returns a JsonResponse, or `undefined` when it has TAKEN OVER the socket (SSE `/events`).
// A thrown handler error becomes a 500 with a typed body — never a hung socket, never a silent failure.
import http from "node:http";
// Wave C (D3): the route-contract shapes (RouteDef/RouteHandler/ReqCtx/JsonResponse) are now the single
// source of truth in @skillforge/contracts/http-route — the MCP + proxy adapters import the SAME shapes
// instead of declaring drift-prone copies. Re-exported here so the daemon's internal `from "./http.ts"` /
// `from "../http.ts"` import sites are untouched.
import type { JsonResponse, ReqCtx, RouteHandler, RouteDef } from "@skillforge/contracts/http-route";
export type { JsonResponse, ReqCtx, RouteHandler, RouteDef };
// Wave C (D3): the admission gate (Host/Origin CSRF+rebind), CORS, the bounded body reader + reliable-413
// delivery, and the loopback server lifecycle (with resource caps) are now the single source of truth in
// @skillforge/core/net — shared verbatim with the standalone proxy server instead of duplicated.
import {
  admissionDenyReason,
  corsHeaders,
  readBodyBounded,
  respondPayloadTooLarge,
  startLocalServer,
} from "@skillforge/core";

/** Hard cap on a request body. Source `input` is separately capped at MAX_SOURCE_INPUT_LEN by the route. */
export const MAX_BODY_BYTES = 1_000_000;

interface CompiledRoute extends RouteDef {
  segments: string[];
}

function compile(routes: RouteDef[]): CompiledRoute[] {
  return routes.map((r) => ({ ...r, segments: r.pattern.split("/").filter(Boolean) }));
}

/** decodeURIComponent that NEVER throws: a malformed percent-escape (e.g. `/web/%zz`, `/skills/%`) returns
 *  undefined so the caller treats the segment as NO-MATCH → a controlled 404 — never an uncaught URIError
 *  escaping the router (which would otherwise reject the async handle() promise instead of replying). */
function safeDecode(seg: string): string | undefined {
  try {
    return decodeURIComponent(seg);
  } catch {
    return undefined; // malformed %-encoding
  }
}

/** Match `pathSegments` against a compiled route; returns captured params or undefined on no match.
 *  A route whose LAST pattern segment is `*` is a trailing wildcard (used only by the static UI serve):
 *  the fixed prefix must match and the remaining (decoded) path is captured into `params["*"]` so the
 *  static handler can resolve it under web/ with the SAME resolveUnderRoot containment the ui precursor
 *  uses. Decoding each rest segment means an encoded traversal (e.g. `%2e%2e`) reaches resolveUnderRoot
 *  as `..` and is refused there, not silently served; a malformed escape is NO-MATCH (controlled 404). */
function matchRoute(route: CompiledRoute, pathSegments: string[]): Record<string, string> | undefined {
  const segs = route.segments;
  const wildcard = segs.length > 0 && segs[segs.length - 1] === "*";
  if (wildcard) {
    const prefix = segs.length - 1;
    if (pathSegments.length < prefix) return undefined;
    const params: Record<string, string> = {};
    for (let i = 0; i < prefix; i++) {
      const pat = segs[i]!;
      const seg = pathSegments[i]!;
      if (pat.startsWith(":")) {
        const d = safeDecode(seg);
        if (d === undefined) return undefined;
        params[pat.slice(1)] = d;
      } else if (pat !== seg) return undefined;
    }
    const rest: string[] = [];
    for (const s of pathSegments.slice(prefix)) {
      const d = safeDecode(s);
      if (d === undefined) return undefined; // a malformed escape in the wildcard tail → no-match → 404
      rest.push(d);
    }
    params["*"] = rest.join("/");
    return params;
  }
  if (segs.length !== pathSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const pat = segs[i]!;
    const seg = pathSegments[i]!;
    if (pat.startsWith(":")) {
      const d = safeDecode(seg);
      if (d === undefined) return undefined; // malformed `:param` escape → no-match → 404 (never a throw)
      params[pat.slice(1)] = d;
    } else if (pat !== seg) return undefined;
  }
  return params;
}

// ── ADMISSION GATE + CORS + bounded body/413: now @skillforge/core/net (Wave C / D3), shared with the proxy.
//    admissionDenyReason / corsHeaders / readBodyBounded / respondPayloadTooLarge are imported above. ──

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string>): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extra });
  res.end(payload);
}

export interface HttpServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Start the control server on 127.0.0.1:`port` (0 ⇒ ephemeral). Resolves once listening with the bound
 * port. Every request is routed; unmatched method+path → 404, a matched-path/wrong-method → 405.
 */
export function startHttpServer(routes: RouteDef[], port: number): Promise<HttpServer> {
  const compiled = compile(routes);
  // Lifecycle + resource caps (concurrency / slow-request timeouts) live in core/net/server; SSE is unaffected
  // (requestTimeout bounds RECEIVING a request, not a long-lived /events response). closeAllConnections on stop.
  return startLocalServer((req, res) => handle(req, res, compiled), port);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, compiled: CompiledRoute[]): Promise<void> {
  const origin = req.headers.origin;
  const cors = corsHeaders(typeof origin === "string" ? origin : undefined);
  const method = (req.method ?? "GET").toUpperCase();

  // ADMISSION GATE — refuse a cross-site / DNS-rebinding request BEFORE any side effect (incl. OPTIONS).
  // No CORS headers on a 403: the request was never admitted, so there is nothing to expose.
  const deny = admissionDenyReason(req, "daemon");
  if (deny) {
    sendJson(res, 403, { error: "forbidden", reason: deny }, {});
    return;
  }

  // CORS preflight — answer before routing.
  if (method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathSegments = url.pathname.split("/").filter(Boolean);

  // find a route whose pattern matches the path; track whether the path matched any pattern (→ 405 vs 404).
  let pathMatched = false;
  for (const route of compiled) {
    const params = matchRoute(route, pathSegments);
    if (!params) continue;
    pathMatched = true;
    if (route.method !== method) continue;

    let body: unknown;
    if (!route.raw && (method === "POST" || method === "PATCH" || method === "PUT")) {
      const read = await readBodyBounded(req, MAX_BODY_BYTES);
      if (!read.ok) {
        // Reliable 413 + bounded lingering-close (core/net): write the status, then resume-and-discard the
        // rest of the over-cap upload for a bounded window so the client READS the 413 instead of an
        // ECONNRESET, then force the socket shut. `connection: close` keeps the undrained socket out of reuse.
        respondPayloadTooLarge(req, res, MAX_BODY_BYTES, cors);
        return;
      }
      if (read.raw.trim() !== "") {
        try {
          body = JSON.parse(read.raw);
        } catch {
          sendJson(res, 400, { error: "invalid-json" }, cors);
          return;
        }
      }
    }

    const ctx: ReqCtx = { method, params, query: url.searchParams, body, req, res };
    try {
      const result = await route.handler(ctx);
      if (result === undefined) return; // handler took over the socket (SSE) or already responded
      sendJson(res, result.status, result.body, { ...cors, ...(result.headers ?? {}) });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: "internal", message: (e as Error).message }, cors);
      else res.end();
    }
    return;
  }

  sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? "method-not-allowed" : "not-found" }, cors);
}

/** Open an SSE stream on `res` and return a `write(event)` helper + the underlying response. The caller
 *  subscribes/unsubscribes the event bus and registers the close handler. Returns the SSE writer. */
export function openSseStream(res: http.ServerResponse, headers: Record<string, string> = {}): (eventType: string, data: unknown) => void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...headers,
  });
  res.write(": connected\n\n"); // an immediate comment frame opens the stream (flushes headers)
  // Backpressure: a slow/stuck client whose kernel send buffer fills makes res.write() return false.
  // We must NOT keep buffering frames in userland (unbounded memory — a slowloris on the SSE endpoint).
  // SSE frames are droppable (the UI re-hydrates via getActivity on reconnect), so we DROP frames while
  // backpressured and resume on 'drain'. This bounds memory to the kernel buffer regardless of client speed.
  let backpressured = false;
  res.on("drain", () => {
    backpressured = false;
  });
  return (eventType: string, data: unknown): void => {
    if (backpressured) return; // slow client: drop until the socket drains rather than buffer unboundedly
    const ok = res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!ok) backpressured = true; // kernel buffer full → stop writing until 'drain' fires
  };
}

// @skillforge/proxy/server — the standalone node:http server wrapping the proxy handlers.
//
// ZERO deps (node:http only). It binds 127.0.0.1 ONLY (a local-first proxy is never exposed on a routable
// interface) and admits a request only when it cannot be a cross-site / DNS-rebinding attack (local Host;
// a present Origin must also be local — the same admission posture as the daemon's control server). The
// handlers own body reading (bounded) and the upstream passthrough; this server only routes + admits.
//
// The proxy handlers HIJACK ctx.res to pass the upstream response through, returning `undefined`; an early
// validation/config error returns a JsonResponse which this server serializes. GET /healthz is a tiny
// liveness probe (so an operator can see the proxy is up — actor-observability).
import type http from "node:http";
import { admissionDenyReason, startLocalServer } from "@skillforge/core";
import type { JsonResponse, ProxyHandlers } from "./index.ts";

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extra });
  res.end(payload);
}

export interface ProxyServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Start the standalone proxy on 127.0.0.1:`port` (0 ⇒ ephemeral, used by tests). Resolves once listening
 * with the bound port. Routes POST /v1/chat/completions + POST /v1/embeddings to the handlers; GET /healthz
 * is a liveness probe; everything else is 404.
 */
export function startProxyServer(handlers: ProxyHandlers, port: number): Promise<ProxyServer> {
  // Lifecycle + resource caps shared with the daemon (core/net/server): binds 127.0.0.1 only, bounded
  // concurrency + slow-request timeouts, closeAllConnections on stop.
  return startLocalServer((req, res) => handle(req, res, handlers), port);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, handlers: ProxyHandlers): Promise<void> {
  const deny = admissionDenyReason(req, "proxy");
  if (deny) {
    sendJson(res, 403, { error: "forbidden", reason: deny });
    return;
  }

  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "GET" && (pathname === "/healthz" || pathname === "/health")) {
    sendJson(res, 200, { ok: true });
    return;
  }

  const route =
    pathname === "/v1/chat/completions" ? handlers.chat : pathname === "/v1/embeddings" ? handlers.embeddings : undefined;

  if (!route) {
    sendJson(res, 404, { error: "not-found", path: pathname });
    return;
  }
  if (method !== "POST") {
    sendJson(res, 405, { error: "method-not-allowed" });
    return;
  }

  const ctx = { method, params: {}, query: url.searchParams, body: undefined, req, res };
  try {
    const result: JsonResponse | undefined = await route(ctx);
    if (result === undefined) return; // handler hijacked the socket (upstream passthrough / streaming)
    sendJson(res, result.status, result.body, result.headers ?? {});
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: "internal", message: (e as Error).message });
    else if (!res.writableEnded) res.end();
  }
}

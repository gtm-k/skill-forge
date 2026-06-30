// @skillforge/ui/server — a MINIMAL, read-only Node http server that powers the visual manager (PLAN
// §9, D12). It is NOT the Phase-2 daemon: no SQLite, no writes, no SSE, no long-lived state. It exists
// only to (a) serve the hand-written static web/ files and (b) expose a tiny read-only API that runs
// @skillforge/core's select() server-side so the route tester can show the LIVE semantic tier (and
// degrade visibly to lexical when LM Studio is down). It is a clean precursor to the daemon, nothing more.
//
// Every route is READ-ONLY. The server never writes a byte to the skill home. Errors are surfaced as
// JSON (400/404/500) — never a silent empty 200 (observability-first: an API consumer sees only the
// response, so an error MUST be in the response). Static files resolve strictly under web/ via
// core.resolveUnderRoot; a path that escapes web/ is a 404, never a read outside the served dir.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolveUnderRoot, PathEscapeError } from "@skillforge/core";
import type { TargetId } from "@skillforge/contracts";
import { routeQuery, listSkills, readInstructions, type QueryEmbedder } from "./select-handler.ts";

const WEB_DIR = path.join(import.meta.dirname, "..", "web");

const VALID_TARGETS: readonly TargetId[] = ["lmstudio", "mcp", "proxy"];
function asTarget(v: string | null): TargetId | undefined {
  return VALID_TARGETS.find((t) => t === v);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── the LIVE query embedder (network EDGE capability core refuses to hold; mirrors cli/embed.ts) ──
const DEFAULT_EMBED_ENDPOINT = "http://127.0.0.1:1234/v1/embeddings";
const EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5";
const EMBED_TIMEOUT_MS = 1500; // degrade FAST to lexical when LM Studio is absent — the tester must not hang

/**
 * The real LM Studio query embedder: POST {model, input:[text]} to the OpenAI-compatible /v1/embeddings
 * endpoint and return data[0].embedding. ANY failure (endpoint down, non-2xx, timeout, malformed body)
 * resolves to undefined so routeQuery degrades to lexical and the UI shows the "degraded" banner — the
 * degraded path is visible, never a crash and never silent.
 */
export function lmStudioQueryEmbedder(
  endpoint = DEFAULT_EMBED_ENDPOINT,
  model = EMBED_MODEL,
): QueryEmbedder {
  return async (text: string): Promise<number[] | undefined> => {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: [text] }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: { embedding?: number[] }[] };
      const vec = json.data?.[0]?.embedding;
      return Array.isArray(vec) && vec.length > 0 ? vec : undefined;
    } catch {
      return undefined; // connection refused / timeout / parse error → lexical fallback (observable upstream)
    }
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function serveStatic(res: http.ServerResponse, relPath: string): Promise<void> {
  let abs: string;
  try {
    abs = resolveUnderRoot(WEB_DIR, relPath); // containment: a traversal escapes web/ → PathEscapeError
  } catch (e) {
    if (e instanceof PathEscapeError) return sendError(res, 404, "not found");
    throw e;
  }
  let data: Buffer;
  try {
    data = await fs.promises.readFile(abs);
  } catch {
    return sendError(res, 404, `not found: ${relPath}`);
  }
  const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(data);
}

const MAX_BODY_BYTES = 64 * 1024; // a route utterance is tiny; cap the read to avoid an unbounded buffer
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handle(home: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = req.method ?? "GET";

  // ── static (read-only) ──
  if (method === "GET" && pathname === "/") return serveStatic(res, "index.html");
  if (method === "GET" && pathname.startsWith("/web/")) return serveStatic(res, pathname.slice("/web/".length));

  // ── read-only API ──
  if (method === "GET" && pathname === "/api/manifest") {
    const target = asTarget(url.searchParams.get("target"));
    return sendJson(res, 200, { skills: listSkills(home, target) });
  }

  if (method === "GET" && pathname === "/api/instructions") {
    const dir = url.searchParams.get("dir");
    if (!dir) return sendError(res, 400, "missing ?dir");
    try {
      return sendJson(res, 200, { dir, text: readInstructions(home, dir) });
    } catch (e) {
      if (e instanceof PathEscapeError) return sendError(res, 400, "dir escapes the skill home");
      return sendError(res, 404, `cannot read instructions for ${JSON.stringify(dir)}`);
    }
  }

  if (method === "POST" && pathname === "/api/select") {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return sendError(res, 400, "body must be JSON");
    }
    const { query, target: rawTarget } = (parsed ?? {}) as { query?: unknown; target?: unknown };
    if (typeof query !== "string" || query.trim() === "") return sendError(res, 400, "missing query");
    const target = asTarget(typeof rawTarget === "string" ? rawTarget : null) ?? "lmstudio";
    // Use the real LM Studio query embedder by default: shows the live semantic tier when LM Studio is up
    // and degrades visibly (semantic.degraded) when it is not. Never writes; never throws to the socket.
    const result = await routeQuery(home, query, target, lmStudioQueryEmbedder());
    return sendJson(res, 200, result);
  }

  return sendError(res, 404, `no route for ${method} ${pathname}`);
}

/** Build the read-only http server for `home`. Caller listens (see startServer). Never writes to disk. */
export function createServer(home: string): http.Server {
  return http.createServer((req, res) => {
    handle(home, req, res).catch((err: unknown) => {
      // Last-resort guard: a handler throw becomes a JSON 500, never a hung socket or silent drop.
      if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : "internal error");
      else res.end();
    });
  });
}

/**
 * Start the read-only server on `port` (0 = ephemeral, the hermetic-test default) bound to loopback.
 * Resolves with the actual bound port and an awaitable close(). Loopback-only: a read-only dev console
 * has no business listening on a public interface.
 */
export function startServer(home: string, port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(home);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = addr && typeof addr === "object" ? addr.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

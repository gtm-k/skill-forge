// @skillforge/proxy/forward — the outbound call to the OpenAI-compat upstream + the response passthrough.
//
// ZERO third-party deps: the outbound call uses the global `fetch` (Node 22), injectable for tests. Two
// passthrough modes, and the request is the ONLY thing the proxy ever mutated (a system message was spliced
// in upstream of here):
//   • STREAMING-TRANSPARENT (client asked stream:true): pipe the upstream SSE ReadableStream straight back
//     to the client socket UNTOUCHED (Readable.fromWeb → res). Bytes are never parsed or re-encoded, so the
//     proxy is transparent on the token stream.
//   • NON-STREAMING: read the upstream body as raw bytes and write them through with the upstream's status —
//     the exact provider response (any extra fields included) reaches the client.
// The upstream's content-type and status are mirrored; the proxy's own X-Skill-* observability headers are
// added alongside (they never touch the body). A failed outbound call surfaces a visible 502 (never silent).
import { Readable } from "node:stream";
import type http from "node:http";

/** The injectable fetch shape — the global `fetch` satisfies it; tests can pass a fake. */
export type ChatFetch = typeof fetch;

/** writeHead guarded against a double-send (a no-op once headers are on the wire). */
function writeHeadSafe(r: http.ServerResponse, status: number, headers: Record<string, string>): void {
  if (!r.headersSent) r.writeHead(status, headers);
}

/** Resolve an upstream base URL to its concrete `/v1/chat/completions` endpoint, tolerating a baseUrl that
 *  already points at `/v1` or the full path (mirrors core.resolveEmbeddingsUrl for the chat route). */
export function resolveChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/v1\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

export interface ForwardOptions {
  /** the absolute upstream endpoint to POST to. */
  url: string;
  /** the (already-mutated) request body to forward — serialized as JSON. */
  body: unknown;
  /** true ⇒ pipe the upstream response body through untouched (the client requested stream:true). */
  stream: boolean;
  /** the client socket the upstream response is written to (hijacked). */
  res: http.ServerResponse;
  /** extra response headers (the proxy's X-Skill-* observability signals) added alongside the upstream's. */
  extraHeaders?: Record<string, string>;
  /** an Authorization header to forward to the upstream (vLLM/keyed providers) — passed through only if set. */
  authorization?: string;
  /** injected fetch (default = global fetch). */
  fetchImpl?: ChatFetch;
  /** connect + initial-response deadline (ms). <=0 / undefined ⇒ DEFAULT_UPSTREAM_TIMEOUT_MS. On timeout the
   *  outbound fetch is aborted and UpstreamTimeout is thrown BEFORE any byte is written (a visible 504). */
  timeoutMs?: number;
}

/** Default connect + initial-response deadline. Generous enough that a live (even slow-to-first-token) upstream
 *  is never cut off; small enough that a DEAD upstream cannot hang the client request indefinitely. The deadline
 *  bounds ONLY the time-to-response-headers — it is cleared once the Response resolves, so a long token stream is
 *  never killed by it. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/** A typed outbound failure (the upstream was unreachable) — surfaced as a 502, never swallowed. */
export class UpstreamUnreachable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamUnreachable";
  }
}

/** A typed outbound timeout (the upstream accepted the socket but never produced a response in time) — surfaced
 *  as a 504 BEFORE any byte is written, never a hung socket, never silent. */
export class UpstreamTimeout extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamTimeout";
  }
}

/**
 * Forward the mutated request to the upstream and pass its response through to `res`. Hijacks the socket:
 * the caller must return `undefined` from its handler afterwards. Throws UpstreamUnreachable BEFORE any byte
 * is written when the outbound call fails (so the caller can still emit a clean 502).
 */
export async function forwardToUpstream(opts: ForwardOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.authorization) headers["authorization"] = opts.authorization;

  // Connect + initial-response deadline: a dead upstream (accepts the socket, never responds) must NEVER hang
  // the client request. The AbortController bounds ONLY the outbound fetch up to response headers — it is cleared
  // the instant the Response resolves, so a long-but-live token stream is not killed by this timeout.
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let upstream: Response;
  try {
    upstream = await fetchImpl(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (cause) {
    if (timedOut) {
      throw new UpstreamTimeout(`upstream ${opts.url} timed out after ${timeoutMs}ms (no response)`, { cause });
    }
    throw new UpstreamUnreachable(`upstream ${opts.url} unreachable: ${(cause as Error)?.message ?? cause}`, { cause });
  } finally {
    clearTimeout(timer);
  }

  // Mirror the upstream content-type (text/event-stream for a stream, application/json otherwise) and add the
  // proxy's observability headers. The body itself is never altered — only the request was mutated.
  const outHeaders: Record<string, string> = {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    ...(opts.extraHeaders ?? {}),
  };

  if (opts.stream) {
    // STREAMING-TRANSPARENT: pipe the upstream ReadableStream straight to the client socket, bytes untouched.
    writeHeadSafe(opts.res, upstream.status, outHeaders);
    if (!upstream.body) {
      opts.res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    await new Promise<void>((resolve) => {
      nodeStream.on("error", () => {
        // an upstream stream error mid-flight: end the (already-headed) client socket rather than hang it.
        if (!opts.res.writableEnded) opts.res.end();
        resolve();
      });
      // CLIENT ABORT: when the client socket closes mid-stream, DESTROY the upstream node stream so the upstream
      // connection is cancelled (Readable.fromWeb().destroy() cancels the underlying web ReadableStream, which
      // releases the fetch socket). Without this the upstream keeps generating after the client is gone — wasted
      // upstream compute + leaked sockets under repeated cancellation. The guard makes the abort intent explicit:
      // we destroy ONLY when the upstream has neither already ended nor been destroyed — i.e. the client aborted
      // BEFORE the upstream finished. On a NORMAL finish `readableEnded` is already true (the close event follows
      // finish), so this skips the destroy entirely and the fully-piped passthrough bytes are never touched.
      opts.res.on("close", () => {
        if (!nodeStream.destroyed && !nodeStream.readableEnded) nodeStream.destroy();
        resolve();
      });
      opts.res.on("finish", () => resolve());
      nodeStream.pipe(opts.res);
    });
    return;
  }

  // NON-STREAMING: pass the exact upstream bytes through with its status.
  const buf = Buffer.from(await upstream.arrayBuffer());
  writeHeadSafe(opts.res, upstream.status, outHeaders);
  opts.res.end(buf);
}

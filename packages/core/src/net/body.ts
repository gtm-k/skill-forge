// @skillforge/core/net/body — the SHARED bounded request-body reader + reliable over-cap 413 delivery, the
// single source of truth for the daemon control server (1MB cap) and the proxy (10MB chat cap) (Wave C / D3).
//
// Two coupled concerns the daemon and proxy both had to get right and had COPIED:
//   1. BOUNDED read — never buffer an unbounded body (a trivial local DoS). Stop at `cap` bytes.
//   2. RELIABLE 413 — when we reject, the client must actually READ the 413. The naive "pause the stream, send
//      413, close" RST-resets the socket while a LARGE upload is still in flight, so the client sees ECONNRESET
//      on its write side BEFORE it reads the status (an actor-observability gap: the over-cap actor learns
//      nothing). The fix is `respondPayloadTooLarge` below: write the 413, then BOUNDED-LINGER — resume and
//      DISCARD the remaining inbound bytes (capped by time AND bytes) so the peer can finish flushing and read
//      our response, then force the socket shut. Bounding the drain keeps the DoS protection intact.
import type http from "node:http";

export type BodyRead = { ok: true; raw: string } | { ok: false };

/** Read the request body up to `cap` bytes; resolve {ok:false} on overflow. On overflow the stream is PAUSED
 *  (we stop buffering past the cap — the DoS bound) but the socket is NOT destroyed: the caller writes the 413
 *  and then calls `respondPayloadTooLarge` (which resumes a bounded drain) so the client can read the status. */
export function readBodyBounded(req: http.IncomingMessage, cap: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > cap) {
        overflowed = true;
        req.pause(); // stop reading more (bounded read) WITHOUT pre-empting the 413 the caller writes next
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overflowed) resolve({ ok: true, raw: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => {
      if (!overflowed) resolve({ ok: false });
    });
  });
}

export interface LingerOptions {
  /** max wall-clock to keep draining the refused upload before forcing the socket shut (default 2000ms). */
  graceMs?: number;
  /** max additional inbound bytes to discard while lingering before forcing the socket shut (default 2MB). */
  maxDrainBytes?: number;
}

/** Bounded lingering close on a request whose body we REFUSED, AFTER its (413) response has been written. Resume
 *  and DISCARD remaining inbound bytes so the peer can finish flushing its upload and READ the response.
 *  Closure paths, kept distinct so the response is NEVER RST-raced (the bug a naive "destroy on req end" has):
 *   • GRACEFUL — the client finishes sending (req `end`/`error`): we do NOT destroy. The response carried
 *     `connection: close`, so Node closes the socket ITSELF once the response has flushed + the request drained,
 *     guaranteeing the 413 reaches the client. A manual destroy here could RST before the 413 was on the wire.
 *   • FORCED — the client floods past `maxDrainBytes` (abusive): we destroy, but only AFTER the response's
 *     `finish` event, so the 413 is on the wire first; if it hasn't finished yet we defer the destroy to `finish`.
 *   • BACKSTOP — `graceMs` elapses (e.g. a slowloris that never ends): force-destroy unconditionally. By then a
 *     tiny 413 has long flushed; this only bounds the work for a wedged/abusive peer.
 *  Bounded by BOTH `maxDrainBytes` and `graceMs` so a client cannot make us drain forever (the DoS bound). */
export function lingeringClose(req: http.IncomingMessage, res: http.ServerResponse, opts: LingerOptions = {}): void {
  const graceMs = opts.graceMs ?? 2000;
  const maxDrainBytes = opts.maxDrainBytes ?? 2_000_000;
  const socket = res.socket ?? req.socket;
  if (!socket || socket.destroyed) return;

  let settled = false;
  let drained = 0;
  let responseFinished = res.writableFinished === true;
  let forcePending = false; // abusive flood detected, waiting for the 413 to flush before we destroy

  const cleanup = (): void => {
    clearTimeout(timer);
    req.removeListener("data", onData);
    req.removeListener("end", onEnd);
    req.removeListener("error", onEnd);
    res.removeListener("finish", onFinish);
  };
  /** Graceful: client done — leave the socket to Node's `connection: close` (the 413 is delivered). */
  const settleGraceful = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
  };
  /** Forced: tear the socket down (abusive flood or the grace backstop). */
  const destroyNow = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (!socket.destroyed) socket.destroy();
  };
  /** Abusive flood: force-shut, but only once the 413 has flushed so we never RST before the response. */
  const forceShutWhenFlushed = (): void => {
    if (responseFinished) destroyNow();
    else forcePending = true;
  };
  const onFinish = (): void => {
    responseFinished = true;
    if (forcePending) destroyNow();
  };
  const onData = (chunk: Buffer): void => {
    drained += chunk.length;
    if (drained > maxDrainBytes) forceShutWhenFlushed(); // bound — never drain an attacker's endless body
  };
  const onEnd = (): void => settleGraceful();
  const timer = setTimeout(destroyNow, graceMs); // absolute backstop (the 413 has long flushed by graceMs)
  if (typeof timer.unref === "function") timer.unref(); // a lingering drain must not keep the process alive

  if (!responseFinished) res.on("finish", onFinish);
  req.on("data", onData);
  req.on("end", onEnd);
  req.on("error", onEnd);
  req.resume(); // resume (we paused on overflow) and discard — lets the client flush its upload + read the 413
}

/** Write a payload-too-large 413 the client can RELIABLY read, then bounded-linger-close (see above). Carries
 *  `connection: close` — the undrained socket must never be reused for a keep-alive request (slowloris/desync
 *  bound). `extraHeaders` lets a host add CORS. Returns nothing: the handler has taken over the socket. */
export function respondPayloadTooLarge(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cap: number,
  extraHeaders: Record<string, string> = {},
  opts: LingerOptions = {},
): void {
  if (!res.headersSent) {
    res.writeHead(413, {
      "content-type": "application/json; charset=utf-8",
      connection: "close",
      ...extraHeaders,
    });
  }
  // end() THEN linger: lingeringClose listens for the response's `finish` before any FORCED destroy, so the
  // 413 is guaranteed on the wire; a graceful client-end lets `connection: close` close the socket cleanly.
  res.end(JSON.stringify({ error: "payload-too-large", maxBytes: cap }));
  lingeringClose(req, res, opts);
}

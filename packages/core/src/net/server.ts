// @skillforge/core/net/server — the SHARED loopback http server lifecycle for the daemon control server and
// the standalone proxy server (Wave C / D3). Both had byte-identical create/listen/close blocks; the only
// difference is the per-request callback, which is the parameter. Promoting it also lets us add the resource
// caps (concurrency + slow-request timeouts) in ONE place — they were absent before (Node defaults: unbounded
// connections, a 5-minute requestTimeout), the "shared-port concurrency/timeout caps" Wave-C hardening.
import http from "node:http";

export interface LocalHttpServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface LocalServerOptions {
  /** cap on simultaneous sockets (a local-first server has a tiny legitimate fan-in; default 1024). */
  maxConnections?: number;
  /** max time to receive a COMPLETE request — headers + body (bounds slowloris; default 60_000ms). Does NOT
   *  bound a long-lived RESPONSE (SSE): the GET request itself completes instantly, so /events is unaffected. */
  requestTimeoutMs?: number;
  /** max time to receive request HEADERS (default 30_000ms; must be ≤ requestTimeout). */
  headersTimeoutMs?: number;
  /** idle keep-alive socket timeout (default left at Node's value). */
  keepAliveTimeoutMs?: number;
}

/**
 * Start a loopback http server on 127.0.0.1:`port` (0 ⇒ ephemeral). Binds 127.0.0.1 ONLY — a local-first
 * server is never exposed on a routable interface. Applies bounded resource caps. Resolves once listening with
 * the bound port. `onRequest` owns routing + admission; a thrown onRequest must be handled inside it (the
 * wrapper only fires-and-forgets, exactly as the daemon/proxy did, since each handler has its own try/catch).
 */
export function startLocalServer(
  onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
  port: number,
  opts: LocalServerOptions = {},
): Promise<LocalHttpServer> {
  const server = http.createServer((req, res) => {
    void onRequest(req, res);
  });

  // Resource caps (the local-DoS bound at the connection layer; per-body bounding lives in net/body.ts).
  server.maxConnections = opts.maxConnections ?? 1024;
  server.requestTimeout = opts.requestTimeoutMs ?? 60_000;
  server.headersTimeout = opts.headersTimeoutMs ?? 30_000;
  if (opts.keepAliveTimeoutMs !== undefined) server.keepAliveTimeout = opts.keepAliveTimeoutMs;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}`,
        close: () =>
          new Promise<void>((res2) => {
            // server.close() alone WAITS for in-flight keep-alive / SSE sockets to drain — a held-open /events
            // stream would hang shutdown. Force lingering sockets closed so stop()/SIGTERM is bounded.
            server.close(() => res2());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

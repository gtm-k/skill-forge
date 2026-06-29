// @skillforge/contracts/http-route — the SINGLE SOURCE OF TRUTH for the node:http route contract.
//
// The daemon owns the HTTP server *implementation* (packages/daemon/server/http.ts), but the *shapes* a
// route must satisfy — RouteDef / RouteHandler / ReqCtx / JsonResponse — are a cross-package agreement: the
// MCP and proxy adapters build RouteDef[]s the daemon mounts (Wave B), yet PLAN §2 forbids an adapter from
// importing the daemon or a sibling adapter. Before Wave C each of those three places DECLARED its own
// structurally-identical copy and relied on TypeScript's structural typing to make them interchangeable —
// faithful, but a silent-drift risk (D3: one shared contract, not three copies). Promoting the shapes here,
// the lowest layer everyone already depends on, makes the agreement SINGLE-SOURCED (one definition the three
// import) instead of three hand-synced copies, with no daemon/adapter import-direction violation. (Note: CI
// runs type-stripping, not `tsc`, so this is enforced by single-sourcing — not a type-check gate.)
//
// A handler returns a JsonResponse, or `undefined` when it has TAKEN OVER the socket (ctx.res): the daemon's
// SSE `/events` stream and the proxy's upstream passthrough both hijack the response and write it themselves.
import type http from "node:http";

export interface JsonResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ReqCtx {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** parsed JSON body — `undefined` for GET/DELETE, an empty body, or a `raw` route whose handler reads ctx.req itself. */
  body: unknown;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

/** A handler returns a JsonResponse, or `undefined` when it has hijacked the response (SSE / streaming passthrough). */
export type RouteHandler = (ctx: ReqCtx) => Promise<JsonResponse | undefined> | JsonResponse | undefined;

export interface RouteDef {
  method: string;
  /** e.g. "/sources/:sourceId/resync" or "/v1/chat/completions" — `:name` segments are captured into ctx.params. */
  pattern: string;
  handler: RouteHandler;
  /** when true the body is NOT pre-parsed — the handler reads/streams ctx.req itself (daemon SSE; proxy passthrough). */
  raw?: boolean;
}

// @skillforge/mcp-server/http — createMcpHttpHandler(deps): a Streamable-HTTP MCP endpoint as a
// RouteDef[]-compatible array that Wave B mounts into the daemon's route table.
//
// We CANNOT import @skillforge/daemon (deps = core + contracts only). The RouteDef / ReqCtx / JsonResponse
// shapes come from @skillforge/contracts/http-route — the SINGLE SOURCE OF TRUTH the daemon also imports
// (Wave C / D3), not a hand-kept mirror. Structural typing makes the returned RouteDef[] assignable straight
// into buildRoutes()'s array — Wave B does `...createMcpHttpHandler(daemonBackedDeps)` and the daemon's
// admission gate (local Host + Origin) + body-bounding + CORS apply to this endpoint for free.
//
// TRANSPORT: a POST whose JSON body is one JSON-RPC message (or a batch array) → the JSON-RPC response as
// the JSON body (HTTP 200). A notification (no id) yields no reply → HTTP 202 Accepted with no body. The
// daemon pre-parses the JSON body and 400s invalid JSON before we are reached, so we only see parsed values.

import { createMcpServer, type McpServer } from "./server.ts";
import { error as rpcError, isRequestShape, JSON_RPC, type JsonRpcResponse } from "./protocol.ts";
import type { McpServerDeps } from "./deps.ts";

// ── route contract: the single source of truth in @skillforge/contracts/http-route (Wave C / D3), shared
//    with the daemon. Re-exported so existing `from "./http.ts"` import sites (index.ts) are unchanged. ──
import type { JsonResponse, ReqCtx, RouteHandler, RouteDef } from "@skillforge/contracts/http-route";
export type { JsonResponse, ReqCtx, RouteHandler, RouteDef };

export interface McpHttpOptions {
  /** route pattern to mount at (default "/mcp"). */
  pattern?: string;
}

/** Handle ONE already-parsed JSON value as a JSON-RPC message; null when it was a notification. */
async function handleOne(server: McpServer, value: unknown): Promise<JsonRpcResponse | null> {
  if (!isRequestShape(value)) {
    return rpcError(null, JSON_RPC.INVALID_REQUEST, "invalid request: not a JSON-RPC 2.0 request object");
  }
  return server.handle(value);
}

/**
 * Build the MCP Streamable-HTTP route(s) over the injected deps. Returns a RouteDef[] for Wave B to mount;
 * this module mounts NOTHING itself (the daemon owns the server lifecycle).
 */
export function createMcpHttpHandler(deps: McpServerDeps, opts: McpHttpOptions = {}): RouteDef[] {
  const server = createMcpServer(deps);
  const pattern = opts.pattern ?? "/mcp";

  return [
    {
      method: "POST",
      pattern,
      handler: async (ctx: ReqCtx): Promise<JsonResponse> => {
        const body = ctx.body;
        if (Array.isArray(body)) {
          // JSON-RPC 2.0 §6: an EMPTY batch array is itself an invalid request → ONE -32600 error response
          // (not a 202 no-body), with a null id (no element to take an id from).
          if (body.length === 0) {
            return { status: 200, body: rpcError(null, JSON_RPC.INVALID_REQUEST, "invalid request: empty batch array") };
          }
          const responses: JsonRpcResponse[] = [];
          for (const item of body) {
            const res = await handleOne(server, item);
            if (res) responses.push(res);
          }
          // A batch made ENTIRELY of notifications yields no responses → HTTP 202 no-body (JSON-RPC §6).
          return responses.length === 0 ? { status: 202 } : { status: 200, body: responses };
        }
        const res = await handleOne(server, body);
        return res === null ? { status: 202 } : { status: 200, body: res };
      },
    },
  ];
}

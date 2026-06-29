// @skillforge/mcp-server/protocol — hand-rolled JSON-RPC 2.0 types + parse/serialize helpers.
//
// ZERO third-party deps (no @modelcontextprotocol/sdk). MCP rides JSON-RPC 2.0; this module owns the
// wire envelope only — message shapes, the standard error codes, and a parse that NEVER throws (a
// malformed line becomes a typed parse failure, mapped by the caller to a -32700 reply with a null id).
// The transport (stdio / HTTP) and the dispatcher (server.ts) build on these, so the protocol surface
// is testable in isolation and identical across both transports.

/** A JSON-RPC id: string | number | null. A request that OMITS `id` entirely is a NOTIFICATION. */
export type JsonRpcId = string | number | null;

/** An inbound JSON-RPC message. `id` ABSENT (undefined) ⇒ a notification (no reply is ever sent). */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** The standard JSON-RPC 2.0 error codes (the only ones MCP uses at the protocol layer). */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Build a success response echoing the request id. */
export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

/** Build an error response echoing the request id (null when the id is unknown, e.g. a parse error). */
export function error(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError {
  const body: JsonRpcErrorBody = { code, message };
  if (data !== undefined) body.data = data;
  return { jsonrpc: "2.0", id, error: body };
}

/** A NOTIFICATION carries no `id`. Such a message MUST NOT be replied to (JSON-RPC 2.0 §4.1). */
export function isNotification(msg: JsonRpcRequest): boolean {
  return msg.id === undefined;
}

/** Structural validity per JSON-RPC 2.0 §4: an object with `jsonrpc:"2.0"`, a string `method`, and — when
 *  present — an `id` that is string | number | null (an ABSENT id ⇒ a notification). Anything else (wrong/
 *  missing `jsonrpc`, an object/array/boolean id) is INVALID_REQUEST, not a request we will dispatch. */
export function isRequestShape(v: unknown): v is JsonRpcRequest {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { jsonrpc?: unknown; method?: unknown; id?: unknown };
  if (o.jsonrpc !== "2.0") return false;
  if (typeof o.method !== "string") return false;
  if ("id" in o) {
    const id = o.id;
    if (id !== null && typeof id !== "string" && typeof id !== "number") return false;
  }
  return true;
}

export type ParseOutcome =
  | { ok: true; msg: JsonRpcRequest }
  | { ok: false; code: number; message: string };

/**
 * Parse ONE newline-delimited JSON-RPC message. NEVER throws: a non-JSON line is a -32700 parse error;
 * a JSON value that is not a request-shaped object is a -32600 invalid request. The caller turns either
 * into an error reply with a null id (the id cannot be known for a message we could not parse).
 */
export function parseMessage(line: string): ParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, code: JSON_RPC.PARSE_ERROR, message: "parse error: not valid JSON" };
  }
  if (!isRequestShape(value)) {
    return { ok: false, code: JSON_RPC.INVALID_REQUEST, message: "invalid request: not a JSON-RPC 2.0 request object" };
  }
  return { ok: true, msg: value };
}

/** Serialize a response as a SINGLE line of JSON (no embedded newlines) + a trailing "\n" for the
 *  newline-delimited stdio framing. JSON.stringify never emits a raw newline, so one line is guaranteed. */
export function serialize(res: JsonRpcResponse): string {
  return `${JSON.stringify(res)}\n`;
}

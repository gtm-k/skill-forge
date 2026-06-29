// @skillforge/mcp-server/server — the transport-agnostic MCP dispatcher (JSON-RPC 2.0 method router).
//
// Hand-rolled MCP (no SDK). One createMcpServer(deps) serves BOTH transports (stdio bin + Streamable HTTP
// for Wave B) because it only knows about parsed JSON-RPC messages + the injected McpServerDeps. It owns:
//   • lifecycle: initialize (echo a supported protocolVersion, advertise tools+resources), and the
//     notifications/initialized notification (a message with no id gets NO reply, per JSON-RPC §4.1);
//   • tools/list + tools/call (the 3 SkillForge tools);
//   • resources/list + resources/read (skill reference files);
//   • a humble ping.
// Method-not-found → -32601; malformed params → -32602; an unexpected handler throw → -32603 (never a
// hung transport, never a silent drop).

import {
  JSON_RPC,
  error,
  isNotification,
  parseMessage,
  serialize,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.ts";
import { callTool, TOOL_DEFINITIONS } from "./tools.ts";
import { listResourcesResult, readResourceResult } from "./resources.ts";
import type { McpServerDeps } from "./deps.ts";

/** Protocol versions this server speaks. We echo the client's if we support it, else offer DEFAULT. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "skillforge-mcp";

export interface McpServer {
  /** Handle ONE parsed message. Resolves to a response, or null for a notification (no reply is sent). */
  handle(msg: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  /** Parse + handle one newline-delimited line. Resolves to the serialized response line (+"\n"), or null
   *  when the message was a notification (nothing to write back). A parse/shape failure becomes a typed
   *  error reply with a null id (the id cannot be known for a message we could not parse). */
  handleLine(line: string): Promise<string | null>;
}

function pickProtocolVersion(params: unknown): string {
  const requested = typeof params === "object" && params !== null ? (params as { protocolVersion?: unknown }).protocolVersion : undefined;
  if (typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested; // echo the client's version when we support it
  }
  return DEFAULT_PROTOCOL_VERSION;
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  async function dispatch(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = msg.id ?? null;

    // Notifications (no id) get NO reply. We still process the ones we care about (initialized is a no-op).
    if (isNotification(msg)) return null;

    switch (msg.method) {
      case "initialize":
        return success(id, {
          protocolVersion: pickProtocolVersion(msg.params),
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: SERVER_NAME, version: deps.version },
        });

      case "ping":
        return success(id, {});

      case "tools/list":
        return success(id, { tools: TOOL_DEFINITIONS });

      case "tools/call": {
        const params = typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
        const name = params.name;
        if (typeof name !== "string" || name === "") {
          return error(id, JSON_RPC.INVALID_PARAMS, "tools/call requires a string `name`");
        }
        const result = await callTool(deps, name, params.arguments);
        if (result === undefined) {
          return error(id, JSON_RPC.INVALID_PARAMS, `unknown tool: ${JSON.stringify(name)}`);
        }
        return success(id, result);
      }

      case "resources/list":
        return success(id, await listResourcesResult(deps));

      case "resources/read": {
        const params = typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
        const uri = params.uri;
        if (typeof uri !== "string" || uri === "") {
          return error(id, JSON_RPC.INVALID_PARAMS, "resources/read requires a string `uri`");
        }
        const read = await readResourceResult(deps, uri);
        return read.ok ? success(id, read.body) : error(id, read.code, read.message);
      }

      default:
        return error(id, JSON_RPC.METHOD_NOT_FOUND, `method not found: ${msg.method}`);
    }
  }

  async function handle(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    try {
      return await dispatch(msg);
    } catch (e) {
      // An unexpected handler throw is an INTERNAL error reply — never a hung transport / silent drop.
      if (isNotification(msg)) return null; // a notification still gets no reply, even on a throw
      return error(msg.id ?? null, JSON_RPC.INTERNAL_ERROR, `internal error: ${(e as Error).message}`);
    }
  }

  async function handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (trimmed === "") return null; // blank keep-alive line — ignore
    const parsed = parseMessage(trimmed);
    if (!parsed.ok) {
      // We could not determine an id → reply with a null id (JSON-RPC 2.0 §5).
      return serialize(error(null, parsed.code, parsed.message));
    }
    const res = await handle(parsed.msg);
    return res === null ? null : serialize(res);
  }

  return { handle, handleLine };
}

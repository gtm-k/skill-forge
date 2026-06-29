// @skillforge/mcp-server — MCP (Model Context Protocol) adapter exposing the sourced-skill corpus to MCP
// hosts (Claude Desktop / Cursor / LM Studio-as-host). Hand-rolled JSON-RPC 2.0 over node: builtins only
// (ZERO third-party deps). Execution flows EXCLUSIVELY through @skillforge/core.run() (the audited spawn
// chokepoint) — this package never imports node:child_process.
//
// Public surface:
//   • createMcpServer(deps)        — the transport-agnostic dispatcher (initialize/tools/resources).
//   • createMcpHttpHandler(deps)   — Streamable-HTTP route(s) for Wave B to mount into the daemon.
//   • createReadModelDeps(home)    — the daemon-DOWN read-model-backed McpServerDeps (used by the bin).
//   • runStdioServer(deps)         — the newline-delimited stdio transport loop.
//   • skillforgeHome(override?)    — home resolution ($SKILLFORGE_HOME → ~/.skillforge), daemon parity.

/** The version reported in initialize → serverInfo.version (kept in sync with package.json). */
export const SERVER_VERSION = "2.0.0-alpha.0";

export { createMcpServer, SERVER_NAME, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION } from "./server.ts";
export type { McpServer } from "./server.ts";
export { createMcpHttpHandler } from "./http.ts";
export type { RouteDef, ReqCtx, JsonResponse, RouteHandler, McpHttpOptions } from "./http.ts";
export { runStdioServer } from "./stdio.ts";
export type { StdioOptions, StdioHandle } from "./stdio.ts";
export { createReadModelDeps, skillforgeHome } from "./catalog.ts";
export { TOOL_DEFINITIONS, TOOL_NAMES, callTool } from "./tools.ts";
export type { ToolDefinition, ToolName, ToolCallResult } from "./tools.ts";

export type {
  McpServerDeps,
  McpMenuItem,
  McpSkillDetail,
  McpRunOutcome,
  McpRefusalReason,
  McpResource,
  McpResourceContents,
  McpResourceOutcome,
} from "./deps.ts";

export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  JsonRpcError,
  JsonRpcId,
} from "./protocol.ts";

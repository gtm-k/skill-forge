// @skillforge/proxy — the OpenAI-compatible proxy adapter (the universal-fallback, THIRD inject-based parity
// path). Injects the right skill as an EPHEMERAL system message in front of any OpenAI-compat upstream
// (Ollama / llama.cpp / vLLM / LM Studio), forwarding the mutated request and passing the response through
// (streaming-transparent). Deps: @skillforge/core + @skillforge/contracts ONLY (zero third-party deps).
//
// Wave B mounts this into the daemon via `proxyRoutes(deps)` (or the per-route `createProxyHandler(deps)`),
// passing the daemon's live `home` + `config` getter. The standalone server (bin.ts/server.ts) backs the
// same handlers off a config.json snapshot.

// ── handler factory + daemon-mountable routes ──
export {
  createProxyHandler,
  proxyRoutes,
  DEFAULT_MAX_BODY_BYTES,
  type ProxyDeps,
  type ProxyHandlers,
} from "./handler.ts";

// ── selection (pool → cascade → injection content) ──
export {
  selectForProxy,
  lastUserMessage,
  type ProxyChatMsg,
  type ProxySelectInput,
  type ProxySelectResult,
} from "./select.ts";

// ── system-ephemeral placement ──
export { placeSystemEphemeral, ephemeralSystemMessage } from "./inject.ts";

// ── outbound forward + passthrough ──
export {
  forwardToUpstream,
  resolveChatUrl,
  UpstreamUnreachable,
  UpstreamTimeout,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  type ChatFetch,
  type ForwardOptions,
} from "./forward.ts";

// ── standalone server ──
export { startProxyServer, type ProxyServer } from "./server.ts";

// ── config / home (replicated read-model accessors) ──
export {
  skillforgeHome,
  loadConfig,
  normalizeConfig,
  defaultConfig,
  configPath,
  resolveProxyPort,
  CONFIG_FILE_NAME,
  DEFAULT_PROXY_PORT,
  PROXY_PORT_ENV,
} from "./config.ts";

// ── never-silent routing log ──
export { appendSelectLog, SELECT_LOG_FILE, type SelectLogLine } from "./select-log.ts";

// ── daemon-mountable HTTP contract — the SHARED shapes from @skillforge/contracts/http-route (Wave C / D3),
//    re-exported here via http-types.ts; the same nominal types the daemon uses, no longer a structural copy ──
export type { JsonResponse, ReqCtx, RouteDef, RouteHandler } from "./http-types.ts";

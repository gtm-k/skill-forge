// @skillforge/proxy/config — the proxy's view of home + config.json (Wave C / D3).
//
// The proxy is a pure READER of the same home tree the daemon/CLI write (manifest.json + sources/ +
// config.json). Home resolution and the config READ side (defaultConfig/normalizeConfig/loadConfig) are now
// shared in @skillforge/core (no longer a replicated mirror of the daemon's); they are imported + re-exported
// below so the proxy's `from "./config.ts"` import sites (and proxy/index.ts re-exports) are unchanged.
//
// The proxy needs exactly two things from config: the INDEPENDENTLY-configured embeddings provider (Tier-2
// query embedding + the /v1/embeddings passthrough target — M-embed) and upstreams.proxy.chatBaseUrl (where
// /v1/chat/completions is forwarded). `config.port` is the DAEMON's control port; the standalone proxy binds
// its OWN listen port (SKILLFORGE_PROXY_PORT) so it never collides with a running daemon.
import { skillforgeHome, configPath, defaultConfig, normalizeConfig, loadConfig, CONFIG_FILE_NAME } from "@skillforge/core";

// Re-export the shared home + config read side so proxy/index.ts (and other proxy modules) keep importing
// these from "./config.ts".
export { skillforgeHome, configPath, defaultConfig, normalizeConfig, loadConfig, CONFIG_FILE_NAME };

/** The standalone proxy's default LISTEN port (one above the daemon's, env-overridable). */
export const DEFAULT_PROXY_PORT = 4320;
/** Env var that overrides the standalone proxy's listen port. */
export const PROXY_PORT_ENV = "SKILLFORGE_PROXY_PORT";

/** Resolve the standalone proxy's listen port: $SKILLFORGE_PROXY_PORT (when a finite int) → DEFAULT_PROXY_PORT. */
export function resolveProxyPort(): number {
  const raw = process.env[PROXY_PORT_ENV];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return DEFAULT_PROXY_PORT;
}

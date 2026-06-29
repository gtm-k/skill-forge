#!/usr/bin/env -S node --experimental-strip-types
// @skillforge/proxy/bin — the standalone OpenAI-compat proxy entry point.
//
// Run under `--experimental-strip-types` (native TS, no build, no deps). It resolves the SkillForge home and
// loads the daemon's config.json (read-only — the proxy never writes the read-model), then serves the
// OpenAI-compat surface on 127.0.0.1. The listen port is $SKILLFORGE_PROXY_PORT (default 4320) so it never
// collides with a running daemon. SIGINT/SIGTERM tear the server down cleanly.
//
// Config is loaded ONCE at start (a getter closes over it). Restart the proxy to pick up a config change —
// or, in Wave B, mount proxyRoutes() into the daemon to share its live config.
import { createProxyHandler } from "./handler.ts";
import { startProxyServer } from "./server.ts";
import { skillforgeHome, loadConfig, resolveProxyPort } from "./config.ts";

const home = skillforgeHome();
const config = loadConfig(home);
const port = resolveProxyPort();

const handlers = createProxyHandler({ home, config: () => config });
const server = await startProxyServer(handlers, port);

// stdout is the only place an operator sees the bound URL + the wiring — never silent (actor-observability).
console.log(`[skillforge-proxy] listening at ${server.url}`);
console.log(`[skillforge-proxy] OpenAI-compat: POST ${server.url}/v1/chat/completions  |  POST ${server.url}/v1/embeddings`);
console.log(`[skillforge-proxy] home=${home}`);
const chatUpstream = config.upstreams?.proxy?.chatBaseUrl;
console.log(
  chatUpstream
    ? `[skillforge-proxy] chat upstream → ${chatUpstream}`
    : `[skillforge-proxy] WARNING: no chat upstream configured (config.upstreams.proxy.chatBaseUrl) — /v1/chat/completions returns 502 until set`,
);
console.log(
  config.embeddings
    ? `[skillforge-proxy] embeddings provider → ${config.embeddings.baseUrl} (Tier-2 semantic ON)`
    : `[skillforge-proxy] embeddings provider not configured — Tier-2 semantic DISABLED (routes on Tier 0/1; X-Skill-Tier2: disabled)`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[skillforge-proxy] ${signal} — shutting down`);
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

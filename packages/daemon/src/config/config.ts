// @skillforge/daemon/config — config.json write side + PATCH semantics (DaemonConfig, §5, M-embed).
//
// The READ side (defaults + tolerant coerce/load) is shared with the proxy and now lives ONCE in
// @skillforge/core/config (Wave C / D3); it is re-exported below so the daemon's `from "./config.ts"` import
// sites are unchanged. The WRITE side stays HERE — only the daemon mutates config.json: saveConfig (atomic
// publish) and applyPatch (the deep-merge that enforces M-embed's "a missing key never disables Tier-2").
// All disk IO reuses core's Windows-safe atomic write + tolerant read.
import { atomicWriteFile } from "@skillforge/core";
import {
  CONFIG_FILE_NAME,
  DEFAULT_PORT,
  DEFAULT_LMSTUDIO_BASE_URL,
  configPath,
  defaultConfig,
  normalizeConfig,
  loadConfig,
} from "@skillforge/core";
import type { DaemonConfig, PatchConfigRequest } from "@skillforge/contracts/api";

// Re-export the shared read side so daemon-internal consumers keep importing from "./config.ts".
export { CONFIG_FILE_NAME, DEFAULT_PORT, DEFAULT_LMSTUDIO_BASE_URL, configPath, defaultConfig, normalizeConfig, loadConfig };

/** Atomically publish the config (pretty-printed, trailing newline) — temp → fsync → atomic rename. */
export function saveConfig(home: string, cfg: DaemonConfig): void {
  atomicWriteFile(configPath(home), `${JSON.stringify(cfg, null, 2)}\n`);
}

/**
 * Apply a deep-partial PATCH to `current`, returning a NEW config (never mutates the input). MERGE
 * semantics (api.ts PatchConfigRequest):
 *  - scalars (port, lmStudioBaseUrl): replace iff present.
 *  - embeddings: `null` ⇒ EXPLICIT clear (disable Tier-2); `undefined` (omitted) ⇒ preserve as-is; an
 *    object ⇒ replace. This is the one place M-embed's "a missing key never disables Tier-2" is enforced.
 *  - upstreams / defaults.enabledFor / trustLevels: shallow-MERGE per key (omitting a key preserves it).
 */
export function applyPatch(current: DaemonConfig, patch: PatchConfigRequest): DaemonConfig {
  const next: DaemonConfig = structuredClone(current);

  if (patch.port !== undefined) next.port = patch.port;
  if (patch.lmStudioBaseUrl !== undefined) next.lmStudioBaseUrl = patch.lmStudioBaseUrl;

  if (patch.embeddings === null) {
    delete next.embeddings; // explicit disable — the ONLY way Tier-2 turns off
  } else if (patch.embeddings !== undefined) {
    next.embeddings = patch.embeddings;
  } // omitted → preserve (M-embed)

  if (patch.upstreams !== undefined) {
    next.upstreams = { ...(next.upstreams ?? {}), ...patch.upstreams };
  }
  if (patch.defaults !== undefined) {
    next.defaults = { enabledFor: { ...(next.defaults?.enabledFor ?? {}), ...(patch.defaults.enabledFor ?? {}) } };
  }
  if (patch.trustLevels !== undefined) {
    next.trustLevels = { ...(next.trustLevels ?? {}), ...patch.trustLevels };
  }
  return next;
}

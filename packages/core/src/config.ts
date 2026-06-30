// @skillforge/core/config — the SINGLE SOURCE OF TRUTH for the READ side of config.json (Wave C / D3):
// defaults + the tolerant coerce/load used identically by the daemon and the proxy. Before Wave C the daemon
// (daemon/config/config.ts) and the proxy (proxy/config.ts) carried byte-identical defaultConfig/
// normalizeConfig/loadConfig — the proxy's comment even said "Mirrors the daemon's normalizeConfig". Promoted
// here so both consume one implementation. The WRITE side (saveConfig / applyPatch — atomic write + PATCH
// merge semantics) stays in the daemon: only the daemon mutates config.json.
//
// normalizeConfig carries optional sections (embeddings/upstreams/defaults/trustLevels) through ONLY when
// present, so a never-configured Tier-2 stays ABSENT (the VISIBLE-degradation signal downstream) rather than
// reading as a zeroed-out "configured" provider — M-embed's hard rule, now enforced in one place.
import path from "node:path";
import { readJsonTolerant } from "./safe/io.ts";
import { SCHEMA_VERSION } from "@skillforge/contracts";
import type { DaemonConfig } from "@skillforge/contracts/api";

/** Relative name of the daemon settings file under home (the same file the daemon writes + the proxy reads). */
export const CONFIG_FILE_NAME = "config.json";
/** The control-API port the daemon binds when config.json does not pin one (tests pass 0 → ephemeral). */
export const DEFAULT_PORT = 4319;
/** LM Studio's default OpenAI-compatible control/embeddings host. */
export const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234";

/** Absolute path of the settings file under `home`. */
export function configPath(home: string): string {
  return path.join(home, CONFIG_FILE_NAME);
}

/** The baseline config a config-less install reads as (Tier-2 OFF until a provider is configured — M-embed). */
export function defaultConfig(): DaemonConfig {
  return { schemaVersion: SCHEMA_VERSION, port: DEFAULT_PORT, lmStudioBaseUrl: DEFAULT_LMSTUDIO_BASE_URL };
}

/**
 * Coerce a possibly-partial / untrusted on-disk record into a well-formed DaemonConfig, filling defaults for
 * the two required scalars and pinning schemaVersion. Optional sections are carried through only when present
 * (never a zeroed-out provider that reads as "configured").
 */
export function normalizeConfig(raw: Partial<DaemonConfig> | undefined): DaemonConfig {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const cfg: DaemonConfig = {
    schemaVersion: SCHEMA_VERSION,
    port: typeof raw.port === "number" && Number.isFinite(raw.port) ? raw.port : base.port,
    lmStudioBaseUrl:
      typeof raw.lmStudioBaseUrl === "string" && raw.lmStudioBaseUrl ? raw.lmStudioBaseUrl : base.lmStudioBaseUrl,
  };
  if (raw.embeddings) cfg.embeddings = raw.embeddings;
  if (raw.upstreams) cfg.upstreams = raw.upstreams;
  if (raw.defaults) cfg.defaults = raw.defaults;
  if (raw.trustLevels) cfg.trustLevels = raw.trustLevels;
  return cfg;
}

/** Tolerant load: a missing / empty / corrupt config.json falls back to defaults (never throws). */
export function loadConfig(home: string): DaemonConfig {
  return normalizeConfig(readJsonTolerant<Partial<DaemonConfig>>(configPath(home)));
}

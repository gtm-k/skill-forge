// @skillforge/core/home — the SINGLE SOURCE OF TRUTH for SkillForge home resolution + the on-disk layout
// names (Wave C / D3). Before Wave C the resolution precedence (override → $SKILLFORGE_HOME → ~/.skillforge)
// and the layout constants were declared in cli/home.ts, daemon/home.ts, proxy/config.ts AND mcp-server/
// catalog.ts — four byte-identical copies kept in sync by a comment ("REPLICATED; an adapter must not import
// a sibling adapter"). core is NOT a sibling adapter — it is the shared base all four already depend on — so
// promoting the resolution here removes the drift surface without any §2 import-direction violation. The
// daemon/cli home modules now RE-EXPORT these; the adapters import them.
//
// HOME is INJECTABLE everywhere (every accessor takes an explicit `home`, and skillforgeHome takes an optional
// override) so tests run against a throwaway temp dir and never touch the real ~/.skillforge.
import os from "node:os";
import path from "node:path";

/** Relative name of the materialized-trees dir, also written verbatim as ManifestReadModel.sourcesDir. */
export const SOURCES_DIR_NAME = "sources";
/** Relative name of the native-dep-free read-model file the plugin + UI consume. */
export const MANIFEST_FILE_NAME = "manifest.json";
/** Relative name of the SQLite source-of-truth DB (WAL). Daemon = the ONLY writer (D9/D25). */
export const DB_FILE_NAME = "skillforge.db";
/** Relative name of the cross-process writer-lock pidfile (§5, stale-pid recovery). */
export const WRITER_PID_FILE_NAME = "writer.pid";
/** Relative name of the append-only exec audit log (§7) — the Activity surface's source of truth. */
export const EXEC_LOG_FILE = "exec.log.jsonl";
/** The nomic-embed model the CLI ingest computes vectors with (A0-A); re-stamped on the read-model. */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

/** Resolve the SkillForge home dir. override → $SKILLFORGE_HOME → <homedir>/.skillforge. */
export function skillforgeHome(override?: string): string {
  return override ?? process.env.SKILLFORGE_HOME ?? path.join(os.homedir(), ".skillforge");
}

/** Absolute path of the materialized-trees dir under `home`. */
export function sourcesPath(home: string): string {
  return path.join(home, SOURCES_DIR_NAME);
}

/** Absolute path of the read-model file under `home`. */
export function manifestPath(home: string): string {
  return path.join(home, MANIFEST_FILE_NAME);
}

/** Absolute path of the SQLite DB under `home`. */
export function dbPath(home: string): string {
  return path.join(home, DB_FILE_NAME);
}

/** Absolute path of the writer-lock pidfile under `home`. */
export function writerPidPath(home: string): string {
  return path.join(home, WRITER_PID_FILE_NAME);
}

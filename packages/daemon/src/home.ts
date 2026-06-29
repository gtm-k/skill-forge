// @skillforge/daemon/home — re-export of the shared home resolution + on-disk layout (Wave C / D3).
//
// Resolution precedence (override → $SKILLFORGE_HOME → <os.homedir>/.skillforge) and the layout names now
// live ONCE in @skillforge/core/home (shared with the CLI + adapters instead of replicated); this module
// re-exports them so the daemon's `from "./home.ts"` / `from "../../home.ts"` import sites are unchanged. The
// daemon owns the two paths the CLI never touches — skillforge.db (the SQLite source of truth, daemon-only
// writer) and writer.pid (the OS writer lock) — which are part of the shared layout module too.
export {
  skillforgeHome,
  sourcesPath,
  manifestPath,
  dbPath,
  writerPidPath,
  SOURCES_DIR_NAME,
  MANIFEST_FILE_NAME,
  DB_FILE_NAME,
  WRITER_PID_FILE_NAME,
  DEFAULT_EMBEDDING_MODEL,
} from "@skillforge/core";

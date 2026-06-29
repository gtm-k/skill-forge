// @skillforge/daemon/store/schema — the §5 SQLite schema (DDL only).
//
// node:sqlite DatabaseSync, opened WAL by the store (D25): the daemon is the SOLE writer (D9). Every
// table here is rebuildable — the whole DB is re-derivable by re-walking sources/, and manifest.json is
// re-derivable from this DB (§5). `executions` + `injections` are created now but populated by a LATER
// wave (the exec chokepoint + injection logging); they sit unused-but-present so the schema is stable.
//
// One ADDITIVE column beyond §5's literal `skills(...)` list: `bundle_json`. §5's skills row carries
// `capabilities_json`/`warnings_json` as JSON columns; ManifestSkillEntry ALSO requires the per-file
// `bundle[]` (the UI Scripts/capability inspect reads it — §9), so the daemon must persist it to
// reconstruct the read-model. It follows the exact same JSON-column pattern. See newDecisions.
import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  ref_json     TEXT NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT NOT NULL,
  last_synced  TEXT,
  status       TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS skills (
  id                 TEXT PRIMARY KEY,
  source_id          TEXT NOT NULL,
  slug               TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  rel_path           TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  capabilities_json  TEXT NOT NULL,
  warnings_json      TEXT NOT NULL,
  bundle_json        TEXT NOT NULL DEFAULT '[]',
  token_estimate     INTEGER NOT NULL DEFAULT 0,
  body_len           INTEGER NOT NULL DEFAULT 0,
  license            TEXT,
  version            TEXT,
  is_placeholder     INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skills_source_idx ON skills (source_id);

CREATE TABLE IF NOT EXISTS skill_enable (
  skill_id  TEXT NOT NULL,
  target    TEXT NOT NULL,
  enabled   INTEGER NOT NULL,
  PRIMARY KEY (skill_id, target)
);

CREATE TABLE IF NOT EXISTS skill_exec_grant (
  skill_id      TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  exec_allowed  INTEGER NOT NULL,
  granted_at    TEXT NOT NULL
);

-- Owner MCP RUN-MUTE (C4): a human-set, per-skill pause of MCP script runs. A row PRESENT with muted=1 means
-- run_skill_script is refused on the mcp target (load/list unaffected). Un-muting DELETES the row. NOT
-- hash-bound (owner intent, not content), so it survives a resync. Additive (IF NOT EXISTS); SCHEMA_VERSION
-- stays 1 (D7) -- the manifest field is OPTIONAL/omitted-when-false.
CREATE TABLE IF NOT EXISTS skill_mcp_mute (
  skill_id    TEXT PRIMARY KEY,
  muted       INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  skill_id      TEXT NOT NULL,
  model         TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  vec           BLOB NOT NULL,
  content_hash  TEXT NOT NULL,
  PRIMARY KEY (skill_id, model)
);

CREATE TABLE IF NOT EXISTS executions (
  id                       INTEGER PRIMARY KEY,
  ts                       TEXT NOT NULL,
  skill_id                 TEXT,
  target                   TEXT,
  triggering_message_hash  TEXT,
  argv_json                TEXT,
  cwd                      TEXT,
  env_allowlist_json       TEXT,
  exit                     INTEGER,
  duration_ms              INTEGER,
  stdout_tail              TEXT,
  stderr_tail              TEXT,
  content_hash             TEXT,
  selection_reasons_json   TEXT
);

CREATE TABLE IF NOT EXISTS injections (
  id               INTEGER PRIMARY KEY,
  ts               TEXT NOT NULL,
  skill_id         TEXT,
  conversation_id  TEXT,
  target           TEXT,
  injected_bytes   INTEGER,
  injected_chars   INTEGER,
  token_cost       INTEGER,
  disclosure       TEXT,
  sticky           INTEGER
);

CREATE TABLE IF NOT EXISTS read_model_revision (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  seq          INTEGER NOT NULL,
  db_revision  INTEGER NOT NULL,
  written_at   TEXT NOT NULL
);
`;

/** Apply the full schema (idempotent — every statement is `IF NOT EXISTS`). */
export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}

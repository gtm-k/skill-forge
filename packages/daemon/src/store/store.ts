// @skillforge/daemon/store/store — the SkillStore (PLAN §3) over node:sqlite (D25, WAL).
//
// The daemon is the SOLE writer of skillforge.db (§5/D9). EVERY mutating op (upsert/setEnabled/
// setExecAllowed/remove) bumps BOTH `seq` (the monotonic read-model authority — M-cqrs/D19) AND
// `db_revision` (the DB-write correlator that lets a reader detect a crash BETWEEN the DB write and the
// manifest rewrite). `revision()` returns `seq`. Reads (list/get) reconstruct a full ManifestSkillEntry
// = SkillRecord, so derive can simply wrap list() with manifest metadata.
//
// node:sqlite param binding accepts number/string/bigint/null/Uint8Array — NOT JS booleans or
// `undefined`, so every boolean is coerced to 0/1 and every optional to `null` at the bind edge.
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "@skillforge/core";
import {
  type BundleEntry,
  type ManifestSkillEntry,
  type SkillCapabilities,
  type SkillManifest,
  type TargetId,
  type ValidationIssue,
} from "@skillforge/contracts";
import type { SkillFilter, SkillRecord, SourceRecord } from "@skillforge/contracts/api";
import { applySchema } from "./schema.ts";
import { DEFAULT_EMBEDDING_MODEL } from "../home.ts";

/** The three inject/host targets (§3). New skills are seeded enabled for all three (the magic moment). */
export const TARGETS: TargetId[] = ["lmstudio", "mcp", "proxy"];
const DEFAULT_ENABLED: Record<TargetId, boolean> = { lmstudio: true, mcp: true, proxy: true };

/**
 * Thrown by setExecAllowed when a grant cannot be bound to the skill's CURRENT on-disk content (D10):
 * the skill is absent, or its content_hash no longer matches the hash the caller reviewed. `currentHash`
 * (when present) lets the server map this to the 409 ExecGrantError envelope (api.ts). Refusing here is
 * what stops a grant being PRE-SEEDED for unreviewed future content that would silently activate on a
 * later upsert.
 */
export class ExecGrantError extends Error {
  readonly currentHash?: string;
  constructor(message: string, currentHash?: string) {
    super(message);
    this.name = "ExecGrantError";
    this.currentHash = currentHash;
  }
}

/** Thrown when PERSISTED JSON the daemon itself wrote (e.g. sources.ref_json) fails to parse: that is DB
 *  corruption, surfaced loudly rather than published as lossy data (actor-observability, §5). */
export class StoreCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreCorruptionError";
  }
}

export interface UpsertOptions {
  /** model name to tag any vectors stored this call (defaults to the nomic-embed CLI default, A0-A). */
  embeddingModel?: string;
  /** per-target enable state stamped on FRESHLY-added skills (existing toggles are preserved). */
  defaultEnabledFor?: Partial<Record<TargetId, boolean>>;
}

/**
 * The POSIX `dir` a consumer resolves under home/<sourcesDir>/. EXACT replication of
 * cli/src/manifest.ts buildEntry: `<sourceId>/<sourceRelPath>`, or just `<sourceId>` when the skill sits
 * at the source root (sourceRelPath === "."). Reproduced — never imported — per §2 (no adapter→adapter).
 * A drift here makes the plugin/UI silently miss the materialized tree (a "file not found" with no error).
 */
export function composeDir(sourceId: string, sourceRelPath: string): string {
  return sourceRelPath === "." ? sourceId : `${sourceId}/${sourceRelPath}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** The contract's documented derivation (schema.ts ManifestSkillEntry.qualityScore):
 *  clamp(100 − 40·isPlaceholder − 25·(error warnings) − 10·(warn warnings), 0, 100). */
export function qualityScore(isPlaceholder: boolean, warnings: ValidationIssue[]): number {
  const errs = warnings.filter((w) => w.level === "error").length;
  const warns = warnings.filter((w) => w.level === "warn").length;
  return clamp(100 - 40 * (isPlaceholder ? 1 : 0) - 25 * errs - 10 * warns, 0, 100);
}

/** Fingerprint a manifest's skill set with the SAME algorithm as store.skillFingerprint, so staleness
 *  can compare a published read-model against the DB it claims to derive from. */
export function manifestSkillFingerprint(skills: { id: string; contentHash: string }[]): string {
  const lines = [...skills]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => `${s.id}\0${s.contentHash}`);
  return sha256(lines.join("\n"));
}

// embeddings are stored as a little-endian Float64 BLOB; dim gives the element count.
function encodeVec(vec: number[]): Uint8Array {
  const f = new Float64Array(vec);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}
function decodeVec(buf: Uint8Array, dim: number): number[] {
  // Defensive COPY into a fresh, 8-byte-aligned ArrayBuffer (offset 0, exact length): a future
  // node:sqlite BLOB return that is not 8-aligned or is a subarray view would otherwise make the
  // Float64Array constructor throw and take down all of list()/derive. We then read floor(len/8) floats.
  const copy = Uint8Array.prototype.slice.call(buf);
  const usable = Math.floor(copy.byteLength / 8);
  const f = new Float64Array(copy.buffer, 0, usable);
  const out: number[] = [];
  for (let i = 0; i < dim && i < usable; i++) out.push(f[i] as number);
  return out;
}

type SkillRow = {
  id: string;
  source_id: string;
  slug: string;
  name: string;
  description: string;
  rel_path: string;
  content_hash: string;
  capabilities_json: string;
  warnings_json: string;
  bundle_json: string;
  token_estimate: number;
  body_len: number;
  license: string | null;
  version: string | null;
  is_placeholder: number;
  updated_at: string;
};

/** Raw `sources` row (the daemon's source list/resync read behind the store interface, W1b layering). */
export type SourceRow = {
  id: string;
  kind: string;
  /** the daemon-written JSON.stringify(SourceRecord) — parsed by the caller. */
  ref_json: string;
  added_at: string;
  last_synced: string | null;
  status: string;
};

export class SqliteSkillStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ── revision bookkeeping (M-cqrs/D19) ────────────────────────────────────────────────────────────
  /** The monotonic read-model authority. Stamped into manifest.seq; compared for staleness. */
  revision(): number {
    const r = this.db.prepare("SELECT seq FROM read_model_revision WHERE id = 1").get() as { seq: number };
    return r.seq;
  }
  /** The DB-write counter the current manifest is correlated against (crash-between-writes detector). */
  dbRevision(): number {
    const r = this.db.prepare("SELECT db_revision FROM read_model_revision WHERE id = 1").get() as { db_revision: number };
    return r.db_revision;
  }
  /**
   * Raise `seq` to at least `floor` WITHOUT bumping db_revision (this is a continuity reconciliation,
   * not a read-model write). The SEQ-HANDOFF INVARIANT (api.ts): a freshly-built DB whose seq starts at
   * 0 must never write a manifest seq BELOW the CLI's last manifest, so the daemon seeds the floor from
   * the existing manifest BEFORE any mutation. Idempotent + monotonic.
   */
  seedSeqFloor(floor: number): void {
    // Reject a non-positive, non-finite, or ABSURD floor: an untrusted manifest with seq=1e21 would
    // otherwise permanently poison the monotonic counter past 2^53 (where integer math breaks). A floor
    // beyond MAX_SAFE_INTEGER is treated as tampered and ignored rather than seeded.
    if (!Number.isFinite(floor) || floor <= 0 || floor > Number.MAX_SAFE_INTEGER) return;
    this.db
      .prepare("UPDATE read_model_revision SET seq = MAX(seq, ?), written_at = ? WHERE id = 1")
      .run(Math.floor(floor), new Date().toISOString());
  }
  private bump(): void {
    this.db
      .prepare("UPDATE read_model_revision SET seq = seq + 1, db_revision = db_revision + 1, written_at = ? WHERE id = 1")
      .run(new Date().toISOString());
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* the original error is the meaningful one */
      }
      throw e;
    }
  }

  // ── writes (SkillStore §3) ───────────────────────────────────────────────────────────────────────
  /**
   * Insert/replace `skills` for source `src` (one read-model write → ONE seq/db_revision bump for the
   * whole batch). New skills are seeded enabled for all targets (preserving any existing user toggle);
   * embeddings present on a manifest are stored keyed by contentHash. Mirrors cli buildEntry's invariants
   * (execAllowed stays gated behind the hash-bound grant; dir is composed at read time via composeDir).
   */
  upsert(skills: SkillManifest[], src: SourceRecord, opts: UpsertOptions = {}): void {
    const model = opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    const enableDefaults = { ...DEFAULT_ENABLED, ...(opts.defaultEnabledFor ?? {}) };
    const now = new Date().toISOString();

    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO sources (id, kind, ref_json, revision, added_at, last_synced, status)
           VALUES (?, ?, ?, COALESCE((SELECT revision + 1 FROM sources WHERE id = ?), 0), ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind, ref_json = excluded.ref_json, revision = excluded.revision,
             last_synced = excluded.last_synced, status = excluded.status`,
        )
        .run(
          src.sourceId,
          src.kind,
          JSON.stringify(src),
          src.sourceId,
          src.addedAt ?? now,
          src.lastSynced ?? null,
          src.status ?? "ok",
        );

      const insSkill = this.db.prepare(
        `INSERT INTO skills (id, source_id, slug, name, description, rel_path, content_hash,
            capabilities_json, warnings_json, bundle_json, token_estimate, body_len, license, version,
            is_placeholder, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_id = excluded.source_id, slug = excluded.slug, name = excluded.name,
           description = excluded.description, rel_path = excluded.rel_path,
           content_hash = excluded.content_hash, capabilities_json = excluded.capabilities_json,
           warnings_json = excluded.warnings_json, bundle_json = excluded.bundle_json,
           token_estimate = excluded.token_estimate, body_len = excluded.body_len,
           license = excluded.license, version = excluded.version,
           is_placeholder = excluded.is_placeholder, updated_at = excluded.updated_at`,
      );
      const seedEnable = this.db.prepare(
        "INSERT OR IGNORE INTO skill_enable (skill_id, target, enabled) VALUES (?, ?, ?)",
      );
      const upsertEmbedding = this.db.prepare(
        `INSERT INTO embeddings (skill_id, model, dim, vec, content_hash) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(skill_id, model) DO UPDATE SET
           dim = excluded.dim, vec = excluded.vec, content_hash = excluded.content_hash`,
      );

      for (const m of skills) {
        if (!m.id || !m.contentHash || !m.capabilities || m.sourceRelPath === undefined) {
          // normalizeTree always populates these; a gap is an upstream contract break — surface it
          // (never silently drop a skill — D14/never-silent).
          throw new Error(
            `incomplete normalized skill ${JSON.stringify(m.slug)}: missing id/contentHash/capabilities/sourceRelPath`,
          );
        }
        insSkill.run(
          m.id,
          src.sourceId,
          m.slug,
          m.name,
          m.description,
          m.sourceRelPath,
          m.contentHash,
          JSON.stringify(m.capabilities),
          JSON.stringify(m.warnings ?? []),
          JSON.stringify(m.bundle ?? []),
          m.tokenEstimate ?? 0,
          m.bodyLen ?? 0,
          m.license ?? null,
          m.version ?? null,
          m.raw?.isPlaceholder ? 1 : 0,
          now,
        );
        for (const t of TARGETS) seedEnable.run(m.id, t, enableDefaults[t] ? 1 : 0);
        if (Array.isArray(m.embedding) && m.embedding.length > 0) {
          upsertEmbedding.run(m.id, model, m.embedding.length, encodeVec(m.embedding), m.contentHash);
        }
      }
      this.bump();
    });
  }

  /** Per-target enable toggle (the 3-way matrix). Bumps the read-model revision. */
  setEnabled(id: string, target: TargetId, on: boolean): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO skill_enable (skill_id, target, enabled) VALUES (?, ?, ?)
           ON CONFLICT(skill_id, target) DO UPDATE SET enabled = excluded.enabled`,
        )
        .run(id, target, on ? 1 : 0);
      this.bump();
    });
  }

  /**
   * Record/clear the exec grant, BOUND to `contentHash` (D10). GRANTING (on=true) is verified IN THE
   * SAME TRANSACTION against the skill's CURRENT content_hash: if the skill is absent or its on-disk hash
   * no longer equals `contentHash`, we throw ExecGrantError and write nothing — this is what blocks a
   * grant being PRE-SEEDED for unreviewed future content that would silently activate on a later upsert.
   * REVOKING (on=false) is always permitted (you can always turn a grant off). The read-time hash-match
   * check in entryFromRow stays as a second line of defense (belt and suspenders). Bumps the revision.
   */
  setExecAllowed(id: string, contentHash: string, on: boolean): void {
    this.tx(() => {
      if (on) {
        const row = this.db.prepare("SELECT content_hash FROM skills WHERE id = ?").get(id) as
          | { content_hash: string }
          | undefined;
        if (!row) {
          throw new ExecGrantError(`cannot grant exec: no skill with id ${JSON.stringify(id)}`);
        }
        if (row.content_hash !== contentHash) {
          throw new ExecGrantError(
            `cannot grant exec: contentHash mismatch for ${JSON.stringify(id)} — the skill changed since review (re-review required)`,
            row.content_hash,
          );
        }
      }
      this.db
        .prepare(
          `INSERT INTO skill_exec_grant (skill_id, content_hash, exec_allowed, granted_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(skill_id) DO UPDATE SET
             content_hash = excluded.content_hash, exec_allowed = excluded.exec_allowed,
             granted_at = excluded.granted_at`,
        )
        .run(id, contentHash, on ? 1 : 0, new Date().toISOString());
      this.bump();
    });
  }

  /**
   * Record/clear the OWNER MCP RUN-MUTE (C4) for a skill. Mirrors setEnabled/setExecAllowed: `on=true`
   * UPSERTS a muted=1 row, `on=false` DELETES it (so an absent row == not-muted, the minimal additive
   * manifest). NOT hash-bound — it is owner intent, not content, so it persists across a resync. Bumps the
   * read-model revision (it IS read-model state — the run gate reads it on both paths via mcpRunMuted).
   */
  setMcpRunMuted(id: string, on: boolean): void {
    this.tx(() => {
      if (on) {
        this.db
          .prepare(
            `INSERT INTO skill_mcp_mute (skill_id, muted, updated_at) VALUES (?, 1, ?)
             ON CONFLICT(skill_id) DO UPDATE SET muted = 1, updated_at = excluded.updated_at`,
          )
          .run(id, new Date().toISOString());
      } else {
        this.db.prepare("DELETE FROM skill_mcp_mute WHERE skill_id = ?").run(id);
      }
      this.bump();
    });
  }

  /** Remove a skill and all its dependent rows (enable/grant/mute/embeddings). Bumps the read-model revision. */
  remove(id: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM skill_enable WHERE skill_id = ?").run(id);
      this.db.prepare("DELETE FROM skill_exec_grant WHERE skill_id = ?").run(id);
      this.db.prepare("DELETE FROM skill_mcp_mute WHERE skill_id = ?").run(id);
      this.db.prepare("DELETE FROM embeddings WHERE skill_id = ?").run(id);
      this.bump();
    });
  }

  // ── source-row reads/writes (W1b layering — keep the daemon's source SQL behind the store) ─────────
  /** The skill ids belonging to one source (for resync diffing + bulk removal). */
  skillIdsForSource(sourceId: string): string[] {
    return (this.db.prepare("SELECT id FROM skills WHERE source_id = ? ORDER BY id").all(sourceId) as { id: string }[]).map((r) => r.id);
  }

  /** Live count of skills backing one source. */
  countSkillsForSource(sourceId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM skills WHERE source_id = ?").get(sourceId) as { c: number }).c;
  }

  /** One source row (raw columns) by id, or undefined. `ref_json` is the daemon-written SourceRecord. */
  getSourceRow(sourceId: string): SourceRow | undefined {
    return this.db
      .prepare("SELECT id, kind, ref_json, added_at, last_synced, status FROM sources WHERE id = ?")
      .get(sourceId) as SourceRow | undefined;
  }

  /** All source rows (raw columns), oldest-first then by id (stable list order for the UI). */
  listSourceRows(): SourceRow[] {
    return this.db
      .prepare("SELECT id, kind, ref_json, added_at, last_synced, status FROM sources ORDER BY added_at, id")
      .all() as SourceRow[];
  }

  /** Delete a source row (call AFTER its skills are removed). Does NOT bump the read-model revision —
   *  the skill removals already did, and a source row carries no read-model state of its own. */
  deleteSourceRow(sourceId: string): void {
    this.db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
  }

  // ── reads (SkillStore §3) ────────────────────────────────────────────────────────────────────────
  /** One full SkillRecord (= ManifestSkillEntry) by id, or undefined. */
  get(id: string): SkillRecord | undefined {
    const row = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
    return row ? this.entryFromRow(row) : undefined;
  }

  /** All skills matching `filter` as full SkillRecords. */
  list(filter?: SkillFilter): SkillRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.enabledOnly && filter.target) {
      where.push("EXISTS (SELECT 1 FROM skill_enable e WHERE e.skill_id = skills.id AND e.target = ? AND e.enabled = 1)");
      params.push(filter.target);
    }
    if (filter?.q) {
      // Escape the LIKE metacharacters (% _ and the escape char itself) so a query containing them is
      // matched LITERALLY — not as wildcards. Correctness, not injection (the value is still bound).
      where.push(
        "(skills.name LIKE ? ESCAPE '\\' OR skills.description LIKE ? ESCAPE '\\' OR skills.slug LIKE ? ESCAPE '\\')",
      );
      const like = `%${filter.q.replace(/[\\%_]/g, "\\$&")}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT * FROM skills${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY slug`;
    const rows = this.db.prepare(sql).all(...params) as SkillRow[];
    return rows.map((r) => this.entryFromRow(r));
  }

  /** The model+dim of the stored vectors (for ManifestReadModel.embeddingModel/Dim), or undefined.
   *  DETERMINISTIC on a mixed-model corpus: the majority (model,dim), tie-broken by model name — never
   *  an arbitrary LIMIT-1 row. */
  embeddingMeta(): { model: string; dim: number } | undefined {
    const r = this.db
      .prepare(
        `SELECT model, dim FROM embeddings GROUP BY model, dim
         ORDER BY COUNT(*) DESC, model ASC, dim ASC LIMIT 1`,
      )
      .get() as { model: string; dim: number } | undefined;
    return r ? { model: r.model, dim: r.dim } : undefined;
  }

  /** Number of skills currently in the DB (cheap staleness input — does it back the manifest?). */
  skillCount(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM skills").get() as { c: number };
    return r.c;
  }

  /** A stable fingerprint of the skill set — sha256 over sorted `id\0contentHash` lines. Lets staleness
   *  verify that a manifest WITHOUT a dbRevision stamp (the CLI→daemon handoff) is actually backed by the
   *  current DB, rather than reporting "fresh" off a seq match alone (D19/M-cqrs). "" → empty corpus. */
  skillFingerprint(): string {
    const rows = this.db.prepare("SELECT id, content_hash FROM skills ORDER BY id").all() as {
      id: string;
      content_hash: string;
    }[];
    return sha256(rows.map((r) => `${r.id}\0${r.content_hash}`).join("\n"));
  }

  close(): void {
    this.db.close();
  }

  // ── row → ManifestSkillEntry (the ONE mapper; list/get/derive all share it) ───────────────────────
  private entryFromRow(row: SkillRow): ManifestSkillEntry {
    const capabilities = JSON.parse(row.capabilities_json) as SkillCapabilities;
    const warnings = JSON.parse(row.warnings_json) as ValidationIssue[];
    const bundle = JSON.parse(row.bundle_json) as BundleEntry[];
    const isPlaceholder = row.is_placeholder === 1;

    const enabledFor: Partial<Record<TargetId, boolean>> = {};
    const enRows = this.db
      .prepare("SELECT target, enabled FROM skill_enable WHERE skill_id = ?")
      .all(row.id) as { target: TargetId; enabled: number }[];
    for (const e of enRows) enabledFor[e.target] = e.enabled === 1;

    // exec grant is honored ONLY while its hash still matches the on-disk bytes (D10 structural revoke).
    const grant = this.db
      .prepare("SELECT content_hash, exec_allowed FROM skill_exec_grant WHERE skill_id = ?")
      .get(row.id) as { content_hash: string; exec_allowed: number } | undefined;
    const execAllowed = grant?.exec_allowed === 1 && grant.content_hash === row.content_hash;

    // OWNER MCP RUN-MUTE (C4): stamp mcpRunMuted=true ONLY when a muted row is present (omit when not muted →
    // the minimal additive manifest; absent reads as not-muted on every consumer). NOT hash-bound.
    const mute = this.db
      .prepare("SELECT muted FROM skill_mcp_mute WHERE skill_id = ?")
      .get(row.id) as { muted: number } | undefined;

    const provenance = this.provenanceFor(row.source_id);

    const entry: ManifestSkillEntry = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      dir: composeDir(row.source_id, row.rel_path),
      contentHash: row.content_hash,
      enabledFor,
      execAllowed,
      capabilities,
      bundle,
      warnings,
      bodyLen: row.body_len,
      tokenEstimate: row.token_estimate,
      provenance,
      isPlaceholder,
      qualityScore: qualityScore(isPlaceholder, warnings),
    };
    if (row.license !== null) entry.license = row.license;
    if (row.version !== null) entry.version = row.version;
    if (mute?.muted === 1) entry.mcpRunMuted = true; // omitted when not muted (minimal additive manifest)

    const emb = this.db
      .prepare("SELECT vec, dim FROM embeddings WHERE skill_id = ? LIMIT 1")
      .get(row.id) as { vec: Uint8Array; dim: number } | undefined;
    if (emb) entry.embedding = decodeVec(emb.vec, emb.dim);

    return entry;
  }

  private provenanceFor(sourceId: string): ManifestSkillEntry["provenance"] {
    const src = this.db.prepare("SELECT kind, ref_json FROM sources WHERE id = ?").get(sourceId) as
      | { kind: string; ref_json: string }
      | undefined;
    if (!src) return [];
    let rec: Partial<SourceRecord>;
    try {
      rec = JSON.parse(src.ref_json) as Partial<SourceRecord>;
    } catch (e) {
      // sources.ref_json is written by the daemon itself (JSON.stringify(src)); if it no longer parses,
      // that is DB CORRUPTION. Surface it loudly rather than publishing empty-input provenance that hides
      // the damage in the read-model (actor-observability, §5) — never a silent lossy downgrade.
      throw new StoreCorruptionError(
        `corrupt sources.ref_json for sourceId ${JSON.stringify(sourceId)}: ${(e as Error).message}`,
      );
    }
    const prov: ManifestSkillEntry["provenance"][number] = {
      sourceId,
      kind: src.kind as SourceRecord["kind"],
      input: rec.input ?? "",
    };
    if (rec.ref !== undefined) prov.ref = rec.ref;
    return [prov];
  }
}

/** Open (or create) the store at `dbPath`, WAL-mode, schema applied, revision row seeded at 0/0. */
export function openStore(dbPath: string): SqliteSkillStore {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  // DURABILITY over throughput for this integrity tier: synchronous=FULL fsyncs the WAL on each commit,
  // so a power loss cannot drop the last committed txn while the fsync'd manifest still claims it (which
  // would regress the DB BEHIND the read-model). NORMAL would leave that window open (D19 durability).
  db.exec("PRAGMA synchronous=FULL");
  // A second writer connection serializes on the busy lock instead of failing fast with SQLITE_BUSY
  // (belt-and-suspenders with the OS pidfile lock — only one writer should ever reach here).
  db.exec("PRAGMA busy_timeout=5000");
  applySchema(db);
  db.prepare("INSERT OR IGNORE INTO read_model_revision (id, seq, db_revision, written_at) VALUES (1, 0, 0, ?)").run(
    new Date().toISOString(),
  );
  return new SqliteSkillStore(db);
}

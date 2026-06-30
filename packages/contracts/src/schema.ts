// @skillforge/contracts — shared types + tuned constants.
// schemaVersion is additive-only; never break consumers (D7).

export const SCHEMA_VERSION = 1 as const;

export type TargetId = "lmstudio" | "mcp" | "proxy";
export type SelectionMode = "explicit" | "lexical" | "semantic" | "none";
export type InjectionChannel = "user-turn-rewrite" | "system-ephemeral" | "host-response";

/** A normalized skill. `instructions` is loaded lazily by id at inject time. */
export interface SkillManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  bodyLen: number;
  tokenEstimate: number;
  warnings: ValidationIssue[];
  /** populated by normalize from the raw frontmatter (folded scalars etc.) */
  raw?: { hadFoldedDescription?: boolean; isPlaceholder?: boolean };

  // ── ingest-time enrichment (populated by source/normalize-tree, optional at routing time) ──
  /** sha256(sourceId + sourceRelPath).slice(0,12) — stable identity across re-syncs */
  id?: string;
  /** sha256 of the canonicalized bundle — dedup + embed-cache key + the EXEC GRANT key (D10) */
  contentHash?: string;
  bundle?: BundleEntry[];
  /** humble inventory of what we NOTICED — never a "safe/verified" verdict (D14) */
  capabilities?: SkillCapabilities;
  sourceId?: string;
  sourceRelPath?: string;
  license?: string;
  version?: string;
  /** 768-dim nomic-embed vector computed at CLI ingest (A0-A); stored in the read-model */
  embedding?: number[];
}

// ── Bundle + capabilities (BOUNDARY 1 enrichment, populated at ingest) ──
export type BundleKind = "instructions" | "script" | "reference" | "asset";
export interface BundleEntry {
  relPath: string;
  kind: BundleKind;
  bytes: number;
  hash: string; // sha256 of file bytes
  lang?: string;
  shebang?: string;
  /** present for scripts: derived interpreter + statically-detected commands + a short preview */
  exec?: { interpreter: string; declaredCommands: string[]; preview: string };
}
export type CapabilityFlag = "network" | "pipe-to-shell" | "destructive" | "eval" | "install" | "fs-write";
export interface SkillCapabilities {
  scriptCount: number;
  interpreters: string[];
  commands: string[];
  flags: CapabilityFlag[];
}

// ── BOUNDARY 3: Injection (channel-AGNOSTIC content) — WHAT to inject, never WHERE (D15, R1-B1) ──
export type Disclosure = "menu" | "full" | "none";
export interface InjectionContent {
  text: string; // rendered block (menu | full | "")
  disclosure: Disclosure; // "none" is first-class (inject nothing)
  injectedSlugs: string[];
  tokenCost: number;
  injectedBytes: number; // MEASURED — drives the self-verifying hand-off (D11)
  sentinel?: string; // OPTIONAL, local-only echo probe (R1 M-ci)
}
export interface InjectionPolicy {
  /** per-target/per-model ceiling handed in at inject time (R1 MINOR); buildInjection counts a single shot */
  maxTokens: number;
  /** ambiguous selection -> show the menu rather than guess a sticky wrong skill (R1-B1) */
  menuOnAmbiguous: boolean;
  /** how the menu renders names + descriptions; full renders the primary SKILL.md body */
  maxMenuItems?: number;
}

// ── Sourcing (BOUNDARY into the funnel; §5) ──
export type SourceKind = "git" | "folder" | "registry" | "url";
export interface SourceRef {
  kind: SourceKind;
  input: string; // raw user input
  ref?: string; // git @ref
  subdir?: string; // git url//subdir
}
export interface FetchedTree {
  sourceId: string; // sha256(canonical SourceRef).slice(0,12)
  root: string; // absolute path to the materialized, read-only tree
  skillDirs: string[]; // dirs (relative to root) that contain a SKILL.md
  ref: SourceRef;
}

// ── Execution (the ONE spawn path; §7) ──
export interface ExecRequest {
  argv: string[];
  cwd: string;
  envAllowlist?: string[];
  dryRun?: boolean;
}
export interface ExecResult {
  exit: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  contentHash: string; // recomputed from bytes immediately before spawn (D20)
  /** STRUCTURED dry-run signal from the authoritative gate: true ONLY when the bundle hash matched and the
   *  caller asked us NOT to spawn (core/exec/run.ts dry-run branch). Absent/false on every spawned path and
   *  every refusal. Consumers MUST read this flag rather than sniff stderr — a real (side-effecting) run that
   *  dies from a signal and happens to print "dry-run" to stderr is NOT a dry-run (additive, optional). */
  dryRun?: boolean;
}
export interface ExecLogLine {
  ts: string;
  slug: string;
  target?: TargetId;
  triggeringMessageHash?: string;
  argv: string[];
  cwd: string;
  envAllowlist: string[];
  exit: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  contentHash: string;
  selectionReasons?: string[];
}

// ── manifest.json — the CLI-written, native-dep-free read-model the plugin + UI consume (§5) ──
// Phase 1: written by the CLI; `seq` is the CLI's last write. The daemon stamps seq/dbRevision in
// Phase 3 (D19); the seq-vs-daemon staleness check only applies in daemon-connected mode.
export interface ManifestSkillEntry {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** POSIX path RELATIVE TO sourcesDir, composed as `<sourceId>/<sourceRelPath>` (and just `<sourceId>`
   *  when sourceRelPath === "."). A consumer resolves home/<sourcesDir>/<dir> onto the skill dir. The
   *  daemon (W1) MUST reproduce this EXACT composition (see cli/src/manifest.ts buildEntry) or the
   *  plugin/UI silently miss the materialized tree — a "file not found" with no error. */
  dir: string;
  contentHash: string;
  enabledFor: Partial<Record<TargetId, boolean>>;
  execAllowed: boolean; // defaults false; grant bound to contentHash (D10)
  /** OWNER MCP RUN-MUTE (C4): a human-set, per-skill pause of MCP script runs. While true, run_skill_script
   *  is refused on the `mcp` target (fail-closed at the exec chokepoint, on BOTH the live-daemon /mcp path and
   *  the daemon-down stdio read-model path); load_skill / list_skills are UNAFFECTED (a muted skill stays
   *  visible + readable). Persisted (daemon-owned, D9); NOT hash-bound (it is owner intent, not content), so it
   *  survives a resync. OPTIONAL + omitted when false (minimal additive manifest); absent ⇒ not-muted. */
  mcpRunMuted?: boolean;
  capabilities: SkillCapabilities;
  /** the per-file bundle (scripts/references/assets) — the UI Scripts/capability inspect reads this (§9) */
  bundle: BundleEntry[];
  warnings: ValidationIssue[];
  bodyLen: number;
  tokenEstimate: number;
  provenance: { sourceId: string; kind: SourceKind; input: string; ref?: string }[];
  embedding?: number[]; // for the plugin's query-embed semantic re-rank (A0-A)
  // ── Inspect-panel enrichment (§9), all OPTIONAL/additive — populated by normalize/CLI/daemon ──
  license?: string;
  version?: string;
  /** the normalize-time placeholder flag (SkillManifest.raw.isPlaceholder) surfaced in the frontmatter panel */
  isPlaceholder?: boolean;
  /** 0–100 Inspect quality score (§9). Documented derivation: clamp(100 − 40·isPlaceholder
   *  − 25·(error-level warnings) − 10·(warn-level warnings), 0, 100). Optional; computed at normalize/ingest. */
  qualityScore?: number;
}
export interface ManifestReadModel {
  schemaVersion: typeof SCHEMA_VERSION;
  seq: number; // monotonic; bumped on every write that affects the read-model (D19)
  /** the DB write counter this manifest was derived from (D19). OPTIONAL: the CLI omits it (Phase 1);
   *  the daemon stamps it (Phase 2) so a reader can detect a crash-between-writes seq/dbRevision skew. */
  dbRevision?: number;
  generatedAt: string;
  sourcesDir: string; // relative location of the materialized trees
  embeddingModel?: string;
  embeddingDim?: number;
  skills: ManifestSkillEntry[];
}

export interface ValidationIssue {
  level: "error" | "warn";
  field?: string;
  msg: string;
}

export interface SkillMatch {
  slug: string;
  /** stable id = sha256(sourceId+sourceRelPath).slice(0,12). slug is NOT unique (two sources can share
   *  one; dedup is by contentHash), so the UI needs id to resolve a candidate/activity row → one skill.
   *  OPTIONAL for additive-safety: the Phase-1 embedded plugin path may omit it; the daemon populates it. */
  id?: string;
  score: number;
  tier: SelectionMode;
  reasons: string[];
}

export interface Selection {
  mode: SelectionMode;
  chosen?: SkillMatch;
  candidates: SkillMatch[];
  /** top-2 within epsilon -> surface both rather than guess */
  ambiguous: boolean;
  /** true when a tier RAN but nothing cleared its θ gate — distinct from mode:"none" on an empty pool.
   *  Makes the D17 "inject nothing because below threshold" signal first-class. OPTIONAL (additive); the
   *  selector (W3) populates it, the daemon forwards it on the `selection` SSE event. */
  belowThreshold?: boolean;
}

/**
 * Routing thresholds, calibrated on the Spike A0 golden set (positives + negatives).
 * Re-calibrated as the library grows (D17). Lexical scores are BM25 (unbounded);
 * semantic scores are cosine in [-1, 1].
 */
export const ROUTING = {
  lexicalFireThreshold: 4.0, // BM25 >= this to fire (A0: 1/15 false-fire, 23/30 fire)
  semanticFireThreshold: 0.6, // cosine >= this to fire (A0: 1/15 false-fire, 27/30 fire)
  ambiguityEpsilon: 0.04, // top1 - top2 below this on the firing tier => ambiguous
} as const;

export type GoldenSet = {
  positives: { q: string; skill: string }[];
  negatives: string[];
};

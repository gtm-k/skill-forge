// @skillforge/contracts/api — the Phase-2 daemon control surface (REST + SSE) + config + CQRS revision.
//
// ADDITIVE-ONLY, schemaVersion stays 1 (D7). These types are the synchronization barrier for Phase-2's
// parallel worktree waves: the daemon (W1), the full UI (W5), and the source resolvers (W2) are each
// built by a cold-context agent that sees ONLY PLAN.md + this file — never each other's code. A drifting
// request shape here is an integration defect git's merge cannot catch, so this surface is frozen before
// any wave fans out. Re-exported under the "@skillforge/contracts/api" subpath (schema.ts stays the "."
// entry so existing consumers are untouched).
import type {
  CapabilityFlag,
  Disclosure,
  ExecLogLine,
  ExecResult,
  InjectionContent,
  ManifestSkillEntry,
  Selection,
  SelectionMode,
  SkillCapabilities,
  SourceKind,
  SourceRef,
  TargetId,
  ValidationIssue,
} from "./schema.ts";
import { SCHEMA_VERSION } from "./schema.ts";

// ── Chat message (the proxy/plugin selection input; §3 SelectionContext) ──
export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── config.json (§5) — daemon port, endpoints, upstreams, defaults, trust levels ──
export interface UpstreamConfig {
  /** OpenAI-compatible CHAT base URL for this target (Ollama :11434 / llama.cpp :8080 / vLLM / LM Studio :1234) */
  chatBaseUrl?: string;
}
export interface EmbeddingsProvider {
  /** the nomic-embed /v1/embeddings provider — configured INDEPENDENTLY of any chat upstream (M-embed). */
  baseUrl: string;
  model: string;
  dim: number;
}
export interface DaemonConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  port: number;
  /** LM Studio control/embeddings host (127.0.0.1:1234 by default) */
  lmStudioBaseUrl: string;
  /** absent => Tier-2 semantic disabled with a VISIBLE notice (never a silent downgrade — M-embed) */
  embeddings?: EmbeddingsProvider;
  /** per-target chat upstreams for the proxy adapter */
  upstreams?: Partial<Record<TargetId, UpstreamConfig>>;
  /** default per-target enable state stamped on freshly-added skills */
  defaults?: { enabledFor?: Partial<Record<TargetId, boolean>> };
  /** per-source trust gating (§7) — lower trust runs behind confirm / dry-run */
  trustLevels?: Record<string, TrustLevel>;
}
export type TrustLevel = "trusted" | "confirm" | "dry-run";

// ── CQRS read-model revision (D19, M-cqrs) — drives the manifest seq/dbRevision stamp + staleness ──
// `seq` already lives on ManifestReadModel (schema.ts); `dbRevision` is added there as an OPTIONAL field
// (CLI omits it in Phase 1; the daemon stamps it in Phase 2). This record is the DB-side source of both.
//
// SEQ-HANDOFF INVARIANT (load-bearing — W1 MUST honor): the Phase-1 CLI bumps a MANIFEST-LOCAL seq
// (cli/src/manifest.ts: priorSeq+1) with no DB behind it. When the daemon first builds its DB by
// re-walking sources/, its DB seq starts at 0 and could write a seq BELOW the CLI's last manifest seq —
// regressing the monotonic counter the whole staleness/BM25-pool-freshness check depends on. So the
// daemon MUST seed its revision from `max(existingManifest.seq ?? 0, db.read_model_revision.seq ?? 0)`.
// Staleness is compared on `seq` (the single monotonic authority); `dbRevision` is the DB-write correlator
// that lets a reader detect a crash BETWEEN the DB write and the manifest rewrite.
export interface ReadModelRevision {
  seq: number; // monotonic authority; bumped on every DB write that affects the read-model
  dbRevision: number; // the DB write counter the current manifest was derived from
  writtenAt: string;
}

// ── Sourcing DTOs (§5, §9) — preview BEFORE commit, then add/list/remove/resync ──
/** capability + provenance preview shown before a source is committed ("here's what we noticed", D14). */
export interface SourcePreview {
  ref: SourceRef;
  skillCount: number;
  scriptCount: number;
  flaggedCount: number;
  flags: CapabilityFlag[]; // union across the skills this source would add (humble inventory, never a verdict)
  skills: { slug: string; name: string; description: string; capabilities: SkillCapabilities }[];
  warnings: ValidationIssue[];
}
/** the daemon rejects an input longer than this (defense-in-depth at the trust boundary; the resolver
 *  canonicalizes folder paths / URLs before touching the filesystem or network). */
export const MAX_SOURCE_INPUT_LEN = 2048;
export interface AddSourceRequest {
  input: string; // raw user string (≤ MAX_SOURCE_INPUT_LEN); the daemon sniffs it (override kind via `ref`)
  ref?: SourceRef; // optional explicit override of the sniffed kind
}
export interface AddSourceResult {
  sourceId: string;
  added: number;
  seq: number;
  /** count of skills whose ingest-time embedding was SKIPPED because the provider was unreachable/
   *  misconfigured (the corpus went lexical-only for these). OPTIONAL/additive (schemaVersion stays 1);
   *  surfaced so an API consumer SEES the Tier-2 degradation rather than discovering it silently (M-embed,
   *  never-silent). Absent/0 ⇒ no skip (either no provider configured, or every vector was computed). */
  embeddingsSkipped?: number;
}
export interface SourceRecord {
  sourceId: string;
  kind: SourceKind;
  input: string;
  ref?: string;
  subdir?: string;
  skillCount: number;
  addedAt: string;
  lastSynced?: string;
  status: "ok" | "error" | "syncing";
  error?: string;
}
/** a per-skill capability delta on re-sync — feeds the Inspect "re-sync capability diff" (§9, §7.1). */
export interface CapabilityChange {
  id: string;
  slug: string;
  before: SkillCapabilities;
  after: SkillCapabilities;
  contentHashChanged: boolean;
}
/** re-sync is diff-aware (§5): reports changed skills AND any exec grants auto-revoked by a hash change (D10). */
export interface ResyncResult {
  sourceId: string;
  changed: number;
  added: number;
  removed: number;
  revokedGrants: string[]; // skill ids whose contentHash changed → grant reset to false (§7.2)
  /** before→after capability deltas for changed skills (the Inspect diff renders these, not just counts).
   *  OPTIONAL for additive-safety; the daemon's resync endpoint (W1/W2) MUST populate it (enforced by its tests). */
  capabilityChanges?: CapabilityChange[];
  seq: number;
}

// ── Skills DTOs (§9) — list / detail / per-target enable / hash-bound exec grant ──
export interface SkillDetail {
  entry: ManifestSkillEntry;
  instructions: string; // full SKILL.md body, loaded lazily by id
  embeddingNeighbors?: { slug: string; cosine: number }[]; // overlap/conflict surface in Inspect
}
export interface SetEnabledRequest {
  target: TargetId;
  on: boolean;
}
/** grant is bound to contentHash (D10): the daemon 409s if the hash no longer matches the on-disk bytes. */
export interface ExecGrantRequest {
  contentHash: string;
  on: boolean;
}
export interface MutationResult {
  seq: number;
}

// ── Route/Test DTOs (§6, §9) — the same select() the inject-based runtime uses ──
export interface RouteTestRequest {
  messages: ChatMsg[];
  target: TargetId;
  explicit?: string;
  /** per-target/per-model budget (§3 SelectionContext, R1 MINOR). Absent → the daemon applies its
   *  configured default for `target` (+ model), so "what you see in Test is exactly what fires" holds. */
  budget?: { maxSkills: number; maxTokens: number; model?: string };
}
export interface RouteTestResult {
  selection: Selection;
  injection: InjectionContent;
  /** where the firing tier's top score sits vs its gate θ — makes "inject nothing" legible (§6) */
  threshold: { tier: SelectionMode; theta: number; topScore: number; margin: number };
  /** present when semantic Tier-2 was unavailable (M-embed): visible degradation, never silent */
  tierDisabled?: { tier: "semantic"; reason: string };
  /** MCP is host-driven (R1-B2): candidates the host COULD pick, not a deterministic choice */
  hostDriven?: boolean;
}

// ── Health (§9 Status) ──
export interface HealthStatus {
  ok: boolean;
  seq: number;
  dbRevision: number;
  uptimeMs: number;
  writerPid: number;
  lmStudioReachable: boolean;
  embeddingsReachable: boolean; // false => Tier-2 disabled banner in the UI
  /** per-target liveness for the Status surface's "which targets are live" (§9). OPTIONAL for
   *  additive-safety; the daemon's /health (W1) MUST populate it (enforced by its tests). */
  targets?: Partial<Record<TargetId, { live: boolean; reason?: string }>>;
}

// ── SSE event envelope (§9 Activity) — one discriminated union over the daemon's live stream ──
// `conversationId` + skill `id` are carried on selection/injection so the UI can scope the sticky-turn
// suppression action ("this skill is wrong → suppress for THIS conversation", §9/R1-B1) to one skill in
// one chat — slug alone is ambiguous (not unique). `injectedChars` completes D11's "bytes + length".
export type DaemonEvent =
  | { type: "selection"; ts: string; data: { traceId: string; conversationId?: string; target: TargetId; selection: Selection; tierDisabled?: "semantic" } }
  | { type: "exec"; ts: string; data: ExecLogLine }
  | { type: "injection"; ts: string; data: { id?: string; slug: string; conversationId?: string; target: TargetId; injectedBytes: number; injectedChars?: number; tokenCost: number; disclosure: Disclosure; sticky?: boolean } } // id/injectedChars OPTIONAL (additive); daemon (W1/W4) MUST stamp both — enforced by its tests
  | { type: "source"; ts: string; data: { sourceId: string; status: SourceRecord["status"]; changed?: number } }
  | { type: "staleness"; ts: string; data: { manifestSeq: number; daemonSeq: number; dbRevision: number } };
export type DaemonEventType = DaemonEvent["type"];

// ── Control-API route table (single source of truth for daemon server + UI client) ──
// Documented here so the W1 server and the W5 client implement the SAME paths without coordinating.
export const API_ROUTES = {
  health: "GET /health",
  getConfig: "GET /config",
  patchConfig: "PATCH /config",
  events: "GET /events", // text/event-stream (SSE)
  previewSource: "POST /sources/preview",
  addSource: "POST /sources",
  listSources: "GET /sources",
  removeSource: "DELETE /sources/:sourceId",
  resyncSource: "POST /sources/:sourceId/resync",
  listSkills: "GET /skills", // ?target=&q=&enabledOnly=
  getSkill: "GET /skills/:id",
  getSkillFile: "GET /skills/:id/file", // ?relPath= → full bytes for the Inspect Scripts review (D2/§7.2)
  setEnabled: "POST /skills/:id/enabled",
  setExecAllowed: "POST /skills/:id/exec-allowed",
  setMcpRunMute: "POST /skills/:id/mcp-mute", // owner MCP run-mute (C4) — pause/resume MCP script runs

  runSkill: "POST /skills/:id/run", // the exec chokepoint — delegates to core.exec (D2/§7.3); 403 = RunSkillRefusal
  routeTest: "POST /route-test",
  getActivity: "GET /activity", // ?since=&type=&limit= → backfill the Activity surface from the JSONL logs
  suppressSkill: "POST /conversations/:conversationId/suppress", // sticky-turn "this skill is wrong" (R1-B1)
} as const;

// ── Config patch (§9 Settings) — deep-partial MERGE, not replace. Omitting a key is a NO-OP (it does NOT
// clear). To DISABLE the embeddings provider send `embeddings: null` explicitly — this is the one place
// M-embed's "never a silent Tier-2 downgrade" is enforced: a missing `embeddings` must never disable it. ──
export type PatchConfigRequest = {
  port?: number;
  lmStudioBaseUrl?: string;
  embeddings?: EmbeddingsProvider | null; // null = explicit clear (disable Tier-2); undefined = leave as-is
  upstreams?: Partial<Record<TargetId, UpstreamConfig>>;
  defaults?: { enabledFor?: Partial<Record<TargetId, boolean>> };
  trustLevels?: Record<string, TrustLevel>;
};

// ── Skill file contents (Inspect Scripts tab, D2/§7.2) — the user must SEE the script before granting exec ──
export interface FlaggedLine {
  line: number; // 1-based
  flag: CapabilityFlag; // why this line was flagged (humble: what we noticed, never a verdict — D14)
  snippet: string;
}
export interface SkillFileContents {
  relPath: string;
  bytes: number;
  lang?: string;
  text: string; // full file text (UTF-8); `truncated` if it exceeded the server cap
  truncated: boolean;
  flaggedLines: FlaggedLine[]; // per-line classification so the UI can highlight by class
}

// ── Sticky-turn suppression (R1-B1, §9 Activity) — scoped to ONE skill in ONE conversation ──
export interface SuppressRequest {
  skillId: string;
  on: boolean; // true = suppress for the rest of this conversation; false = un-suppress
  reason?: string;
}

// ── Skill execution (the exec chokepoint, §7.3/D2/D20) — the daemon DELEGATES every spawn to core.exec ──
// The daemon never spawns a skill script itself: it resolves the script realpath-UNDER the skill root,
// recomputes the bundle contentHash from the on-disk bytes, refuses unless the grant is active AND that
// hash still equals the granted one, then hands an ExecRequest to core.exec. Every refusal is a structured
// 403 AND an exec.log.jsonl audit line + an `exec` SSE event (never silent — actor-observability).
export interface RunSkillRequest {
  /** bundle-relative path of the script to run; resolved realpath-UNDER the skill root (traversal refused). */
  script: string;
  args?: string[];
  /** which inject/host target initiated the run (stamped on the audit line; optional). */
  target?: TargetId;
  /** conversation scope — a skill SUPPRESSED for this conversation (R1-B1) is refused at the chokepoint.
   *  TRUSTED-INJECT-ONLY (C4): only the first-party inject runtime (plugin/proxy), which OWNS the conversation
   *  id, ever supplies this. The MCP path NEVER sets it (the MCP run tool has no conversationId arg — it would
   *  be a forgeable, rotatable client scope). MCP run-gating is the non-rotatable owner mute (mcpRunMuted). */
  conversationId?: string;
  /** recompute + gate but never spawn. Also FORCED when the source's configured trust is "dry-run" (§7). */
  dryRun?: boolean;
}
/** Success body — ExecResult-shaped (schema.ts): exit/duration/bounded tails + the contentHash RECOMPUTED
 *  from the on-disk bytes immediately before the spawn (D20). */
export type RunSkillResult = ExecResult;
/** 403 body when the chokepoint refuses to spawn (never silent — also an exec.log.jsonl line + `exec` SSE).
 *  `reason` names the gate that fired; the hash fields are present on a content drift so the UI can say
 *  "the skill changed since you granted exec — re-review" rather than a generic failure (D10/D20). */
export interface RunSkillRefusal {
  error: "exec-refused";
  reason:
    | "no-grant"
    | "hash-mismatch"
    | "path-escape"
    | "not-a-script"
    | "interpreter-unresolved" // the script's interpreter could not be located on an absolute PATH entry
    | "bundle-unreadable"
    | "bad-args" // the requested argv is not spawn-safe (a non-string / NUL-byte arg) — a CALLER-input error,
    // distinct from content drift; refused before delegating so it is never mislabeled hash-mismatch
    | "suppressed";
  grantedHash?: string; // the granted/stored contentHash the run was gated against
  currentHash?: string; // the hash recomputed from the on-disk bytes (when it could be computed)
  /** OPTIONAL human-legible reason carried alongside `reason` (C4): `suppressed` covers BOTH conversation
   *  suppression (R1-B1, trusted-inject path) AND the owner MCP run-mute (mcpRunMuted, mcp path). `detail`
   *  distinguishes them for the host/UI (e.g. "muted for MCP runs by the owner …"). Additive. */
  detail?: string;
}

// ── Owner MCP run-mute (C4) — a human-set, persisted, per-skill pause of MCP script runs ──
/** Body for POST /skills/:id/mcp-mute. `on=true` mutes MCP runs for the skill; `on=false` re-enables them.
 *  Local-only control plane (same trust model as the exec grant — fronted by the admission gate, NOT a
 *  stronger-than-local auth claim). The effect is enforced fail-closed at the exec chokepoint (mcpRunMuted). */
export interface McpMuteRequest {
  on: boolean;
}

// ── Activity backfill (§5: exec.log.jsonl is the Activity source of truth) — SSE is live-only, this
// hydrates the surface on load from the append-only logs. ──
export interface ActivityQuery {
  since?: string; // ISO ts; default = a recent window
  type?: DaemonEventType;
  limit?: number;
}

// ── Cross-wave skill record + filter (PLAN §3 SkillStore/EmbeddingIndex). ManifestSkillEntry IS the
// read-path record — declared as an alias so W1 (store), W3 (index), W4 (exec) share ONE shape. ──
export type SkillRecord = ManifestSkillEntry;
export interface SkillFilter {
  target?: TargetId;
  q?: string;
  enabledOnly?: boolean;
}
export interface ScoredId {
  id: string;
  score: number;
}

// ── Typed error envelopes ──
/** 409 from setExecAllowed when the granted contentHash no longer matches the on-disk bytes (D10/§7.2):
 *  the UI distinguishes "the skill changed — re-review" from a generic failure. */
export interface ExecGrantError {
  error: "hash-mismatch";
  currentHash: string;
}

// ── Typed route I/O (single source of truth so the W1 server and the W5 client bind the SAME shapes
// per route — bare path strings in API_ROUTES are not enough; a guessed DTO is the silent integration
// defect this whole freeze exists to prevent). `void` = no body. ──
export interface RouteIO {
  health: { req: void; res: HealthStatus };
  getConfig: { req: void; res: DaemonConfig };
  patchConfig: { req: PatchConfigRequest; res: DaemonConfig };
  events: { req: void; res: DaemonEvent }; // SSE stream of DaemonEvent
  previewSource: { req: AddSourceRequest; res: SourcePreview };
  addSource: { req: AddSourceRequest; res: AddSourceResult };
  listSources: { req: void; res: SourceRecord[] };
  removeSource: { req: void; res: MutationResult };
  resyncSource: { req: void; res: ResyncResult };
  listSkills: { req: void; res: ManifestSkillEntry[] }; // query via SkillFilter on the URL
  getSkill: { req: void; res: SkillDetail };
  getSkillFile: { req: void; res: SkillFileContents }; // query: relPath
  setEnabled: { req: SetEnabledRequest; res: MutationResult };
  setExecAllowed: { req: ExecGrantRequest; res: MutationResult }; // 409 body = ExecGrantError
  setMcpRunMute: { req: McpMuteRequest; res: MutationResult }; // owner MCP run-mute (C4)
  runSkill: { req: RunSkillRequest; res: RunSkillResult }; // 403 body = RunSkillRefusal
  routeTest: { req: RouteTestRequest; res: RouteTestResult };
  getActivity: { req: void; res: DaemonEvent[] }; // query via ActivityQuery on the URL
  suppressSkill: { req: SuppressRequest; res: MutationResult };
}

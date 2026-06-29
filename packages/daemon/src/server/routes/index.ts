// @skillforge/daemon/server/routes — every API_ROUTES entry, implemented to its RouteIO type (api.ts).
//
// The route table is the single source of truth the W1 server and the W5 UI client bind the SAME shapes
// against. Handlers are thin: they validate the request envelope, call persistence/ingest/core, and shape
// the typed response. Three surfaces are W4 (exec) and respond with a STRUCTURED 501 (never a silent
// 404/empty): getSkillFile, setExecAllowed, suppressSkill. The route-tester runs the EXACT path the
// runtime uses (buildLexicalIndex → createEmbeddingIndex → selectWithEscalation → buildInjection), so
// "what you see in Test is what fires" (§6); Tier-2 unavailability surfaces as a VISIBLE tierDisabled,
// never a silent downgrade (M-embed/D26).
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  buildLexicalIndex,
  createEmbeddingIndex,
  createEmbedProvider,
  selectWithEscalation,
  buildInjection,
  parseFrontmatter,
  resolveEmbeddingsUrl,
  cosine,
  resolveUnderRoot,
  PathEscapeError,
  detectCapabilities,
  sha256,
  bundleContentHash,
  run,
  EXEC_ENV_ALLOWLIST,
  resolveInterpreterAbsolute,
  validateArgvShape,
  refusalLine,
  isMcpRunMuted,
  type ExecSkill,
  type ExecSink,
} from "@skillforge/core";
import {
  SCHEMA_VERSION,
  ROUTING,
  type InjectionPolicy,
  type SelectionMode,
  type SkillManifest,
  type ManifestSkillEntry,
  type TargetId,
  type BundleEntry,
  type ExecRequest,
  type ExecLogLine,
} from "@skillforge/contracts";
import type {
  DaemonConfig,
  HealthStatus,
  PatchConfigRequest,
  AddSourceRequest,
  SetEnabledRequest,
  RouteTestRequest,
  RouteTestResult,
  SkillDetail,
  SkillFilter,
  ActivityQuery,
  DaemonEventType,
  MutationResult,
  ExecGrantRequest,
  McpMuteRequest,
  SuppressRequest,
  SkillFileContents,
  FlaggedLine,
  RunSkillRequest,
  RunSkillResult,
  RunSkillRefusal,
} from "@skillforge/contracts/api";
import { MAX_SOURCE_INPUT_LEN } from "@skillforge/contracts/api";
import type { Persistence } from "../../index.ts";
import { sourcesPath } from "../../home.ts";
import { ExecGrantError } from "../../store/store.ts";
import type { EventBus } from "../events.ts";
import type { Ingest } from "../../ingest/ingest.ts";
import { getActivity, EXEC_LOG_FILE } from "../activity.ts";
import type { SuppressionStore } from "../suppression.ts";
import { openSseStream, type JsonResponse, type ReqCtx, type RouteDef } from "../http.ts";
import { staticRoutes } from "../static.ts";
// ── Wave B: mount the two new inject/host adapters into the daemon. The daemon is NOT an adapter, so it MAY
//    depend on adapters (the reverse is forbidden — PLAN §2). Both export daemon-mountable factories whose
//    RouteDef shapes structurally mirror this server's, so the spreads below drop straight into buildRoutes
//    behind the daemon's admission gate + CORS for free. ──
import { createMcpHttpHandler, SERVER_VERSION } from "@skillforge/mcp-server";
import type {
  McpServerDeps,
  McpMenuItem,
  McpSkillDetail,
  McpRunOutcome,
  McpRefusalReason,
  McpResource,
  McpResourceOutcome,
} from "@skillforge/mcp-server";
import { proxyRoutes, appendSelectLog } from "@skillforge/proxy";
import type { SelectLogLine } from "@skillforge/proxy";

type EmbedFetch = NonNullable<Parameters<typeof createEmbedProvider>[1]>;

const DEFAULT_ROUTE_TEST_MAX_TOKENS = 2000;
const DEFAULT_ROUTE_TEST_MAX_SKILLS = 5;
const NEIGHBORS_K = 5;

/** Everything the route handlers close over — the daemon's wired context. */
export interface RouteContext {
  home: string;
  persistence: Persistence;
  config: () => DaemonConfig;
  /** apply a PATCH (deep-merge), persist to disk, swap the in-memory config; returns the new config. */
  patchConfig: (patch: PatchConfigRequest) => DaemonConfig;
  events: EventBus;
  ingest: Ingest;
  /** conversation-scoped sticky-turn suppression (R1-B1) — tracked here, honored by the run chokepoint. */
  suppression: SuppressionStore;
  startedAt: number;
  /** reachability probe (injectable for tests); resolves true when the host answers (any HTTP status). */
  reachable: (url: string) => Promise<boolean>;
  /** injected fetch for the route-tester's embeddings provider (tests pass a hermetic fake). */
  embedFetch?: EmbedFetch;
  /** absolute path of the @skillforge/ui web/ dir served at `/` and `/web/*` (single-origin console). */
  webDir: string;
}

const ok = (body: unknown, status = 200): JsonResponse => ({ status, body });

/** Read a skill's SKILL.md INSTRUCTIONS BODY path-safely from home/sources/<dir>/SKILL.md; "" when
 *  unreadable. Frontmatter is STRIPPED via parseFrontmatter — IDENTICAL to the plugin's loadInstructions
 *  (read-model.ts), so the route-test's `full` injection text/injectedBytes/tokenCost are byte-for-byte
 *  what the plugin actually injects at runtime ("what you see in Test is what fires", §6/D26). Loading the
 *  raw file here would inject the frontmatter too and silently diverge the Test preview from the runtime. */
function readInstructions(home: string, dir: string): string {
  try {
    const abs = resolveUnderRoot(sourcesPath(home), `${dir}/SKILL.md`);
    return parseFrontmatter(fs.readFileSync(abs, "utf8")).body;
  } catch {
    return ""; // missing/escaping body → no instructions to inject (rankable on metadata alone)
  }
}

/** Lift a stored ManifestSkillEntry (+ loaded body) into the SkillManifest shape the selector/injector
 *  consume (the routing path is metadata + the chosen body — IDENTICAL to the runtime). */
function toRoutingManifest(entry: ManifestSkillEntry, instructions: string): SkillManifest {
  const m: SkillManifest = {
    schemaVersion: SCHEMA_VERSION,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    instructions,
    bodyLen: entry.bodyLen,
    tokenEstimate: entry.tokenEstimate,
    warnings: entry.warnings,
    id: entry.id,
    contentHash: entry.contentHash,
  };
  if (entry.embedding) m.embedding = entry.embedding;
  return m;
}

// ── route-test (§6/§9): the SAME select() the inject-based runtime uses ───────────────────────────────
async function handleRouteTest(ctx: RouteContext, body: RouteTestRequest): Promise<RouteTestResult> {
  const target = body.target;
  const config = ctx.config();

  // The per-target ENABLED pool (the §6 hard structural pre-filter). Both the lexical index and the
  // routing manifests are built from THIS set, so a disabled skill can never fire here.
  const entries = ctx.persistence.store.list({ target, enabledOnly: true });
  const pool = entries.map((e) => toRoutingManifest(e, readInstructions(ctx.home, e.dir)));

  const lexIndex = buildLexicalIndex(pool);
  const embeddingIndex = createEmbeddingIndex(config.embeddings?.dim ? { dim: config.embeddings.dim } : {});
  await embeddingIndex.ensure(entries); // vectors keyed by contentHash (from the stored embeddings)

  const embedFn = config.embeddings ? createEmbedProvider(config.embeddings, ctx.embedFetch) : undefined;

  // Build the routing query from the latest user turn; an `explicit` override forces Tier-0 ($slug).
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const query = body.explicit ? `$${body.explicit} ${lastUser}`.trim() : lastUser;

  const escalated = await selectWithEscalation(query, {
    skills: pool,
    lexIndex,
    embeddingIndex,
    ...(embedFn ? { embedFn } : {}),
  });
  const selection = escalated.selection;

  const policy: InjectionPolicy = {
    maxTokens: body.budget?.maxTokens ?? DEFAULT_ROUTE_TEST_MAX_TOKENS,
    menuOnAmbiguous: true,
    maxMenuItems: body.budget?.maxSkills ?? DEFAULT_ROUTE_TEST_MAX_SKILLS,
  };
  const injection = buildInjection(selection, pool, policy);

  // Threshold legibility (§6 "makes inject-nothing legible"): which gate the firing/non-firing tier sat
  // against, the top score, and the margin to #2.
  const tier: SelectionMode = selection.mode;
  const semanticConfigured = !!config.embeddings && embeddingIndex.vectors.size > 0;
  const theta =
    tier === "explicit" ? 1
    : tier === "semantic" ? ROUTING.semanticFireThreshold
    : tier === "lexical" ? ROUTING.lexicalFireThreshold
    : semanticConfigured ? ROUTING.semanticFireThreshold
    : ROUTING.lexicalFireThreshold;
  const topScore = selection.chosen?.score ?? selection.candidates[0]?.score ?? 0;
  const secondScore = selection.candidates[1]?.score ?? 0;

  const result: RouteTestResult = {
    selection,
    injection,
    threshold: { tier, theta, topScore, margin: topScore - secondScore },
  };
  if (escalated.tierDisabled) result.tierDisabled = escalated.tierDisabled;
  if (target === "mcp") result.hostDriven = true; // MCP is host-driven (R1-B2): candidates, not a choice
  return result;
}

// ── health (§9 Status) ────────────────────────────────────────────────────────────────────────────────
async function handleHealth(ctx: RouteContext): Promise<HealthStatus> {
  const config = ctx.config();
  const store = ctx.persistence.store;

  const lmStudioReachable = await ctx.reachable(`${config.lmStudioBaseUrl.replace(/\/+$/, "")}/v1/models`);
  const embeddingsReachable = config.embeddings ? await ctx.reachable(resolveEmbeddingsUrl(config.embeddings.baseUrl)) : false;

  const targets: Partial<Record<TargetId, { live: boolean; reason?: string }>> = {
    lmstudio: lmStudioReachable ? { live: true } : { live: false, reason: `LM Studio not reachable at ${config.lmStudioBaseUrl}` },
    mcp: { live: true }, // daemon-served, host-driven (R1-B2) — the endpoint is always exposed
    proxy: config.upstreams?.proxy?.chatBaseUrl ? { live: true } : { live: false, reason: "no proxy upstream configured" },
  };

  return {
    ok: true,
    seq: store.revision(),
    dbRevision: store.dbRevision(),
    uptimeMs: Date.now() - ctx.startedAt,
    writerPid: ctx.persistence.lock.pid,
    lmStudioReachable,
    embeddingsReachable,
    targets,
  };
}

// ── skills (§9) ───────────────────────────────────────────────────────────────────────────────────────
function parseSkillFilter(q: URLSearchParams): SkillFilter {
  const f: SkillFilter = {};
  const target = q.get("target");
  if (target === "lmstudio" || target === "mcp" || target === "proxy") f.target = target;
  const query = q.get("q");
  if (query) f.q = query;
  if (q.get("enabledOnly") === "true" || q.get("enabledOnly") === "1") f.enabledOnly = true;
  return f;
}

function handleGetSkill(ctx: RouteContext, id: string): JsonResponse {
  const entry = ctx.persistence.store.get(id);
  if (!entry) return { status: 404, body: { error: "not-found", id } };
  const instructions = readInstructions(ctx.home, entry.dir);

  const detail: SkillDetail = { entry, instructions };
  if (entry.embedding && entry.embedding.length > 0) {
    const self = entry.embedding;
    const neighbors = ctx.persistence.store
      .list()
      .filter((s) => s.id !== id && s.embedding && s.embedding.length > 0)
      .map((s) => ({ slug: s.slug, cosine: cosine(self, s.embedding!) }))
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, NEIGHBORS_K);
    if (neighbors.length > 0) detail.embeddingNeighbors = neighbors;
  }
  return ok(detail);
}

// ── activity (§5 backfill) ────────────────────────────────────────────────────────────────────────────
function parseActivityQuery(q: URLSearchParams): ActivityQuery {
  const query: ActivityQuery = {};
  const since = q.get("since");
  if (since) query.since = since;
  const type = q.get("type");
  if (type) query.type = type as DaemonEventType;
  const limit = q.get("limit");
  if (limit && Number.isFinite(Number(limit))) query.limit = Number(limit);
  return query;
}

// ── W4: exec observability (§7 — the 3 moments: inspect / grant / run) ─────────────────────────────────
//
// core.exec is the ONLY skill-script spawn path (D2/§7.3): the daemon resolves + gates, then DELEGATES to
// core.run() — it never spawns a skill script itself. Every refusal is a structured response AND (for run
// attempts) an exec.log.jsonl audit line + an `exec` SSE event (never silent — actor-observability). No
// "safe/verified" claim is made anywhere; flags are a HUMBLE inventory of what we noticed (D14).

/** Cap on the bytes returned as `text` by getSkillFile (the Inspect Scripts view). A larger file is read
 *  only up to this and marked `truncated` — bounds memory on a hostile multi-GB file in the tree. */
const MAX_FILE_TEXT_BYTES = 512 * 1024;

// EXEC_ENV_ALLOWLIST + resolveInterpreterAbsolute are now @skillforge/core/exec/gate (Wave C / D3) — the SAME
// implementation the standalone MCP catalog path uses, so "both surfaces gate identically" is structural.

/** Longest single line (in chars) fed to the matcher — bounds regex CPU on a pathological newline-free file
 *  while keeping the scan complete enough for review. A line longer than this is matched on its first slice. */
const MAX_SCAN_LINE_CHARS = 64 * 1024;
/** Chunk size for the streaming full-file flag scan (bounds resident memory regardless of file size). */
const FLAG_SCAN_CHUNK = 64 * 1024;

/** Flag ONE line and append a FlaggedLine per detected flag. Reuses the EXACT core capability signatures
 *  (via detectCapabilities over a one-line synthetic script) — never a daemon-local copy of the regexes —
 *  so the per-line highlight matches the corpus-level inventory. Humble: "what we noticed", not a verdict. */
function pushLineFlags(out: FlaggedLine[], line: string, lineNo: number): void {
  if (line.trim() === "") return;
  const scan = line.length > MAX_SCAN_LINE_CHARS ? line.slice(0, MAX_SCAN_LINE_CHARS) : line;
  const probe: BundleEntry = { relPath: "_line_", kind: "script", bytes: 0, hash: "" };
  const caps = detectCapabilities([{ entry: probe, content: scan }], "");
  for (const flag of caps.flags) out.push({ line: lineNo, flag, snippet: scan.slice(0, 200) });
}

/** Stream the WHOLE file (not just the display window) and flag every line — the flag inventory must be
 *  COMPLETE so a `curl|bash` / `os.system('rm -rf')` past the display cap is never silently dropped from the
 *  review surface (the user grants exec against the full file, not the first 512KB). Memory stays bounded by
 *  FLAG_SCAN_CHUNK + one line; a StringDecoder keeps multibyte chars intact across chunk boundaries. */
function flaggedLinesForFile(abs: string): FlaggedLine[] {
  const out: FlaggedLine[] = [];
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(FLAG_SCAN_CHUNK);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let lineNo = 0;
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, FLAG_SCAN_CHUNK, null)) > 0) {
      carry += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, nl).replace(/\r$/, "");
        carry = carry.slice(nl + 1);
        pushLineFlags(out, line, ++lineNo);
      }
      // A newline-free line longer than the per-line cap: flush a bounded prefix as one line, drop the rest
      // of THIS line (bounded) — we still flag what the cap can hold rather than buffer unboundedly.
      if (carry.length > MAX_SCAN_LINE_CHARS) {
        pushLineFlags(out, carry.slice(0, MAX_SCAN_LINE_CHARS), ++lineNo);
        const drop = carry.indexOf("\n");
        carry = drop === -1 ? "" : carry.slice(drop + 1);
      }
    }
    carry += decoder.end();
    if (carry.length > 0) pushLineFlags(out, carry, ++lineNo);
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/** lowercased file extension as a coarse `lang` hint for syntax highlighting; undefined when there is none. */
function langFromRelPath(relPath: string): string | undefined {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

/** Recompute the canonical bundle contentHash from the ACTUAL on-disk bytes (D20) — the grant key. Throws
 *  (PathEscapeError or an fs error) when a bundle file is missing / unreadable / escapes the root.
 *  SCOPE (guarded invariant): this hashes the ENUMERATED bundle entries (the manifest's `bundle`), NOT a
 *  fresh tree walk — so a NEW file dropped into the tree neither changes this hash nor becomes runnable: the
 *  run gate (handleRunSkill step "executable bundled script") requires the requested script to BE a bundle
 *  entry, and core.run recomputes over the same enumerated set. */
function recomputeBundleHash(rootDir: string, bundle: BundleEntry[]): string {
  const pairs = bundle.map((entry) => {
    const abs = resolveUnderRoot(rootDir, entry.relPath);
    return { relPath: entry.relPath, hash: sha256(fs.readFileSync(abs)) };
  });
  return bundleContentHash(pairs);
}

/** Thrown when a guardrail audit line cannot be durably appended to exec.log.jsonl. The exec log is the
 *  SOURCE OF TRUTH for the Activity surface, so a dropped guardrail event must FAIL CLOSED (a visible 500),
 *  never let a refusal/run return as if it had been audited (never-silent, D2/§7). */
class AuditAppendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditAppendError";
  }
}

// refusalLine (the pre-spawn REFUSAL audit-line SHAPE) is now @skillforge/core/exec/gate (Wave C / D3),
// shared with the MCP path; the daemon owns the IO via auditExec below (fail-closed).

/** Append one exec audit line to home/exec.log.jsonl (the §7 audit getActivity reads) AND emit a live
 *  `exec` SSE event. Used for daemon-side refusals; the spawn path lets core.exec append + the sink emit.
 *  A failed append FAILS CLOSED (throws AuditAppendError → the caller returns a 500 audit-error): the
 *  guardrail event is the source of truth and must never be silently dropped while the refusal still ships. */
function auditExec(ctx: RouteContext, line: ExecLogLine): void {
  const p = path.join(ctx.home, EXEC_LOG_FILE);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(line)}\n`, "utf8");
  } catch (e) {
    throw new AuditAppendError(`exec audit append failed (${EXEC_LOG_FILE}): ${(e as Error).message}`);
  }
  ctx.events.emit({ type: "exec", ts: line.ts, data: line });
}

const refused = (refusal: RunSkillRefusal): JsonResponse => ({ status: 403, body: refusal });

/** Owner MCP RUN-MUTE (C4): the host-visible `detail` carried on the `suppressed` refusal so the host/UI can
 *  tell an owner-mute apart from a conversation suppression (both use the NAMED `suppressed` reason). The
 *  audit line's stderrTail embeds the same phrase (with the slug) so Activity shows WHY the run was refused. */
const MCP_RUN_MUTE_DETAIL = "muted for MCP runs by the owner (re-enable in SkillForge)";

// validateArgvShape is now @skillforge/core/exec/gate (Wave C / D3), shared with the MCP path + core.run.

// ── getSkillFile (GET /skills/:id/file?relPath=) — the Inspect Scripts review surface (D2/§7.2) ──────────
function handleGetSkillFile(ctx: RouteContext, id: string, relPath: string | null): JsonResponse {
  const entry = ctx.persistence.store.get(id);
  if (!entry) return { status: 404, body: { error: "not-found", id } };
  if (typeof relPath !== "string" || relPath === "") return { status: 400, body: { error: "relPath-required" } };

  // LIVE user-supplied-path → file-bytes surface (W0 advisory): resolve realpath-UNDER the skill root and
  // reject any traversal/symlink escape with a TYPED error — never read bytes outside the skill's tree.
  let abs: string;
  try {
    const skillRoot = resolveUnderRoot(sourcesPath(ctx.home), entry.dir);
    abs = resolveUnderRoot(skillRoot, relPath);
  } catch (e) {
    if (e instanceof PathEscapeError) return { status: 400, body: { error: "path-escape", relPath } };
    throw e;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { status: 404, body: { error: "file-not-found", relPath } };
  }
  if (!stat.isFile()) return { status: 400, body: { error: "not-a-file", relPath } };

  // Bounded read of the DISPLAY window. Buffer.alloc is ZEROED and we serialize ONLY the bytes readSync
  // actually returned (`n`) — if the untrusted file SHRINKS between statSync and readSync (threat model:
  // an attacker swaps the file), we must never serialize the uninitialized tail of the buffer (CWE-908
  // heap disclosure). `bytes`/`truncated` are derived from what we actually observed, not the stale stat.
  const cap = MAX_FILE_TEXT_BYTES;
  const readLen = Math.min(stat.size, cap);
  const buf = Buffer.alloc(readLen);
  let n = 0;
  const fd = fs.openSync(abs, "r");
  try {
    if (readLen > 0) n = fs.readSync(fd, buf, 0, readLen, 0);
  } finally {
    fs.closeSync(fd);
  }
  const reachedEof = n < readLen; // fewer bytes than requested ⇒ the file ended (it was smaller than stat said)
  const text = buf.subarray(0, n).toString("utf8");
  const bytes = reachedEof ? n : stat.size; // honest size: the read total on EOF, else the stat size
  const truncated = !reachedEof && stat.size > cap; // display capped (NOT a shrink, which we read in full)

  // flaggedLines scan the FULL file (#3) — a flag past the display cap must still surface for review.
  const result: SkillFileContents = { relPath, bytes, text, truncated, flaggedLines: flaggedLinesForFile(abs) };
  const lang = langFromRelPath(relPath);
  if (lang) result.lang = lang;
  return ok(result);
}

// ── setExecAllowed (POST /skills/:id/exec-allowed) — the hash-bound exec grant (D10/§7.2) ────────────────
function handleSetExecAllowed(ctx: RouteContext, id: string, body: ExecGrantRequest): JsonResponse {
  const entry = ctx.persistence.store.get(id);
  if (!entry) return { status: 404, body: { error: "not-found", id } };
  if (typeof body.contentHash !== "string" || typeof body.on !== "boolean") {
    return { status: 400, body: { error: "invalid-grant" } };
  }
  // GRANT against LIVE on-disk reality (#4): the store check binds the grant to the DB row only; a
  // post-ingest disk tamper (bytes changed without a resync) would still match the stale DB row. So before
  // writing the grant we recompute the bundle hash from the ACTUAL on-disk bytes and 409 unless it equals
  // the hash the user reviewed — the grant can never reflect content that is no longer on disk.
  if (body.on) {
    let liveHash: string;
    try {
      const skillRoot = resolveUnderRoot(sourcesPath(ctx.home), entry.dir);
      liveHash = recomputeBundleHash(skillRoot, entry.bundle);
    } catch {
      // the on-disk bundle is missing / unreadable → it cannot be bound to ANY reviewed hash; refuse.
      return { status: 409, body: { error: "hash-mismatch", currentHash: "" } };
    }
    if (liveHash !== body.contentHash) {
      return { status: 409, body: { error: "hash-mismatch", currentHash: liveHash } };
    }
  }
  try {
    ctx.persistence.store.setExecAllowed(id, body.contentHash, body.on); // also binds to the DB row (belt+suspenders)
  } catch (e) {
    if (e instanceof ExecGrantError) {
      // the granted hash no longer matches the stored bytes → the skill changed; re-review required (D10).
      return { status: 409, body: { error: "hash-mismatch", currentHash: e.currentHash } };
    }
    throw e;
  }
  const model = ctx.persistence.publishManifest(); // the grant is read-model state — republish so it shows
  return ok({ seq: model.seq } as MutationResult);
}

// ── setMcpRunMute (POST /skills/:id/mcp-mute) — the owner MCP run-mute (C4) ───────────────────────────────
//
// A human-set, persisted, per-skill pause of MCP script runs. Local-only control plane — the daemon's
// admission gate fronts it (same trust model as the exec grant; NOT a stronger-than-local auth claim). The
// write is SYNCHRONOUSLY followed by publishManifest so a returned 200 implies the manifest already reflects
// the mute → the daemon-down stdio read path picks it up on its next read (closing the stdio fail-open window
// as far as possible; the daemon-down residual is the standard §5 read-model staleness).
function handleSetMcpRunMute(ctx: RouteContext, id: string, body: McpMuteRequest): JsonResponse {
  if (!ctx.persistence.store.get(id)) return { status: 404, body: { error: "not-found", id } };
  if (typeof body.on !== "boolean") return { status: 400, body: { error: "invalid-mcp-mute" } };
  ctx.persistence.store.setMcpRunMuted(id, body.on);
  const model = ctx.persistence.publishManifest(); // project the mute into manifest.json before returning 200
  return ok({ seq: model.seq } as MutationResult);
}

// ── suppressSkill (POST /conversations/:conversationId/suppress) — sticky-turn "this skill is wrong" ──────
function handleSuppress(ctx: RouteContext, conversationId: string, body: SuppressRequest): JsonResponse {
  if (typeof body.skillId !== "string" || body.skillId === "" || typeof body.on !== "boolean") {
    return { status: 400, body: { error: "invalid-suppress" } };
  }
  ctx.suppression.suppress(conversationId, body.skillId, body.on);
  // suppression is per-conversation turn state, not a read-model write — report the current seq (no bump).
  return ok({ seq: ctx.persistence.store.revision() } as MutationResult);
}

// ── runSkill (POST /skills/:id/run) — the EXEC CHOKEPOINT (§7.3). Resolve → recompute → gate → core.exec ─
async function handleRunSkill(ctx: RouteContext, id: string, body: RunSkillRequest): Promise<JsonResponse> {
  const target = body.target;
  try {
    return await runSkillGated(ctx, id, body, target);
  } catch (e) {
    // A guardrail audit line we could not durably record FAILS CLOSED (#2 never-silent): a refusal/run must
    // never return as if audited. Surface a visible 500 audit-error rather than drop the exec-log event.
    if (e instanceof AuditAppendError) return { status: 500, body: { error: "audit-failed", message: e.message } };
    throw e;
  }
}

async function runSkillGated(ctx: RouteContext, id: string, body: RunSkillRequest, target?: TargetId): Promise<JsonResponse> {
  const entry = ctx.persistence.store.get(id);
  if (!entry) {
    // ops symmetry (#8): even a run against an unknown id is an audited, observable refusal.
    auditExec(ctx, refusalLine("(unknown)", id, `refusing to run: no skill with id ${JSON.stringify(id)}`, "", target));
    return { status: 404, body: { error: "not-found", id } };
  }
  const script = body.script;
  if (typeof script !== "string" || script === "") {
    auditExec(ctx, refusalLine(entry.slug, entry.dir, "refusing to run: a `script` relPath is required", "", target));
    return { status: 400, body: { error: "script-required" } };
  }
  const args = Array.isArray(body.args) ? body.args : [];

  // 1. resolve the skill's materialized root (entry.dir is trusted/composed; a failure = the tree is gone).
  let skillRoot: string;
  try {
    skillRoot = resolveUnderRoot(sourcesPath(ctx.home), entry.dir);
  } catch (e) {
    const reason = `refusing to run: the skill's materialized tree is unavailable — ${(e as Error).message}`;
    auditExec(ctx, refusalLine(entry.slug, entry.dir, reason, "", target));
    return refused({ error: "exec-refused", reason: "bundle-unreadable" });
  }

  // 2. resolve the requested script realpath-UNDER the skill root — reject any traversal/symlink escape.
  let scriptAbs: string;
  try {
    scriptAbs = resolveUnderRoot(skillRoot, script);
  } catch (e) {
    if (!(e instanceof PathEscapeError)) throw e;
    const reason = `refusing to run: ${(e as Error).message}`;
    auditExec(ctx, refusalLine(entry.slug, skillRoot, reason, "", target));
    return refused({ error: "exec-refused", reason: "path-escape" });
  }

  // 3. recompute the bundle contentHash from the ACTUAL on-disk bytes (D20) — the grant is bound to it.
  let recomputed: string;
  try {
    recomputed = recomputeBundleHash(skillRoot, entry.bundle);
  } catch (e) {
    const reason = `refusing to run: cannot recompute the bundle hash from on-disk bytes — ${(e as Error).message}`;
    auditExec(ctx, refusalLine(entry.slug, skillRoot, reason, "", target));
    return refused({ error: "exec-refused", reason: "bundle-unreadable" });
  }

  // 3b. OWNER MCP RUN-MUTE (C4): a human-set, persisted, NON-ROTATABLE pause of MCP script runs. Enforced
  //     fail-closed via the SHARED isMcpRunMuted predicate (D3) so this live /mcp path and the daemon-down
  //     stdio read-model path cannot drift. entry was re-read fresh from the store above (zero staleness on the
  //     live path). Refused with the NAMED `suppressed` reason + a DISTINCT detail so the host sees WHY; the
  //     skill stays visible/readable (only the run is refused). TOCTOU: a mute set between this read and the
  //     spawn takes effect on the NEXT call (a persisted pause, not an in-flight kill) — no spawn-time re-check.
  if (isMcpRunMuted(entry.mcpRunMuted, target)) {
    const reason = `refusing to run: ${JSON.stringify(entry.slug)} is ${MCP_RUN_MUTE_DETAIL}`;
    auditExec(ctx, refusalLine(entry.slug, skillRoot, reason, recomputed, target));
    return refused({ error: "exec-refused", reason: "suppressed", detail: MCP_RUN_MUTE_DETAIL });
  }

  // 4. conversation-scoped suppression (R1-B1): a suppressed skill does not run in that conversation.
  if (body.conversationId && ctx.suppression.isSuppressed(body.conversationId, entry.id)) {
    const reason = `refusing to run: ${JSON.stringify(entry.slug)} is suppressed for conversation ${JSON.stringify(body.conversationId)}`;
    auditExec(ctx, refusalLine(entry.slug, skillRoot, reason, recomputed, target));
    return refused({ error: "exec-refused", reason: "suppressed" });
  }

  // 5. GRANT GATE (D2/D10): exec must be granted AND the on-disk hash must STILL equal the granted hash.
  //    execAllowed is itself hash-bound in the store (grant.hash === stored.hash); here we ALSO re-check the
  //    LIVE on-disk bytes, so a tree edit that did not go through resync still cannot run a stale grant.
  if (!entry.execAllowed) {
    const reason = `refusing to run: exec is not granted for ${JSON.stringify(entry.slug)} (default-deny — D2)`;
    auditExec(ctx, refusalLine(entry.slug, skillRoot, reason, recomputed, target));
    return refused({ error: "exec-refused", reason: "no-grant", grantedHash: entry.contentHash, currentHash: recomputed });
  }
  if (recomputed !== entry.contentHash) {
    const reason =
      `refusing to run: the on-disk bundle no longer matches the granted contentHash ` +
      `(granted ${entry.contentHash}, on-disk ${recomputed}) — re-review required (D10/D20)`;
    auditExec(ctx, refusalLine(entry.slug, skillRoot, reason, recomputed, target));
    return refused({ error: "exec-refused", reason: "hash-mismatch", grantedHash: entry.contentHash, currentHash: recomputed });
  }

  // 6. the script must be an executable BUNDLED script (we run it with its DERIVED interpreter).
  const norm = script.replace(/\\/g, "/");
  const be = entry.bundle.find((b) => b.relPath === norm);
  if (!be || !be.exec?.interpreter) {
    const reason = `refusing to run: ${JSON.stringify(script)} is not an executable script in the bundle`;
    auditExec(ctx, refusalLine(entry.slug, skillRoot, reason, recomputed, target));
    return refused({ error: "exec-refused", reason: "not-a-script" });
  }

  // 6b. resolve the interpreter to an ABSOLUTE path (#6) — refuse rather than spawn an unlocatable bare name.
  const interpAbs = resolveInterpreterAbsolute(be.exec.interpreter);
  if (!interpAbs) {
    const reason = `refusing to run: cannot locate interpreter ${JSON.stringify(be.exec.interpreter)} on an absolute PATH entry`;
    auditExec(ctx, refusalLine(entry.slug, skillRoot, reason, recomputed, target));
    return refused({ error: "exec-refused", reason: "interpreter-unresolved" });
  }

  // 6c. validate the FULL argv shape BEFORE delegating (#2): a NUL byte / non-string caller arg makes core's
  //     spawn() throw synchronously and would otherwise be mislabeled `hash-mismatch` by the TOCTOU mapping
  //     below. Refuse it here with an ACCURATE `bad-args` reason (parity with the standalone MCP path).
  const argv = [interpAbs, scriptAbs, ...args];
  const argvError = validateArgvShape(argv);
  if (argvError) {
    const reason = `refusing to run: the requested argv is not spawn-safe — ${argvError}`;
    auditExec(ctx, refusalLine(entry.slug, skillRoot, reason, recomputed, target));
    return refused({ error: "exec-refused", reason: "bad-args" });
  }

  // 7. trust gating (§7), FAIL-CLOSED (#7): a source pinned to "dry-run" forces dry-run; AND if trust pins
  //    exist but THIS skill's source can't be resolved, assume the strictest (dry-run) — never spawn for
  //    real past an un-checkable pin.
  const sourceId = entry.provenance[0]?.sourceId;
  const trustLevels = ctx.config().trustLevels;
  const hasPins = !!trustLevels && Object.keys(trustLevels).length > 0;
  const trust = sourceId && trustLevels ? trustLevels[sourceId] : undefined;
  const dryRun = body.dryRun === true || trust === "dry-run" || (hasPins && !sourceId);

  // 8. DELEGATE to core.exec — the ONLY spawn path. core recomputes the hash AGAIN (belt-and-suspenders,
  //    D20) and audits exactly one line to exec.log.jsonl; the sink mirrors that line onto the SSE stream.
  const execRequest: ExecRequest = {
    argv, // validated spawn-safe above (6c)
    cwd: skillRoot,
    envAllowlist: [...EXEC_ENV_ALLOWLIST],
    ...(dryRun ? { dryRun: true } : {}),
  };
  const execSkill: ExecSkill = {
    slug: entry.slug,
    rootDir: skillRoot,
    bundle: entry.bundle,
    grantedContentHash: entry.contentHash,
  };
  const sink: ExecSink = {
    onRecord: (line) => {
      const ev: ExecLogLine = target ? { ...line, target } : line;
      ctx.events.emit({ type: "exec", ts: ev.ts, data: ev });
    },
  };
  let result;
  try {
    result = await run(execSkill, execRequest, sink, { logPath: path.join(ctx.home, EXEC_LOG_FILE) });
  } catch (e) {
    // core.exec rejects only when its OWN durable audit append fails — fail closed, visibly (never silent).
    return { status: 500, body: { error: "exec-failed", message: (e as Error).message } };
  }

  // core.run REFUSES pre-spawn (#5 — rare TOCTOU: bytes changed between OUR recompute and core's) by
  // returning exit:null with a "refusing to spawn:" reason. It already wrote the audit line + our sink
  // emitted the SSE, so map it to the SAME 403 our own gates produce (no double audit) rather than a 200.
  if (result.exit === null && result.stdoutTail === "" && result.stderrTail.startsWith("refusing to spawn:")) {
    const reason: RunSkillRefusal["reason"] = /cannot recompute/.test(result.stderrTail)
      ? "bundle-unreadable"
      : /cwd escapes/.test(result.stderrTail)
        ? "path-escape"
        : "hash-mismatch";
    return refused({ error: "exec-refused", reason, grantedHash: entry.contentHash, currentHash: result.contentHash });
  }

  const res: RunSkillResult = {
    exit: result.exit,
    durationMs: result.durationMs,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
    contentHash: result.contentHash,
    // propagate core's STRUCTURED dry-run flag so the MCP mapping (and the daemon route body) read it
    // instead of sniffing stderr — a genuine trust-pinned/dry-run is true; every real spawn leaves it absent.
    ...(result.dryRun ? { dryRun: true } : {}),
  };
  return ok(res);
}

// ── MCP-over-HTTP: a daemon-backed McpServerDeps (Wave B) ────────────────────────────────────────────
//
// The SAME hand-rolled MCP dispatcher (mcp-server: server.ts/tools.ts/resources.ts) serves MCP over
// Streamable HTTP when handed these LIVE-context deps — NOT the daemon-DOWN read-model (catalog.ts). Every
// method reads the live store and run delegates to runSkillGated (the authoritative gate above): a live
// content-hash grant, trust/dry-run, conversation suppression, AND the exec.log + `exec` SSE audit, so an
// MCP run is observable in Activity exactly like a plugin/proxy run. Refusals map to NAMED MCP errors,
// never a silent no-op. Mirrors catalog.ts's menu/resource/refusal semantics but reads the DB, not the
// manifest. (This is the only seam Wave B adds; the leverage-convergence promotion to core is a later wave.)

const MCP_RESOURCE_SCHEME = "skillforge://";
const MCP_MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  rst: "text/plain",
  json: "application/json",
};

function mcpMimeForRelPath(relPath: string): string {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return MCP_MIME_BY_EXT[ext] ?? "text/plain";
}

/** Parse `skillforge://<slug>/<relPath>` → { slug, relPath }; undefined for a non-matching/empty uri. */
function mcpParseResourceUri(uri: string): { slug: string; relPath: string } | undefined {
  if (!uri.startsWith(MCP_RESOURCE_SCHEME)) return undefined;
  const rest = uri.slice(MCP_RESOURCE_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const slug = rest.slice(0, slash);
  const relPath = rest.slice(slash + 1);
  if (slug === "" || relPath === "") return undefined;
  return { slug, relPath };
}

/** Group a bundle into per-kind relPath lists for the load_skill summary (SKILL.md is the body, not listed). */
function mcpBundleSummary(bundle: BundleEntry[]): McpSkillDetail["bundle"] {
  const scripts: string[] = [];
  const references: string[] = [];
  const assets: string[] = [];
  for (const e of bundle) {
    if (e.kind === "script") scripts.push(e.relPath);
    else if (e.kind === "reference") references.push(e.relPath);
    else if (e.kind === "asset") assets.push(e.relPath);
  }
  return { scripts, references, assets };
}

/** Resolve an id-OR-slug within the mcp-enabled pool (id preferred — unique — then slug). The MCP surface
 *  only ever sees skills enabled for mcp (the §6 hard pre-filter), so a non-mcp skill is never loadable/runnable. */
function findMcpEntry(ctx: RouteContext, idOrSlug: string): ManifestSkillEntry | undefined {
  const pool = ctx.persistence.store.list({ target: "mcp", enabledOnly: true });
  return pool.find((e) => e.id === idOrSlug) ?? pool.find((e) => e.slug === idOrSlug);
}

/** Map runSkillGated's JsonResponse into the MCP run outcome shape (the daemon gate is the source of truth;
 *  we never re-implement it). dryRun is read from the STRUCTURED ExecResult.dryRun flag the authoritative gate
 *  sets (core/exec/run.ts) — NOT sniffed from exit/stderr. Sniffing was unsound: a real (side-effecting) run
 *  that dies from a signal (exit:null), writes no stdout, and prints child-controlled "dry-run…" to stderr
 *  would be falsely reported as a harmless dry-run. Every refusal becomes a NAMED McpRefusalReason —
 *  RunSkillRefusal["reason"] ⊆ McpRefusalReason (incl. bad-args + suppressed). Exported for the mapping test. */
export function mapMcpRunResponse(resp: JsonResponse, entry: ManifestSkillEntry): McpRunOutcome {
  if (resp.status === 200) {
    const r = resp.body as RunSkillResult;
    const dryRun = r.dryRun === true;
    return { ok: true, result: r, dryRun };
  }
  const body = (resp.body ?? {}) as {
    error?: string;
    reason?: string;
    message?: string;
    detail?: string;
    grantedHash?: string;
    currentHash?: string;
  };
  if (body.error === "exec-refused" && typeof body.reason === "string") {
    const out: Extract<McpRunOutcome, { ok: false }> = {
      ok: false,
      reason: body.reason as McpRefusalReason,
      // surface the structured `detail` when present (C4: distinguishes the owner-mute from a conversation
      // suppression — both are reason `suppressed`); fall back to the reason name otherwise.
      detail: typeof body.detail === "string" ? body.detail : `run refused: ${body.reason}`,
    };
    if (body.grantedHash !== undefined) out.grantedHash = body.grantedHash;
    if (body.currentHash !== undefined) out.currentHash = body.currentHash;
    return out;
  }
  if (body.error === "script-required") return { ok: false, reason: "bad-args", detail: "a script relPath is required" };
  if (body.error === "not-found") return { ok: false, reason: "not-found", detail: `no skill with id ${JSON.stringify(entry.id)}` };
  // exec-failed / audit-failed (500): core's own durable-audit append failed — fail closed, visibly.
  return { ok: false, reason: "audit-failed", detail: body.message ?? body.error ?? `unexpected run response (status ${resp.status})` };
}

/** Build the live-daemon McpServerDeps over the route context (see the block comment above). */
function createDaemonMcpDeps(ctx: RouteContext): McpServerDeps {
  return {
    version: SERVER_VERSION,

    listSkills(query?: string): McpMenuItem[] {
      const entries = ctx.persistence.store.list({ target: "mcp", enabledOnly: true });
      let pool = entries;
      if (query && query.trim() !== "") {
        // optional core-lexical RE-ORDER (host-driven, R1-B2): the host still picks — never narrowed to one.
        const manifests = entries.map((e) => toRoutingManifest(e, readInstructions(ctx.home, e.dir)));
        const order = new Map(buildLexicalIndex(manifests).rank(query).map((m, i) => [m.slug, i]));
        pool = [...entries].sort((a, b) => (order.get(a.slug) ?? Infinity) - (order.get(b.slug) ?? Infinity));
      }
      return pool.map((e) => ({ id: e.id, slug: e.slug, name: e.name, description: e.description }));
    },

    loadSkill(idOrSlug: string): McpSkillDetail | undefined {
      const entry = findMcpEntry(ctx, idOrSlug);
      if (!entry) return undefined;
      const detail: McpSkillDetail = {
        id: entry.id,
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        instructions: readInstructions(ctx.home, entry.dir), // "" when unreadable (rankable on metadata alone)
        execAllowed: entry.execAllowed === true,
        bundle: mcpBundleSummary(entry.bundle),
      };
      if (entry.capabilities) detail.capabilities = entry.capabilities;
      if (entry.mcpRunMuted) detail.mcpRunMuted = true; // C4: a humble heads-up so the host expects the refusal
      return detail;
    },

    // C4: the MCP run tool carries NO conversationId — a host-supplied conversation scope would be a
    // forgeable, rotatable client input. MCP run-gating is the NON-ROTATABLE owner mute (mcpRunMuted),
    // enforced inside runSkillGated. So the RunSkillRequest built here NEVER sets conversationId; the
    // conversation-suppression step remains for the TRUSTED first-party inject runtime (plugin/proxy) only.
    async runScript(idOrSlug: string, script: string, args: string[]): Promise<McpRunOutcome> {
      const entry = findMcpEntry(ctx, idOrSlug);
      if (!entry) {
        // ops symmetry (never-silent): an unknown id is an audited, observable refusal — like the daemon route.
        try {
          auditExec(ctx, refusalLine("(unknown)", idOrSlug, `refusing to run: no mcp skill ${JSON.stringify(idOrSlug)}`, "", "mcp"));
        } catch (e) {
          if (e instanceof AuditAppendError) return { ok: false, reason: "audit-failed", detail: e.message };
          throw e;
        }
        return { ok: false, reason: "not-found", detail: `no mcp-enabled skill matches ${JSON.stringify(idOrSlug)}` };
      }
      const body: RunSkillRequest = { script, args, target: "mcp" };
      let resp: JsonResponse;
      try {
        resp = await runSkillGated(ctx, entry.id, body, "mcp");
      } catch (e) {
        // a guardrail audit line we could not durably record FAILS CLOSED (never-silent) — same as handleRunSkill.
        if (e instanceof AuditAppendError) return { ok: false, reason: "audit-failed", detail: e.message };
        throw e;
      }
      return mapMcpRunResponse(resp, entry);
    },

    listResources(): McpResource[] {
      const out: McpResource[] = [];
      for (const entry of ctx.persistence.store.list({ target: "mcp", enabledOnly: true })) {
        for (const b of entry.bundle) {
          if (b.kind !== "reference") continue;
          out.push({
            uri: `${MCP_RESOURCE_SCHEME}${entry.slug}/${b.relPath}`,
            name: `${entry.slug}/${b.relPath}`,
            description: `Reference for skill "${entry.name}"`,
            mimeType: mcpMimeForRelPath(b.relPath),
          });
        }
      }
      return out;
    },

    readResource(uri: string): McpResourceOutcome {
      const parsed = mcpParseResourceUri(uri);
      if (!parsed) return { ok: false, reason: "invalid-uri", detail: `not a ${MCP_RESOURCE_SCHEME}<slug>/<relPath> uri: ${JSON.stringify(uri)}` };
      const entry = findMcpEntry(ctx, parsed.slug);
      if (!entry) return { ok: false, reason: "not-found", detail: `no mcp-enabled skill with slug ${JSON.stringify(parsed.slug)}` };
      // REFERENCES-ONLY surface: a read MUST match an advertised kind==="reference" file. Any OTHER contained
      // file (script/SKILL.md/asset) is a NAMED refusal — never a silent read — even though it would be contained.
      const normRel = parsed.relPath.replace(/\\/g, "/");
      const ref = entry.bundle.find((b) => b.relPath === normRel && b.kind === "reference");
      if (!ref) {
        return { ok: false, reason: "not-a-reference", detail: `${JSON.stringify(parsed.relPath)} is not a reference resource of skill ${JSON.stringify(parsed.slug)}` };
      }
      let abs: string;
      try {
        const skillRoot = resolveUnderRoot(sourcesPath(ctx.home), entry.dir);
        abs = resolveUnderRoot(skillRoot, parsed.relPath); // containment — never escapes home
      } catch (e) {
        if (e instanceof PathEscapeError) return { ok: false, reason: "path-escape", detail: (e as Error).message };
        throw e;
      }
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch (e) {
        return { ok: false, reason: "unreadable", detail: (e as Error).message };
      }
      return { ok: true, contents: { uri, mimeType: mcpMimeForRelPath(parsed.relPath), text } };
    },
  };
}

/** Build the full route table bound to the daemon context. */
export function buildRoutes(ctx: RouteContext): RouteDef[] {
  return [
    // ── health / config ──
    { method: "GET", pattern: "/health", handler: async () => ok(await handleHealth(ctx)) },
    { method: "GET", pattern: "/config", handler: () => ok(ctx.config()) },
    {
      method: "PATCH",
      pattern: "/config",
      handler: (c: ReqCtx) => ok(ctx.patchConfig((c.body ?? {}) as PatchConfigRequest)),
    },

    // ── events (SSE) ──
    {
      method: "GET",
      pattern: "/events",
      raw: true,
      handler: (c: ReqCtx) => {
        const write = openSseStream(c.res);
        let done = false;
        const cleanup = (): void => {
          if (done) return;
          done = true;
          clearInterval(keepAlive);
          unsub();
        };
        // an abnormal socket teardown must clean up, not surface an unhandled 'error' on the stream.
        const unsub = ctx.events.subscribe((ev) => {
          try {
            write(ev.type, ev);
          } catch {
            cleanup();
          }
        });
        const keepAlive = setInterval(() => {
          try {
            c.res.write(": ping\n\n");
          } catch {
            cleanup();
          }
        }, 25_000);
        keepAlive.unref?.();
        c.req.on("close", cleanup);
        c.req.on("error", cleanup);
        c.res.on("error", cleanup);
        return undefined; // socket hijacked
      },
    },

    // ── sources ──
    {
      method: "POST",
      pattern: "/sources/preview",
      handler: async (c: ReqCtx) => {
        const body = (c.body ?? {}) as AddSourceRequest;
        if (typeof body.input !== "string" || body.input.length > MAX_SOURCE_INPUT_LEN) {
          return { status: 400, body: { error: "invalid-input", maxLen: MAX_SOURCE_INPUT_LEN } };
        }
        return ok(await ctx.ingest.previewSource(body.input, body.ref));
      },
    },
    {
      method: "POST",
      pattern: "/sources",
      handler: async (c: ReqCtx) => {
        const body = (c.body ?? {}) as AddSourceRequest;
        if (typeof body.input !== "string" || body.input.length > MAX_SOURCE_INPUT_LEN) {
          return { status: 400, body: { error: "invalid-input", maxLen: MAX_SOURCE_INPUT_LEN } };
        }
        return ok(await ctx.ingest.addSource(body.input, body.ref), 201);
      },
    },
    { method: "GET", pattern: "/sources", handler: () => ok(ctx.ingest.listSources()) },
    {
      method: "DELETE",
      pattern: "/sources/:sourceId",
      handler: (c: ReqCtx) => ok(ctx.ingest.removeSource(c.params.sourceId!) as MutationResult),
    },
    {
      method: "POST",
      pattern: "/sources/:sourceId/resync",
      handler: async (c: ReqCtx) => ok(await ctx.ingest.resyncSource(c.params.sourceId!)),
    },

    // ── skills ──
    { method: "GET", pattern: "/skills", handler: (c: ReqCtx) => ok(ctx.persistence.store.list(parseSkillFilter(c.query))) },
    { method: "GET", pattern: "/skills/:id", handler: (c: ReqCtx) => handleGetSkill(ctx, c.params.id!) },
    {
      method: "POST",
      pattern: "/skills/:id/enabled",
      handler: (c: ReqCtx) => {
        const id = c.params.id!;
        if (!ctx.persistence.store.get(id)) return { status: 404, body: { error: "not-found", id } };
        const body = (c.body ?? {}) as SetEnabledRequest;
        if (body.target !== "lmstudio" && body.target !== "mcp" && body.target !== "proxy") {
          return { status: 400, body: { error: "invalid-target" } };
        }
        ctx.persistence.store.setEnabled(id, body.target, !!body.on);
        const model = ctx.persistence.publishManifest();
        return ok({ seq: model.seq } as MutationResult);
      },
    },

    // ── route-test ──
    {
      method: "POST",
      pattern: "/route-test",
      handler: async (c: ReqCtx) => {
        const body = (c.body ?? {}) as RouteTestRequest;
        if (body.target !== "lmstudio" && body.target !== "mcp" && body.target !== "proxy") {
          return { status: 400, body: { error: "invalid-target" } };
        }
        if (!Array.isArray(body.messages)) return { status: 400, body: { error: "messages-required" } };
        return ok(await handleRouteTest(ctx, body));
      },
    },

    // ── activity ──
    { method: "GET", pattern: "/activity", handler: (c: ReqCtx) => ok(getActivity(ctx.home, parseActivityQuery(c.query))) },

    // ── W4 exec observability (the 3 moments: inspect / grant / run) ──
    {
      method: "GET",
      pattern: "/skills/:id/file",
      handler: (c: ReqCtx) => handleGetSkillFile(ctx, c.params.id!, c.query.get("relPath")),
    },
    {
      method: "POST",
      pattern: "/skills/:id/exec-allowed",
      handler: (c: ReqCtx) => handleSetExecAllowed(ctx, c.params.id!, (c.body ?? {}) as ExecGrantRequest),
    },
    {
      method: "POST",
      pattern: "/skills/:id/mcp-mute",
      handler: (c: ReqCtx) => handleSetMcpRunMute(ctx, c.params.id!, (c.body ?? {}) as McpMuteRequest),
    },
    {
      method: "POST",
      pattern: "/skills/:id/run",
      handler: (c: ReqCtx) => handleRunSkill(ctx, c.params.id!, (c.body ?? {}) as RunSkillRequest),
    },
    {
      method: "POST",
      pattern: "/conversations/:conversationId/suppress",
      handler: (c: ReqCtx) => handleSuppress(ctx, c.params.conversationId!, (c.body ?? {}) as SuppressRequest),
    },

    // ── Wave B: OpenAI-compat PROXY (the third inject-based target) — POST /v1/chat/completions (+SSE) and
    //    POST /v1/embeddings. raw:true ⇒ the daemon does NOT pre-read the body (http.ts), so the proxy's own
    //    10MB chat cap applies (not the daemon's 1MB control cap). Chat upstream = config.upstreams.proxy
    //    .chatBaseUrl; embeddings passthrough = config.embeddings. select.log is the proxy's never-silent
    //    routing trace (mirrors the standalone proxy + the plugin's inject.log). Behind the admission gate. ──
    ...proxyRoutes({
      home: ctx.home,
      config: ctx.config,
      logSelect: (line: SelectLogLine) => appendSelectLog(ctx.home, line),
      ...(ctx.embedFetch ? { embedFetch: ctx.embedFetch } : {}),
    }),

    // ── Wave B: MCP over Streamable HTTP — POST /mcp, served by the SAME dispatcher the stdio bin uses but
    //    over LIVE daemon deps (store + the runSkillGated gate). The route is NOT raw, so the daemon pre-parses
    //    + bounds the JSON-RPC body and the handler sees ctx.body. Behind the admission gate (a non-local
    //    Host/Origin is 403'd before the handler runs). ──
    ...createMcpHttpHandler(createDaemonMcpDeps(ctx)),

    // ── static console (W5) — the @skillforge/ui web/ SPA, served single-origin. MOUNTED LAST so every
    //    API path above is matched first and the static catch-all can never shadow a daemon route. ──
    ...staticRoutes(ctx.webDir),
  ];
}

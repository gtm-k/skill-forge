// @skillforge/lmstudio/select-inject — the HEADLESS core of the LM Studio plugin (PLAN §4.1, A0-A/D5/D11).
//
// This is the runtime half of the magic moment, with ZERO LM Studio SDK coupling (so it is fully
// testable offline). It REUSES @skillforge/core for every load-bearing step — selectWithEscalation (the
// ONE semantic-primary cascade, D26 — the SAME unit the daemon's route-test + runtime call, so the plugin
// and the daemon can never diverge on a partial corpus, W6) and buildInjection (the channel-agnostic
// content builder, BOUNDARY 3) — and adds only the things core deliberately refuses to hold: reading the
// CLI read-model, the best-effort query embedder (adapted to core's EmbedFn), and the self-verifying log.
//
// CHANNEL = user-turn-rewrite (PERSISTED). LM Studio's prompt preprocessor lets us rewrite the user's
// turn before it is saved to the conversation, so the injected skill block lands as `<block>\n\n<the
// user's text>` and STAYS in the transcript across turns. That persistence is exactly why step (5) below
// guards against re-injecting the same full body every turn (R1-B1) — it would otherwise compound.
//
// BOUNDARY SEPARATION: buildInjection decides WHAT to inject (content + measured bytes) — that decision
// is what we log (inject-log records the channel-agnostic injection record). The sticky `reInjected`
// flag is the channel-SPECIFIC PLACEMENT decision (re-inject the persisted body or not) and is returned
// to the adapter, never folded into core's content decision.
import {
  buildInjection,
  buildLexicalIndex,
  createEmbeddingIndex,
  selectWithEscalation,
  EmbeddingsUnavailable,
  sha256,
} from "@skillforge/core";
import type { EmbedFn, EmbeddingIndex } from "@skillforge/core";
import type {
  InjectionContent,
  InjectionPolicy,
  Selection,
  SkillManifest,
  TargetId,
} from "@skillforge/contracts";
import type { SkillRecord } from "@skillforge/contracts/api";
import { loadCatalog, loadInstructions } from "./read-model.ts";
import { lmStudioQueryEmbedder, type QueryEmbedder } from "./embed.ts";
import { appendInjectLog, type InjectLogLine } from "./inject-log.ts";

/** A minimal chat message. Only role + content matter; the LAST `role:"user"` message is the query. */
export interface ChatMsg {
  role: string;
  content: string;
}

export interface SelectInjectOpts {
  home: string;
  messages: ChatMsg[];
  target?: TargetId;
  /**
   * query embedder. `undefined` → the real LM Studio query embedder (degrades to lexical if down).
   * `null` → embeddings explicitly OFF (lexical+explicit only — used by the hermetic parity tests).
   * A function → use it (a fake in tests; may itself resolve `undefined` to simulate the endpoint down).
   */
  embed?: QueryEmbedder | null;
  /** per-target/per-model overrides; defaults: maxTokens 2000, menuOnAmbiguous true, maxMenuItems 5. */
  policy?: Partial<InjectionPolicy>;
  /** the slug injected on the previous turn in THIS conversation — drives the sticky no-recompound guard. */
  previousSlug?: string;
}

export interface SelectInjectResult {
  selection: Selection;
  injection: InjectionContent;
  /** the persisted user-turn rewrite (`<block>\n\n<original>`), or null when nothing is placed this turn. */
  rewrittenLastUserMessage: string | null;
  logLine: InjectLogLine;
  /** PLACEMENT decision: did we actually inject content into the user turn this turn? */
  reInjected: boolean;
  /**
   * The slug to remember as `previousSlug` for the NEXT turn. It advances ONLY on a FULL placement and
   * carries the prior value forward on menu/none turns — so a menu turn can never poison the sticky store
   * and suppress the real full-body injection later. The adapter stores this verbatim, keeping the sticky
   * decision in this tested layer rather than in the untested SDK glue.
   */
  nextStickySlug: string | null;
  /** non-fatal degradations this turn (e.g. an unreadable/unsafe chosen body) — surfaced, never silent. */
  warnings: string[];
}

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_MAX_MENU_ITEMS = 5;

/** The LAST `role:"user"` message is the query (explicit `$slug` lives inside it). "" when none. */
function lastUserMessage(messages: ChatMsg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content ?? "";
  }
  return "";
}

/**
 * Route the chat to a skill and produce the user-turn rewrite. Deterministic given (read-model snapshot,
 * messages, embedder). Always returns a result + appends exactly one inject-log line — even on a no-match
 * (the log records that nothing fired, slug null), so every turn is accounted for.
 */
export async function selectAndInject(opts: SelectInjectOpts): Promise<SelectInjectResult> {
  const target: TargetId = opts.target ?? "lmstudio";
  const catalog = loadCatalog(opts.home, target);
  const query = lastUserMessage(opts.messages);

  // (2) SEMANTIC-PRIMARY escalation (D26) — the SAME @skillforge/core cascade the daemon's route-test +
  // runtime run, so "what you see in Test is what fires". Tier-2 is engaged when embeddings are not
  // explicitly OFF (`embed:null`), the catalog is non-empty, and there is a query to embed. We do NOT
  // re-implement the firing decision here: the old plugin had a bespoke ALL-OR-NOTHING gate (every skill
  // needed a vector or the whole turn fell back to lexical), which DIVERGED from the daemon on a
  // partially-embedded corpus — the §6 "what you see in Test is NOT what fires" gap. Delegating to
  // selectWithEscalation closes it: one cascade, one operating point, identical on a partial corpus.
  const semanticOn = opts.embed !== null && catalog.skills.length > 0 && query !== "";

  let embeddingIndex: EmbeddingIndex | undefined;
  let embedFn: EmbedFn | undefined;
  if (semanticOn) {
    // Vectors keyed by contentHash with the daemon's EXACT dim/finite validation (createEmbeddingIndex):
    // an un-embedded skill becomes cosine 0, it does NOT collapse the whole turn to lexical. The index
    // reads only id/contentHash/embedding off each record — all carried by the routing manifest — so the
    // routing manifests stand in for SkillRecord directly (the unused SkillRecord fields are never read).
    const idx = createEmbeddingIndex(catalog.embeddingDim ? { dim: catalog.embeddingDim } : {});
    await idx.ensure(catalog.skills as unknown as SkillRecord[]);
    embeddingIndex = idx;

    // Adapt the best-effort QueryEmbedder (number[] | undefined) to core's EmbedFn (Float32Array, throws
    // EmbeddingsUnavailable): a down endpoint surfaces as a VISIBLE tierDisabled degradation inside the
    // single cascade, never a throw into the turn (the inject log still records the firing tier).
    const queryEmbed = opts.embed ?? lmStudioQueryEmbedder();
    embedFn = async (q: string): Promise<Float32Array> => {
      const vec = await queryEmbed(q);
      if (vec === undefined) {
        throw new EmbeddingsUnavailable("LM Studio embeddings endpoint unavailable (query embed returned no vector)");
      }
      return Float32Array.from(vec);
    };
  }

  // (3) the ONE routing decision (D3/D26) — the semantic-primary cascade, never reimplemented here.
  const lexIndex = buildLexicalIndex(catalog.skills);
  const escalated = await selectWithEscalation(query, {
    skills: catalog.skills,
    lexIndex,
    ...(embeddingIndex ? { embeddingIndex } : {}),
    ...(embedFn ? { embedFn } : {}),
  });
  const sel = escalated.selection;

  // (4) lazily load the SKILL.md body for the CHOSEN skill ONLY — that is the only body buildInjection
  // ever renders (a menu shows names+descriptions, already on the manifest; candidate bodies are never
  // used). The load is GUARDED: a corrupt/unsafe skill dir (traversal/symlink) must NOT abort the turn or
  // skip the inject-log (never-silent / D11) — it degrades to a header-only injection with a warning.
  const warnings: string[] = [];
  // never-silent (M-embed): Tier-2 was engaged this turn but could not run (endpoint down) — surface the
  // degradation. A deliberately-OFF embedder (embed:null) is not a degradation, so it is not surfaced. The
  // firing tier is ALSO recorded in the inject log below, so this is observable in two places.
  if (semanticOn && escalated.tierDisabled) {
    warnings.push(`semantic tier unavailable (${escalated.tierDisabled.reason}) — routed on lexical+explicit only`);
  } else if (semanticOn && embeddingIndex && embeddingIndex.vectors.size === 0) {
    // semantic was requested but the read-model carries NO stored embeddings, so escalation could only
    // route on lexical+explicit. escalate treats an empty index as "not a degradation" (the provider is
    // fine — nothing to rank), but from the runtime's view the user asked for semantic and got lexical;
    // surface it so the gap is observable (re-ingest with an embeddings provider to populate vectors).
    warnings.push("semantic tier requested but the read-model has no stored embeddings — routed on lexical+explicit only (re-ingest with an embeddings provider)");
  }
  const skillsWithBody: SkillManifest[] = catalog.skills.map((s) => {
    if (!sel.chosen || s.slug !== sel.chosen.slug) return s;
    const dir = catalog.dirBySlug.get(s.slug);
    if (dir === undefined) return s;
    try {
      const instructions = loadInstructions(opts.home, dir);
      return { ...s, instructions, bodyLen: instructions.length, tokenEstimate: Math.ceil(instructions.length / 4) };
    } catch (e) {
      // an unreadable/unsafe chosen body degrades the injection but never fails the turn or the log.
      warnings.push(`could not load body for ${JSON.stringify(s.slug)} (${(e as Error).message}) — degraded injection`);
      return s;
    }
  });

  const policy: InjectionPolicy = {
    maxTokens: opts.policy?.maxTokens ?? DEFAULT_MAX_TOKENS,
    menuOnAmbiguous: opts.policy?.menuOnAmbiguous ?? true,
    maxMenuItems: opts.policy?.maxMenuItems ?? DEFAULT_MAX_MENU_ITEMS,
  };
  const injection = buildInjection(sel, skillsWithBody, policy);

  // (5) STICKY re-eval (R1-B1). The user-turn rewrite is PERSISTED, so the SAME full body re-injected
  // every turn would compound. If the confidently-chosen full skill is the one we already injected last
  // turn (previousSlug), suppress the placement — the body is already in the transcript. Otherwise place
  // it (when there is anything to place). reInjected ⟺ a rewrite was produced this turn.
  const topSlug: string | null = injection.injectedSlugs[0] ?? null;
  let reInjected: boolean;
  let rewrittenLastUserMessage: string | null;
  if (topSlug !== null && topSlug === opts.previousSlug && injection.disclosure === "full") {
    reInjected = false;
    rewrittenLastUserMessage = null;
  } else if (injection.disclosure !== "none") {
    reInjected = true;
    rewrittenLastUserMessage = `${injection.text}\n\n${query}`;
  } else {
    reInjected = false;
    rewrittenLastUserMessage = null;
  }

  // The slug whose FULL body is now in the transcript. It advances ONLY on a full placement and carries
  // the prior value forward on menu/none turns — so a menu turn cannot poison the sticky store and cause
  // core's full-only guard to suppress the real full-body injection on the turn the user commits.
  const nextStickySlug: string | null = injection.disclosure === "full" ? topSlug : (opts.previousSlug ?? null);

  // (6) the self-verifying hand-off record (D11): byte+len of the injection CONTENT decision, the firing
  // tier and the selection reasons. traceId ties the line to (query, home) without storing the raw text.
  const logLine: InjectLogLine = {
    ts: new Date().toISOString(),
    traceId: sha256(query + opts.home).slice(0, 12),
    slug: topSlug,
    disclosure: injection.disclosure,
    injectedBytes: injection.injectedBytes,
    injectedLen: injection.text.length,
    tier: sel.mode,
    reasons: sel.chosen?.reasons ?? [],
  };
  appendInjectLog(opts.home, logLine);

  return { selection: sel, injection, rewrittenLastUserMessage, logLine, reInjected, nextStickySlug, warnings };
}

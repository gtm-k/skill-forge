// @skillforge/core/index/escalate — Tier-0/1 → Tier-2 escalation (PLAN §6, A0-A, D21).
//
// This is the unit the daemon (W1) calls per message; `select.ts` itself stays PURE (no embedFn, no
// I/O). It is ONE cascade with a single operating point: when an embeddings provider is configured and
// the query is not explicit, it ALWAYS runs the existing SEMANTIC-PRIMARY `tieredSelect` (D21 — semantic
// 93% > lexical 77%). It deliberately does NOT add a separate "confident-lexical fires" short-circuit:
// that would be a second cascade with a divergent operating point the golden harness never exercises.
// By delegating the firing decision wholly to `tieredSelect`, the daemon's routing == the golden-tested
// selector. NOTE: this supersedes §6's "embed only when Tier-1 margin is below threshold" lazy trigger
// for the daemon path (see W3 notes) — semantic-primary correctness over an embed-call optimization.
//
// escalate's only responsibilities are: (1) fetch the query embedding, (2) assemble the aligned
// per-skill vectors from the index, (3) surface `tierDisabled` whenever Tier-2 WOULD run but cannot —
// the provider is unreachable (EmbeddingsUnavailable) OR not configured at all (M-embed: a VISIBLE
// degradation, never a silent downgrade), and (4) short-circuit with no network call when there is
// nothing to rank semantically. Any non-EmbeddingsUnavailable error propagates (never swallowed).
//
// ENABLED-POOL CONTRACT (§6 hard structural pre-filter): `skills` AND `lexIndex` are the per-target
// ENABLED pool — the caller builds both from the same filtered set. The EmbeddingIndex may hold a
// SUPERSET (it is ensured over the whole catalog); escalate ranks ONLY the skills in `inp.skills`
// (vectors are pulled by contentHash for those skills alone), so a disabled skill never fires here.

import { tieredSelect, type LexicalIndex } from "../select.ts";
import type { Selection, SkillManifest } from "@skillforge/contracts";
import type { EmbeddingIndex } from "./embedding-index.ts";
import { EmbeddingsUnavailable, type EmbedFn } from "./embed-provider.ts";

export interface EscalateInputs {
  /** the per-target ENABLED pool (already pre-filtered by the caller — §6 hard structural pre-filter). */
  skills: SkillManifest[];
  lexIndex: LexicalIndex;
  /** Tier-2 store (vectors keyed by contentHash; may hold a superset of `skills`). */
  embeddingIndex?: EmbeddingIndex;
  /** query embedder. Absent (with a non-explicit query) ⇒ Tier-2 is configured-off ⇒ visible degradation. */
  embedFn?: EmbedFn;
}

export interface EscalateResult {
  selection: Selection;
  /** present when Tier-2 WOULD have run but could not — provider unreachable or not configured (M-embed). */
  tierDisabled?: { tier: "semantic"; reason: string };
}

const EMPTY = new Float32Array(0);

export async function selectWithEscalation(query: string, inp: EscalateInputs): Promise<EscalateResult> {
  // Tier 0/1 — explicit + lexical, no vectors. This is the fallback selection and decides "explicit".
  const base = tieredSelect(query, { skills: inp.skills, lexIndex: inp.lexIndex });

  // Tier-0 explicit ($slug) is the deterministic override — it always wins and never embeds.
  if (base.mode === "explicit") return { selection: base };

  // Nothing to route at all — semantic is moot, not a degradation.
  if (inp.skills.length === 0) return { selection: base };

  // Provider not configured but a non-explicit query WOULD have run semantic → VISIBLE degradation.
  if (!inp.embedFn || !inp.embeddingIndex) {
    return { selection: base, tierDisabled: { tier: "semantic", reason: "no embeddings provider configured" } };
  }

  // Provider configured but the index holds no vectors for this catalog — semantic can add nothing.
  // Skip the per-message embed round-trip (it is not a degradation: the provider is fine).
  if (inp.embeddingIndex.vectors.size === 0) return { selection: base };

  // Tier 2 — embed the query (a visible failure on an unreachable/misconfigured provider).
  let queryVec: Float32Array;
  try {
    queryVec = await inp.embedFn(query);
  } catch (e) {
    if (e instanceof EmbeddingsUnavailable) {
      return { selection: base, tierDisabled: { tier: "semantic", reason: e.reason } };
    }
    throw e; // never swallow an unexpected error
  }

  // Align per-skill vectors to the `skills` array order (tieredSelect's semantic-primary contract),
  // pulling the CACHED Float32Arrays from the index by contentHash — no per-query number[] copy (D13).
  // A skill without an indexed vector → empty vector → cosine 0.
  const idx = inp.embeddingIndex;
  const skillVecs: ArrayLike<number>[] = inp.skills.map((s) =>
    (s.contentHash ? idx.vectors.get(s.contentHash) : undefined) ?? EMPTY,
  );

  // ONE cascade: hand the query embedding + aligned vectors to the existing semantic-primary selector.
  const selection = tieredSelect(query, {
    skills: inp.skills,
    lexIndex: inp.lexIndex,
    queryVec,
    skillVecs,
  });
  return { selection };
}

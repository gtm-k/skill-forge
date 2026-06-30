// @skillforge/core/select — the ONE routing decision (D3). Deterministic given
// (skills snapshot, query, optional embeddings). Tiered cascade: explicit -> lexical -> semantic.
// "Inject nothing" (mode: "none") is first-class — a wrong skill is worse than none.

import { ROUTING, type Selection, type SkillMatch, type SkillManifest } from "@skillforge/contracts";

const STOP = new Set(
  "a an the of to and or for with in on this that you your i we use using used when should must any all be is are it its as my me how do".split(" "),
);
export function tokenize(t: string): string[] {
  return (t.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

// ---- lexical (BM25) ----
export interface LexicalIndex {
  rank(query: string): SkillMatch[];
}
export function buildLexicalIndex(skills: SkillManifest[], k1 = 1.5, b = 0.75): LexicalIndex {
  const docs = skills.map((s) => ({ slug: s.slug, id: s.id, toks: tokenize(`${s.name} ${s.description}`) }));
  const N = docs.length || 1;
  const avgdl = docs.reduce((a, d) => a + d.toks.length, 0) / N;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d.toks)) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
  return {
    rank(query: string): SkillMatch[] {
      const q = new Set(tokenize(query));
      return docs
        .map((d) => {
          const tf = new Map<string, number>();
          for (const w of d.toks) tf.set(w, (tf.get(w) ?? 0) + 1);
          let score = 0;
          const hits: string[] = [];
          for (const w of q) {
            const f = tf.get(w);
            if (f) {
              score += idf(w) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.toks.length / avgdl));
              hits.push(w);
            }
          }
          return { slug: d.slug, id: d.id, score, tier: "lexical" as const, reasons: hits.length ? [`lexical hits: ${hits.join(", ")}`] : [] };
        })
        .sort((x, y) => y.score - x.score);
    },
  };
}

// ---- semantic ----
// Accepts number[] or Float32Array (the EmbeddingIndex stores vectors as Float32Array — D13).
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] ?? 0, y = b[i] ?? 0; dot += x * y; na += x * x; nb += y * y; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
export function semanticRank(queryVec: ArrayLike<number>, skills: SkillManifest[], skillVecs: ArrayLike<number>[]): SkillMatch[] {
  return skills
    .map((s, i) => ({ slug: s.slug, id: s.id, score: cosine(queryVec, skillVecs[i] ?? []), tier: "semantic" as const, reasons: ["semantic cosine"] }))
    .sort((x, y) => y.score - x.score);
}

export interface SelectInputs {
  skills: SkillManifest[];
  lexIndex: LexicalIndex;
  /** optional semantic tier (A0-A): query embedding + per-skill vectors aligned to `skills`.
   *  ArrayLike so the EmbeddingIndex's cached Float32Array passes through with no per-query copy (D13). */
  queryVec?: ArrayLike<number>;
  skillVecs?: ArrayLike<number>[];
}

/**
 * Resolve a ranked tier into a Selection. Distinguishes (D17):
 *  - EMPTY pool (no candidates ran) → mode "none", `belowThreshold: false`.
 *  - a tier RAN but its top scored below θ → mode "none", `belowThreshold: true` (the "inject nothing
 *    because nothing cleared the gate" signal — distinct from there being nothing to inject at all).
 *  - top cleared θ → the firing tier's mode + chosen.
 */
function finalize(ranked: SkillMatch[], mode: "lexical" | "semantic", threshold: number): Selection {
  const top = ranked[0];
  const candidates = ranked.slice(0, 3);
  if (!top) return { mode: "none", candidates, ambiguous: false, belowThreshold: false };
  // Gate polarity is `!(score >= θ)`, NOT `score < θ`: for a non-finite score (NaN from a corrupt
  // embedding) `NaN < θ` is FALSE — which would wrongly FIRE a confident match (§6 "worse than none").
  // `!(NaN >= θ)` is TRUE, so a non-finite top falls through to "nothing cleared the gate".
  if (!(top.score >= threshold)) return { mode: "none", candidates, ambiguous: false, belowThreshold: true };
  const second = ranked[1];
  const ambiguous = !!second && top.score - second.score < ROUTING.ambiguityEpsilon;
  return { mode, chosen: top, candidates, ambiguous, belowThreshold: false };
}

const RRF_K = 60; // standard reciprocal-rank-fusion constant

/**
 * The cascade. Explicit -> (lexical-only) OR (lexical+semantic fused via RRF when embeddings
 * are available, per plan §6 / A0-A). Returns mode "none" when nothing clears its gate —
 * a confidently-wrong lexical hit must NOT short-circuit a better semantic match.
 */
export function tieredSelect(query: string, inp: SelectInputs): Selection {
  // Tier 0 — explicit ($slug) always wins.
  const explicit = query.match(/\$([a-z0-9][a-z0-9-]*)/)?.[1];
  if (explicit) {
    const s = inp.skills.find((x) => x.slug === explicit);
    if (s) return { mode: "explicit", chosen: { slug: s.slug, id: s.id, score: 1, tier: "explicit", reasons: [`explicit $${explicit}`] }, candidates: [], ambiguous: false, belowThreshold: false };
  }

  const lex = inp.lexIndex.rank(query);
  const lexScore = new Map(lex.map((m) => [m.slug, m.score]));

  // Tier 1 only — no embeddings available.
  if (!inp.queryVec || !inp.skillVecs) {
    return finalize(lex, "lexical", ROUTING.lexicalFireThreshold);
  }

  // Tier 1 + Tier 2 — SEMANTIC-PRIMARY. Spike A0: semantic 93% >> lexical 77%, and equal-weight
  // RRF dilutes that edge (a confident-wrong lexical #1 wins on the 1/60 term). So rank by semantic
  // cosine; gate on the semantic threshold; break near-ties (top-2 within epsilon) with lexical,
  // which is where concrete-noun precision lives. Lexical-confident concrete queries can still fire
  // if semantic stays below its gate.
  const sem = semanticRank(inp.queryVec, inp.skills, inp.skillVecs);
  const top = sem[0];
  const second = sem[1];

  if (!top || !(top.score >= ROUTING.semanticFireThreshold)) {
    // semantic didn't clear its gate (incl. a non-finite cosine from a corrupt vector — see finalize)
    // — fall back to a confident lexical hit, else nothing.
    const lexSel = finalize(lex, "lexical", ROUTING.lexicalFireThreshold);
    if (lexSel.mode === "lexical") return lexSel;
    // Neither tier cleared θ. belowThreshold iff a tier actually RAN (had candidates) — distinct from
    // an empty pool. Show the semantic-primary candidates when present (the primary tier here).
    const ran = sem.length > 0 || lex.length > 0;
    return { mode: "none", candidates: (sem.length ? sem : lex).slice(0, 3), ambiguous: false, belowThreshold: ran };
  }

  let chosen = top;
  const ambiguous = !!second && top.score - second.score < ROUTING.ambiguityEpsilon;
  if (ambiguous && second && (lexScore.get(second.slug) ?? 0) > (lexScore.get(top.slug) ?? 0)) {
    chosen = second; // lexical breaks the semantic near-tie
  }
  return {
    mode: "semantic",
    chosen: { ...chosen, reasons: [`cos=${chosen.score.toFixed(2)}${ambiguous ? "; lexical tiebreak vs " + (chosen === top ? second?.slug : top.slug) : ""}`] },
    candidates: sem.slice(0, 3),
    ambiguous,
    belowThreshold: false,
  };
}

// @skillforge/core/index/embedding-index — the Tier-2 semantic store (PLAN §3 EmbeddingIndex).
//
// D13: NO vector DB. Brute-force cosine over in-memory `Float32Array` vectors keyed by `contentHash`
// (the embed-cache key — identical content ⇒ identical vector, so the cache is valid by construction).
// Vectors are computed at CLI ingest (A0-A) and carried on each record's `embedding`; `ensure` only
// converts + caches them (it does NOT embed — that is the CLI's job / the query's job via EmbedFn).
// Zero deps, node built-ins only.

import { cosine } from "../select.ts";
import type { ScoredId, SkillFilter, SkillRecord } from "@skillforge/contracts/api";

/** A scorable record reference kept after `ensure`: identity + the per-target enable pool + the
 *  contentHash that keys its cached vector. Lightweight (no instructions/bundle). */
interface IndexedRef {
  id: string;
  contentHash: string;
  enabledFor: SkillRecord["enabledFor"];
  /** retained so a `SkillFilter.q` substring narrows the same way the lexical/list path does. */
  haystack: string;
}

/** A stored vector the last `ensure` REJECTED — its dim drifted from the expected dim (model drift) or
 *  it carried non-finite values. Surfaced (never silently ranked) so the daemon/UI can flag it. */
export interface IndexMismatch {
  id: string;
  contentHash: string;
  got: number; // the stored vector's length
  expected: number; // the expected dim (configured or inferred from the first scorable vector)
  reason: "dim" | "non-finite";
}

export interface EmbeddingIndex {
  /** Build/cache per-skill vectors from precomputed `record.embedding`, keyed by contentHash (D13).
   *  Re-running with the same contentHash is a CACHE HIT — the Float32Array is reused, not rebuilt.
   *  A stored vector whose dim drifts from the expected dim, or that holds non-finite values, is
   *  SKIPPED and recorded in `mismatched` (a truncated/zero-padded vector would silently corrupt cosine). */
  ensure(skills: SkillRecord[]): Promise<void>;
  /** Brute-force cosine of `queryVec` against the enabled pool → ScoredId[] sorted by score desc
   *  (ties broken by id asc for determinism), truncated to topK. Honors the SkillFilter (enabled pool). */
  query(queryVec: Float32Array, topK: number, filter?: SkillFilter): ScoredId[];
  /** The contentHash→vector cache (D13). Readonly accessor: escalation aligns per-skill vectors by
   *  contentHash through this, and tests verify cache-hit by reference identity. */
  readonly vectors: ReadonlyMap<string, Float32Array>;
  /** Vectors rejected by the last `ensure` (dim drift / non-finite) — observable, never silent. */
  readonly mismatched: ReadonlyArray<IndexMismatch>;
}

function matchesFilter(ref: IndexedRef, filter?: SkillFilter): boolean {
  if (!filter) return true;
  if (filter.enabledOnly) {
    const ef = ref.enabledFor ?? {};
    // enabled pool: scoped to `target` when given, else "enabled for ANY target".
    if (filter.target) {
      if (ef[filter.target] !== true) return false;
    } else if (!Object.values(ef).some(Boolean)) {
      return false;
    }
  }
  if (filter.q && !ref.haystack.includes(filter.q.toLowerCase())) return false;
  return true;
}

/** Create an EmbeddingIndex. The vector cache survives across `ensure` calls so re-ingesting an
 *  unchanged skill (same contentHash) never rebuilds its Float32Array (cache-hit). Pass `dim` (e.g. the
 *  manifest's embeddingDim / provider.dim) to validate stored vectors against a known dimension; if
 *  omitted it is inferred from the first scorable vector. */
export function createEmbeddingIndex(opts: { dim?: number } = {}): EmbeddingIndex {
  const vectors = new Map<string, Float32Array>();
  let refs: IndexedRef[] = [];
  let mismatched: IndexMismatch[] = [];

  return {
    vectors,
    get mismatched() {
      return mismatched;
    },

    async ensure(skills: SkillRecord[]): Promise<void> {
      const next: IndexedRef[] = [];
      const flagged: IndexMismatch[] = [];
      let dim = opts.dim; // expected dim: configured, else inferred from the first scorable vector
      for (const s of skills) {
        const hash = s.contentHash;
        const emb = s.embedding;
        // Only records with a contentHash + a non-empty embedding are scorable.
        if (!s.id || !hash || !emb || emb.length === 0) continue;
        if (dim === undefined) dim = emb.length;
        // Dim drift (model change) would silently corrupt cosine (which zero-pads the shorter vector).
        if (emb.length !== dim) {
          flagged.push({ id: s.id, contentHash: hash, got: emb.length, expected: dim, reason: "dim" });
          continue;
        }
        // A non-finite stored element (NaN/Inf) defeats the fire-gate downstream — skip it.
        if (!emb.every((x) => Number.isFinite(x))) {
          flagged.push({ id: s.id, contentHash: hash, got: emb.length, expected: dim, reason: "non-finite" });
          continue;
        }
        // Cache-hit on identical content: reuse the existing Float32Array, never rebuild it (D13).
        if (!vectors.has(hash)) vectors.set(hash, Float32Array.from(emb));
        next.push({
          id: s.id,
          contentHash: hash,
          enabledFor: s.enabledFor,
          haystack: `${s.slug} ${s.name} ${s.description}`.toLowerCase(),
        });
      }
      if (flagged.length) {
        // Ops-visible (never silent); `mismatched` is the structured signal the daemon/UI surface.
        console.warn(
          `[skillforge/embedding-index] skipped ${flagged.length} stored vector(s) with dim/finite drift: ` +
            flagged.map((f) => `${f.id}(${f.reason} ${f.got}/${f.expected})`).join(", "),
        );
      }
      refs = next;
      mismatched = flagged;
    },

    query(queryVec: Float32Array, topK: number, filter?: SkillFilter): ScoredId[] {
      const scored: ScoredId[] = [];
      for (const ref of refs) {
        if (!matchesFilter(ref, filter)) continue;
        const vec = vectors.get(ref.contentHash);
        if (!vec) continue;
        scored.push({ id: ref.id, score: cosine(queryVec, vec) });
      }
      // Deterministic: score desc, then id asc on ties.
      scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return topK >= 0 ? scored.slice(0, topK) : scored;
    },
  };
}

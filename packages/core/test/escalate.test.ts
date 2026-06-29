// Tier-0/1 → Tier-2 escalation (A0-A, D21, M-embed). Hermetic: the embedder is injected, no network.
// Proves the SINGLE semantic-primary cascade; that an unreachable OR absent provider degrades VISIBLY
// (tierDisabled) without dropping the Tier-0/1 result; the no-network short-circuits; the enabled-pool
// boundary; the non-finite fire-gate backstop; and that SkillMatch.id is carried through.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLexicalIndex,
  createEmbeddingIndex,
  selectWithEscalation,
  tieredSelect,
  EmbeddingsUnavailable,
} from "@skillforge/core";
import { SCHEMA_VERSION, type SkillManifest, type ManifestSkillEntry, type TargetId } from "@skillforge/contracts";

// Minimal SkillManifest/SkillRecord stand-in (only the read fields). Types are stripped at runtime.
function skill(
  slug: string,
  id: string,
  contentHash: string,
  embedding: number[],
  enabledFor: Partial<Record<TargetId, boolean>> = { proxy: true },
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    slug,
    id,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    description: `${slug} tool`,
    instructions: "",
    bodyLen: 0,
    tokenEstimate: 0,
    warnings: [],
    contentHash,
    enabledFor,
    embedding,
  };
}

const alpha = skill("alpha", "idA", "hashA", [1, 0, 0]);
const beta = skill("beta", "idB", "hashB", [0, 1, 0]);
const gamma = skill("gamma", "idG", "hashG", [0, 0, 1]);
const pool = [alpha, beta];
const lexIndex = buildLexicalIndex(pool);

async function indexOver(skills: SkillManifest[]) {
  const idx = createEmbeddingIndex({ dim: 3 });
  // minimal stand-ins: ensure() reads id/contentHash/enabledFor/embedding for scoring (plus slug/name/
  // description for a haystack used only when a filter.q is set — these tests never set one), all present
  // here, so the cast to the fuller ManifestSkillEntry it nominally takes is runtime-safe for these tests.
  await idx.ensure(skills as unknown as ManifestSkillEntry[]);
  return idx;
}

function countingEmbedder(vec: number[]) {
  const state = { calls: 0 };
  const fn = async () => {
    state.calls++;
    return Float32Array.from(vec);
  };
  return { fn, state };
}

test("single cascade: a configured, non-explicit query embeds once and semantic fires", async () => {
  const embeddingIndex = await indexOver(pool);
  const { fn, state } = countingEmbedder([1, 0, 0]); // aligns with alpha → cosine 1
  const { selection, tierDisabled } = await selectWithEscalation("please do the work now", {
    skills: pool,
    lexIndex,
    embeddingIndex,
    embedFn: fn,
  });
  assert.equal(state.calls, 1, "embedded the query exactly once");
  assert.equal(selection.mode, "semantic");
  assert.equal(selection.chosen?.slug, "alpha");
  assert.equal(selection.chosen?.id, "idA", "SkillMatch.id carried on the semantic match");
  assert.equal(tierDisabled, undefined, "no degradation when the provider is reachable");
});

test("degradation: EmbeddingsUnavailable → Tier-0/1 + tierDisabled carries the reason (never silent)", async () => {
  const embeddingIndex = await indexOver(pool);
  const embedFn = async () => {
    throw new EmbeddingsUnavailable("provider down");
  };
  const { selection, tierDisabled } = await selectWithEscalation("please do the work now", {
    skills: pool,
    lexIndex,
    embeddingIndex,
    embedFn,
  });
  assert.equal(selection.mode, "none", "kept the Tier-0/1 selection");
  assert.deepEqual(tierDisabled, { tier: "semantic", reason: "provider down" }, "visible degradation");
});

test("absent provider (non-explicit, non-empty pool) → Tier-0/1 + tierDisabled (M-embed, never silent)", async () => {
  const { selection, tierDisabled } = await selectWithEscalation("please do the work now", { skills: pool, lexIndex });
  assert.equal(selection.mode, "none");
  assert.equal(selection.belowThreshold, true, "a tier ran but nothing cleared θ");
  assert.deepEqual(tierDisabled, { tier: "semantic", reason: "no embeddings provider configured" });
});

test("an unexpected (non-EmbeddingsUnavailable) error is NOT swallowed", async () => {
  const embeddingIndex = await indexOver(pool);
  const embedFn = async () => {
    throw new TypeError("bug");
  };
  await assert.rejects(
    () => selectWithEscalation("please do the work now", { skills: pool, lexIndex, embeddingIndex, embedFn }),
    TypeError,
  );
});

test("short-circuit: empty pool → base, no embed, no tierDisabled; belowThreshold false", async () => {
  const embeddingIndex = await indexOver(pool);
  const { fn, state } = countingEmbedder([1, 0, 0]);
  const { selection, tierDisabled } = await selectWithEscalation("anything", {
    skills: [],
    lexIndex: buildLexicalIndex([]),
    embeddingIndex,
    embedFn: fn,
  });
  assert.equal(state.calls, 0, "no network round-trip for an empty pool");
  assert.equal(selection.mode, "none");
  assert.equal(selection.belowThreshold, false, "empty pool is not below-θ");
  assert.equal(tierDisabled, undefined);
});

test("short-circuit: provider configured but index has no vectors → base, no embed call", async () => {
  const emptyIndex = await indexOver([]); // ensured over nothing → vectors.size === 0
  const { fn, state } = countingEmbedder([1, 0, 0]);
  const { selection, tierDisabled } = await selectWithEscalation("please do the work now", {
    skills: pool,
    lexIndex,
    embeddingIndex: emptyIndex,
    embedFn: fn,
  });
  assert.equal(state.calls, 0, "no embed when there is nothing indexed to rank against");
  assert.equal(selection.mode, "none");
  assert.equal(tierDisabled, undefined, "not a degradation — the provider is fine, the index is empty");
});

test("explicit short-circuits: never embeds, carries id, no tierDisabled", async () => {
  const embeddingIndex = await indexOver(pool);
  const { fn, state } = countingEmbedder([1, 0, 0]);
  const { selection, tierDisabled } = await selectWithEscalation("$alpha please", {
    skills: pool,
    lexIndex,
    embeddingIndex,
    embedFn: fn,
  });
  assert.equal(selection.mode, "explicit");
  assert.equal(selection.chosen?.slug, "alpha");
  assert.equal(selection.chosen?.id, "idA", "explicit match carries id");
  assert.equal(state.calls, 0, "explicit never triggers the embed call");
  assert.equal(tierDisabled, undefined);
});

test("enabled-pool boundary: a skill absent from the pool never fires though its vector is indexed", async () => {
  // The index holds vectors for the WHOLE catalog (alpha, beta, gamma); the query embedding aligns with
  // gamma. With gamma in the pool it fires; excluded from the pool it cannot — escalate ranks only the
  // skills it is handed (defense in depth vs a caller that forgot to pre-filter).
  const embeddingIndex = await indexOver([alpha, beta, gamma]);
  const gammaQuery = async () => Float32Array.from([0, 0, 1]);

  const inPool = await selectWithEscalation("zzz", {
    skills: [alpha, beta, gamma],
    lexIndex: buildLexicalIndex([alpha, beta, gamma]),
    embeddingIndex,
    embedFn: gammaQuery,
  });
  assert.equal(inPool.selection.chosen?.slug, "gamma", "fires when gamma is in the enabled pool");

  const excluded = await selectWithEscalation("zzz", { skills: pool, lexIndex, embeddingIndex, embedFn: gammaQuery });
  assert.notEqual(excluded.selection.mode, "semantic", "no semantic fire — gamma is out of the pool");
  assert.notEqual(excluded.selection.chosen?.slug, "gamma");
  assert.ok(!excluded.selection.candidates.some((c) => c.id === "idG"), "gamma never appears as a candidate");
});

test("non-finite query vector falls through the fire-gate (defense in depth) — no semantic fire", async () => {
  const embeddingIndex = await indexOver(pool);
  const nanQuery = async () => Float32Array.from([NaN, 0, 0]);
  const { selection } = await selectWithEscalation("zzz", { skills: pool, lexIndex, embeddingIndex, embedFn: nanQuery });
  assert.notEqual(selection.mode, "semantic", "a NaN cosine must not fire as a confident match");
});

test("fire-gate polarity: tieredSelect treats a non-finite top score as below θ (NaN and Infinity)", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const sel = tieredSelect("zzz", { skills: pool, lexIndex, queryVec: [bad, 0, 0], skillVecs: [[1, 0, 0], [0, 1, 0]] });
    assert.notEqual(sel.mode, "semantic", `non-finite (${bad}) top must not clear the gate`);
  }
});

test("lexical candidates carry id", async () => {
  const { selection } = await selectWithEscalation("alpha", { skills: pool, lexIndex });
  assert.ok(selection.candidates.some((c) => c.id === "idA"), "candidate rows carry the skill id");
});

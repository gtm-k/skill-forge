// Tier-2 EmbeddingIndex — brute-force cosine over in-memory Float32Array (D13), enabled-pool filter,
// and contentHash cache-hit. Hermetic: no network, vectors are inline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingIndex } from "@skillforge/core";
import type { ManifestSkillEntry, TargetId } from "@skillforge/contracts";

// Minimal SkillRecord (= ManifestSkillEntry) stand-in. Types are stripped at runtime.
function rec(
  id: string,
  contentHash: string,
  embedding: number[],
  enabledFor: Partial<Record<TargetId, boolean>> = { proxy: true },
): ManifestSkillEntry {
  return {
    id,
    slug: id,
    name: id.toUpperCase(),
    description: `${id} skill`,
    dir: id,
    contentHash,
    enabledFor,
    execAllowed: false,
    capabilities: { scriptCount: 0, interpreters: [], commands: [], flags: [] },
    bundle: [],
    warnings: [],
    bodyLen: 0,
    tokenEstimate: 0,
    provenance: [],
    embedding,
  };
}

test("ensure + query: topK ranked by cosine, descending", async () => {
  const idx = createEmbeddingIndex();
  await idx.ensure([
    rec("a", "hashA", [1, 0, 0]), // cos vs [1,0,0] = 1.0
    rec("b", "hashB", [0, 1, 0]), // cos = 0.0
    rec("c", "hashC", [1, 1, 0]), // cos ≈ 0.707
  ]);
  const out = idx.query(Float32Array.from([1, 0, 0]), 2);
  assert.equal(out.length, 2, "topK truncates to 2");
  assert.deepEqual(out.map((s) => s.id), ["a", "c"], "ordered by cosine desc");
  const [top, second] = out;
  assert.ok(top && second, "topK returned two rows");
  assert.ok(Math.abs(top.score - 1) < 1e-6, "top cosine == 1");
  assert.ok(second.score > 0.7 && second.score < 0.71, "second cosine ≈ 0.707");
});

test("query: deterministic tie-break by id on equal scores", async () => {
  const idx = createEmbeddingIndex();
  await idx.ensure([rec("z", "hz", [1, 0]), rec("a", "ha", [1, 0])]); // identical → same cosine
  const out = idx.query(Float32Array.from([1, 0]), 2);
  assert.deepEqual(out.map((s) => s.id), ["a", "z"], "tie broken by id asc");
});

test("query: enabled-pool filter (target + enabledOnly)", async () => {
  const idx = createEmbeddingIndex();
  await idx.ensure([
    rec("a", "ha", [1, 0], { proxy: true, lmstudio: false }),
    rec("b", "hb", [1, 0], { proxy: false, lmstudio: true }),
  ]);
  const q = Float32Array.from([1, 0]);
  assert.deepEqual(idx.query(q, 10).map((s) => s.id).sort(), ["a", "b"], "no filter → whole pool");
  assert.deepEqual(idx.query(q, 10, { target: "proxy", enabledOnly: true }).map((s) => s.id), ["a"]);
  assert.deepEqual(idx.query(q, 10, { target: "lmstudio", enabledOnly: true }).map((s) => s.id), ["b"]);
});

test("query: q substring narrows the pool", async () => {
  const idx = createEmbeddingIndex();
  await idx.ensure([rec("alpha", "ha", [1, 0]), rec("beta", "hb", [1, 0])]);
  const out = idx.query(Float32Array.from([1, 0]), 10, { q: "alpha" });
  assert.deepEqual(out.map((s) => s.id), ["alpha"]);
});

test("ensure: contentHash cache-hit reuses the Float32Array (D13)", async () => {
  const idx = createEmbeddingIndex();
  await idx.ensure([rec("a", "hashA", [1, 0, 0])]);
  const first = idx.vectors.get("hashA");
  assert.ok(first instanceof Float32Array);

  // Re-ensure the SAME contentHash, even with a DIFFERENT embedding payload: contentHash is the cache
  // key (identical content ⇒ identical vector), so the vector is NOT rebuilt.
  await idx.ensure([rec("a", "hashA", [0, 1, 0])]);
  const second = idx.vectors.get("hashA");
  assert.equal(second, first, "same contentHash → same cached Float32Array (cache-hit)");
  assert.equal(second?.[0], 1, "cached vector retained the original content, not the new payload");

  // A changed contentHash IS a new vector.
  await idx.ensure([rec("a", "hashA2", [0, 1, 0])]);
  assert.notEqual(idx.vectors.get("hashA2"), first, "new contentHash → fresh vector");
});

test("ensure: records without an embedding or contentHash are skipped", async () => {
  const idx = createEmbeddingIndex();
  await idx.ensure([
    rec("a", "ha", [1, 0]),
    rec("b", "hb", []), // empty embedding → unscored
    rec("c", undefined as unknown as string, [1, 0]), // no contentHash (deliberately malformed) → unscored
  ]);
  const out = idx.query(Float32Array.from([1, 0]), 10);
  assert.deepEqual(out.map((s) => s.id), ["a"], "only the embedded+hashed record is scorable");
});

test("ensure: stored vector with drifted dim is skipped + flagged (never silently zero-padded)", async () => {
  const idx = createEmbeddingIndex({ dim: 3 });
  await idx.ensure([rec("ok", "ho", [1, 0, 0]), rec("bad", "hb", [1, 0])]); // bad dim 2 ≠ 3
  assert.deepEqual(idx.query(Float32Array.from([1, 0, 0]), 10).map((s) => s.id), ["ok"], "dim-drift excluded");
  assert.equal(idx.mismatched.length, 1);
  const m = idx.mismatched[0];
  assert.ok(m, "one mismatch recorded");
  assert.equal(m.id, "bad");
  assert.equal(m.reason, "dim");
  assert.equal(m.got, 2);
  assert.equal(m.expected, 3);
});

test("ensure: stored vector with non-finite values is skipped + flagged", async () => {
  const idx = createEmbeddingIndex({ dim: 3 });
  await idx.ensure([rec("ok", "ho", [1, 0, 0]), rec("nan", "hn", [1, NaN, 0])]);
  assert.deepEqual(idx.query(Float32Array.from([1, 0, 0]), 10).map((s) => s.id), ["ok"]);
  assert.equal(idx.mismatched.length, 1);
  const m = idx.mismatched[0];
  assert.ok(m, "one mismatch recorded");
  assert.equal(m.id, "nan");
  assert.equal(m.reason, "non-finite");
});

test("ensure: inferred dim (no opts) flags later drift against the first scorable vector", async () => {
  const idx = createEmbeddingIndex();
  await idx.ensure([rec("a", "ha", [1, 0, 0]), rec("b", "hb", [1, 0])]); // first sets expected=3; b drifts
  assert.deepEqual(idx.query(Float32Array.from([1, 0, 0]), 10).map((s) => s.id), ["a"]);
  assert.equal(idx.mismatched.length, 1);
  const m = idx.mismatched[0];
  assert.ok(m, "one mismatch recorded");
  assert.equal(m.id, "b");
});

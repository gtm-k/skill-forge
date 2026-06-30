// @skillforge/daemon/test/derive — the CQRS read-model derivation (§5/D19).
// Asserts the EXACT dir composition (incl. "."→sourceId), enabledFor/execAllowed mapping, qualityScore,
// provenance, embeddingModel/Dim, and the SEQ-HANDOFF seq seeding.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openStore } from "../src/store/store.ts";
import { deriveReadModel } from "../src/manifest/derive.ts";
import { mkTmp, cleanup, makeSkill, makeSource } from "./helpers.ts";
import type { ManifestReadModel } from "@skillforge/contracts";

after(cleanup);

function freshStore() {
  const home = mkTmp("skf-d-derive-");
  return openStore(path.join(home, "skillforge.db"));
}

test("derive: dir is <sourceId>/<sourceRelPath>, and just <sourceId> when relPath === '.'", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcdir00001" });
  const root = makeSkill({ slug: "root-skill", sourceId: src.sourceId, relPath: "." }); // at the source root
  const nested = makeSkill({ slug: "nested", sourceId: src.sourceId, relPath: "pack/nested" });
  store.upsert([root, nested], src);

  const model = deriveReadModel(store, { now: "2026-06-27T00:00:00.000Z" });
  assert.equal(model.schemaVersion, 1);
  assert.equal(model.sourcesDir, "sources");
  assert.equal(model.generatedAt, "2026-06-27T00:00:00.000Z");

  const byId = new Map(model.skills.map((s) => [s.id, s]));
  assert.equal(byId.get(root.id!)!.dir, src.sourceId, "'.' relPath composes to bare sourceId");
  assert.equal(byId.get(nested.id!)!.dir, `${src.sourceId}/pack/nested`, "nested relPath composes to sourceId/relPath");
  store.close();
});

test("derive: enabledFor + execAllowed map from the DB into the manifest entry", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcmap00001" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId, contentHash: "c".repeat(64) });
  store.upsert([a], src);
  store.setEnabled(a.id!, "proxy", false);
  store.setExecAllowed(a.id!, "c".repeat(64), true);

  const entry = deriveReadModel(store).skills.find((s) => s.id === a.id!)!;
  assert.deepEqual(entry.enabledFor, { lmstudio: true, mcp: true, proxy: false });
  assert.equal(entry.execAllowed, true);
  store.close();
});

test("derive: qualityScore follows the documented derivation (placeholder + a warn → 50)", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcqs000001" });
  // isPlaceholder (−40) + one warn-level warning (−10) → 100 − 40 − 10 = 50.
  const a = makeSkill({
    slug: "ph",
    sourceId: src.sourceId,
    isPlaceholder: true,
    warnings: [{ level: "warn", field: "description", msg: "looks like a placeholder" }],
  });
  // a clean skill → 100.
  const b = makeSkill({ slug: "clean", sourceId: src.sourceId });
  store.upsert([a, b], src);

  const skills = deriveReadModel(store).skills;
  assert.equal(skills.find((s) => s.id === a.id!)!.qualityScore, 50);
  assert.equal(skills.find((s) => s.id === a.id!)!.isPlaceholder, true);
  assert.equal(skills.find((s) => s.id === b.id!)!.qualityScore, 100);
  store.close();
});

test("derive: an error-level warning weighs −25 and the score clamps at 0", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcqs000002" });
  const a = makeSkill({
    slug: "broken",
    sourceId: src.sourceId,
    isPlaceholder: true,
    warnings: [
      { level: "error", field: "description", msg: "missing description" },
      { level: "error", field: "x", msg: "another error" },
      { level: "warn", field: "y", msg: "a warn" },
    ],
  });
  store.upsert([a], src);
  // 100 − 40 − 25·2 − 10 = 0 (clamped, would be 0 exactly here).
  assert.equal(deriveReadModel(store).skills[0]!.qualityScore, 0);
  store.close();
});

test("derive: provenance carries kind/input/ref from the source row", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcprov0001", kind: "git", input: "https://github.com/o/r", ref: "v1.2.3" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId });
  store.upsert([a], src);

  const prov = deriveReadModel(store).skills[0]!.provenance;
  assert.equal(prov.length, 1);
  assert.deepEqual(prov[0], { sourceId: src.sourceId, kind: "git", input: "https://github.com/o/r", ref: "v1.2.3" });
  store.close();
});

test("derive: embeddingModel/embeddingDim are stamped from the stored vectors", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcembm0001" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId, embedding: [0.5, 0.25, 0.125] });
  store.upsert([a], src);

  const model = deriveReadModel(store);
  assert.equal(model.embeddingModel, "text-embedding-nomic-embed-text-v1.5");
  assert.equal(model.embeddingDim, 3);
  assert.deepEqual(model.skills[0]!.embedding, [0.5, 0.25, 0.125]);
  store.close();
});

test("derive: with NO embeddings, embeddingModel/embeddingDim are omitted", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcnoemb001" });
  store.upsert([makeSkill({ slug: "alpha", sourceId: src.sourceId })], src);
  const model = deriveReadModel(store);
  assert.equal(model.embeddingModel, undefined);
  assert.equal(model.embeddingDim, undefined);
  store.close();
});

test("derive: a skill with NO mute row omits mcpRunMuted (absent → not-muted; backward-compat, C4)", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcmute0002" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId });
  store.upsert([a], src);

  // a manifest written before this field exists derives with it ABSENT — consumers read absent as not-muted.
  const before = deriveReadModel(store).skills[0]!;
  assert.equal(before.mcpRunMuted, undefined, "no mute row ⇒ the manifest omits mcpRunMuted (a pre-field manifest loads as not-muted)");
  assert.equal("mcpRunMuted" in before, false, "the key is omitted entirely (minimal additive manifest)");

  // once muted, the derived manifest carries the field so consumers (both run paths) enforce it.
  store.setMcpRunMuted(a.id!, true);
  assert.equal(deriveReadModel(store).skills[0]!.mcpRunMuted, true, "a muted skill projects mcpRunMuted=true into the manifest");
  store.close();
});

test("derive: SEQ-HANDOFF — seq is seeded to at least the existing manifest's seq, never below it", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcseq00001" });
  store.upsert([makeSkill({ slug: "alpha", sourceId: src.sourceId })], src); // store seq is now 1

  const existingManifest = { seq: 50 } as ManifestReadModel;
  const model = deriveReadModel(store, { existingManifest });
  assert.ok(model.seq >= 50, `derived seq must not regress below the CLI's last manifest seq (got ${model.seq})`);
  // and the seeding PERSISTED into the store, so a later mutation stays above the CLI's last seq
  store.setEnabled(makeSkill({ slug: "alpha", sourceId: src.sourceId }).id!, "mcp", false);
  assert.ok(store.revision() > 50, `next mutation must stay above 50 (got ${store.revision()})`);
  store.close();
});

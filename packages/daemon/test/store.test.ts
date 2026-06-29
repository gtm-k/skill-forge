// @skillforge/daemon/test/store — SkillStore CRUD + the monotonic seq/db_revision invariant (M-cqrs/D19).
// Real file-backed WAL DB under a temp home; no network, no LM Studio.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openStore, ExecGrantError } from "../src/store/store.ts";
import { mkTmp, cleanup, makeSkill, makeSource } from "./helpers.ts";

after(cleanup);

function freshStore() {
  const home = mkTmp("skf-d-store-");
  return openStore(path.join(home, "skillforge.db"));
}

test("upsert: writes skills, seeds enabledFor=all-true, execAllowed=false, revision/dbRevision = 1", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "src000000001" });
  store.upsert([makeSkill({ slug: "alpha", sourceId: src.sourceId }), makeSkill({ slug: "beta", sourceId: src.sourceId })], src);

  assert.equal(store.revision(), 1, "one batch upsert = one seq bump");
  assert.equal(store.dbRevision(), 1);

  const list = store.list();
  assert.equal(list.length, 2);
  const alpha = store.get(makeSkill({ slug: "alpha", sourceId: src.sourceId }).id!);
  assert.ok(alpha);
  assert.deepEqual(alpha.enabledFor, { lmstudio: true, mcp: true, proxy: true });
  assert.equal(alpha.execAllowed, false);
  assert.equal(alpha.dir, `${src.sourceId}/alpha`);
  assert.ok(Array.isArray(alpha.bundle) && alpha.bundle.length === 1);
  store.close();
});

test("revision + dbRevision bump STRICTLY-MONOTONICALLY across every mutating op", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcmono00001" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId });
  const b = makeSkill({ slug: "beta", sourceId: src.sourceId });

  const seqs: number[] = [];
  const dbs: number[] = [];
  const snap = () => {
    seqs.push(store.revision());
    dbs.push(store.dbRevision());
  };

  snap(); // 0,0 fresh
  store.upsert([a, b], src);
  snap();
  store.setEnabled(a.id!, "mcp", false);
  snap();
  store.setExecAllowed(a.id!, a.contentHash!, true);
  snap();
  store.remove(b.id!);
  snap();

  for (let i = 1; i < seqs.length; i++) {
    assert.ok((seqs[i] as number) > (seqs[i - 1] as number), `seq must strictly increase at step ${i}: ${seqs.join(",")}`);
    assert.ok((dbs[i] as number) > (dbs[i - 1] as number), `db_revision must strictly increase at step ${i}: ${dbs.join(",")}`);
  }
  store.close();
});

test("setEnabled: toggling off excludes the skill from an enabledOnly+target list", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcen000001" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId });
  const b = makeSkill({ slug: "beta", sourceId: src.sourceId });
  store.upsert([a, b], src);

  store.setEnabled(a.id!, "mcp", false);
  const mcpOn = store.list({ target: "mcp", enabledOnly: true });
  assert.deepEqual(mcpOn.map((s) => s.slug).sort(), ["beta"]);
  // a stays enabled for the other targets
  assert.deepEqual(store.list({ target: "lmstudio", enabledOnly: true }).map((s) => s.slug).sort(), ["alpha", "beta"]);
  assert.equal(store.get(a.id!)!.enabledFor.mcp, false);
  store.close();
});

test("list: q filters by name/description/slug substring", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcq0000001" });
  store.upsert(
    [
      makeSkill({ slug: "pdf-tools", sourceId: src.sourceId, description: "work with PDF documents" }),
      makeSkill({ slug: "image-resize", sourceId: src.sourceId, description: "resize images" }),
    ],
    src,
  );
  assert.deepEqual(store.list({ q: "pdf" }).map((s) => s.slug), ["pdf-tools"]);
  assert.deepEqual(store.list({ q: "resize" }).map((s) => s.slug), ["image-resize"]);
  store.close();
});

test("list: q escapes LIKE wildcards so '_' and '%' match LITERALLY, not as wildcards (#10)", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srclike0001" });
  store.upsert(
    [
      makeSkill({ slug: "literal", sourceId: src.sourceId, description: "matches a_b exactly" }),
      makeSkill({ slug: "victim", sourceId: src.sourceId, description: "matches axb instead" }),
    ],
    src,
  );
  // unescaped, "a_b" LIKE would treat _ as a wildcard and also match "axb"; escaped, it must not.
  assert.deepEqual(store.list({ q: "a_b" }).map((s) => s.slug), ["literal"]);
  store.close();
});

test("setExecAllowed: grant honored while hash matches; a re-sync that changes contentHash REVOKES it (D10)", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcexec0001" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId, contentHash: "a".repeat(64) });
  store.upsert([a], src);

  store.setExecAllowed(a.id!, "a".repeat(64), true);
  assert.equal(store.get(a.id!)!.execAllowed, true, "grant matching the current hash is honored");

  // re-sync the SAME skill (same id) with NEW bytes → new contentHash. The old grant no longer matches.
  const a2 = makeSkill({ slug: "alpha", sourceId: src.sourceId, contentHash: "b".repeat(64) });
  assert.equal(a2.id, a.id, "same source+relPath → same stable id");
  store.upsert([a2], src);
  assert.equal(store.get(a.id!)!.execAllowed, false, "a contentHash change must auto-revoke the exec grant (D10)");
  store.close();
});

test("setExecAllowed: a grant for a NON-EXISTENT skill is refused (no pre-seeding for future content, D10)", () => {
  const store = freshStore();
  assert.throws(
    () => store.setExecAllowed("doesnotexist", "a".repeat(64), true),
    ExecGrantError,
    "granting exec for an unknown id must throw, never pre-seed a grant",
  );
  assert.equal(store.revision(), 0, "a refused grant does not bump the revision (tx rolled back)");
  store.close();
});

test("setExecAllowed: a grant whose contentHash does NOT match the current skill is refused (D10 bypass)", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcexec0002" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId, contentHash: "a".repeat(64) });
  store.upsert([a], src);

  let caught: unknown;
  try {
    store.setExecAllowed(a.id!, "f".repeat(64), true); // claims to have reviewed bytes the skill does not have
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ExecGrantError, "a hash mismatch must throw ExecGrantError");
  assert.equal((caught as ExecGrantError).currentHash, "a".repeat(64), "the error carries the current on-disk hash (→ 409)");
  assert.equal(store.get(a.id!)!.execAllowed, false, "no grant was written for the unreviewed hash");
  store.close();
});

test("setExecAllowed: REVOKING (on=false) is always permitted regardless of hash", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcexec0003" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId, contentHash: "a".repeat(64) });
  store.upsert([a], src);
  store.setExecAllowed(a.id!, "a".repeat(64), true);
  assert.equal(store.get(a.id!)!.execAllowed, true);

  // turning a grant OFF must never be gated on a hash match (you can always revoke)
  assert.doesNotThrow(() => store.setExecAllowed(a.id!, "whatever-hash", false));
  assert.equal(store.get(a.id!)!.execAllowed, false);
  store.close();
});

test("remove: deletes the skill and its dependent rows", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcrm000001" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId });
  const b = makeSkill({ slug: "beta", sourceId: src.sourceId });
  store.upsert([a, b], src);

  store.remove(b.id!);
  assert.equal(store.get(b.id!), undefined);
  assert.deepEqual(store.list().map((s) => s.slug), ["alpha"]);
  store.close();
});

test("setMcpRunMuted: true stamps mcpRunMuted + bumps seq; false clears it; remove() deletes the mute row (C4)", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcmute0001" });
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId });
  store.upsert([a], src);
  const seq0 = store.revision();

  // a fresh skill is NOT muted — the field is ABSENT (minimal additive manifest), not `false`.
  assert.equal(store.get(a.id!)!.mcpRunMuted, undefined, "a fresh skill is not muted (field absent)");

  store.setMcpRunMuted(a.id!, true);
  assert.equal(store.get(a.id!)!.mcpRunMuted, true, "mute stamps mcpRunMuted=true");
  assert.ok(store.revision() > seq0, "muting bumps the read-model seq (it is read-model state)");

  store.setMcpRunMuted(a.id!, false);
  assert.equal(store.get(a.id!)!.mcpRunMuted, undefined, "un-mute clears the field (omitted when false)");

  // remove() must delete the mute row — a later re-add of the SAME id must not resurrect a stale mute.
  store.setMcpRunMuted(a.id!, true);
  store.remove(a.id!);
  store.upsert([a], src);
  assert.equal(store.get(a.id!)!.mcpRunMuted, undefined, "remove() deleted the mute row — a re-added skill is not muted");
  store.close();
});

test("embeddings: round-trip a vector + embeddingMeta reports model/dim", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcemb00001" });
  const vec = [1, 0.1, 0.2, 0.3];
  const a = makeSkill({ slug: "alpha", sourceId: src.sourceId, embedding: vec });
  store.upsert([a], src);

  const got = store.get(a.id!);
  assert.deepEqual(got!.embedding, vec, "embedding round-trips exactly through the Float64 BLOB");
  const meta = store.embeddingMeta();
  assert.ok(meta);
  assert.equal(meta!.dim, 4);
  assert.equal(meta!.model, "text-embedding-nomic-embed-text-v1.5");
  store.close();
});

test("embeddingMeta: DETERMINISTIC majority (model,dim) on a mixed-model corpus (#9)", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcmeta0001" });
  // two vectors under "majority" (dim 3), one under "minority" (dim 2)
  store.upsert(
    [
      makeSkill({ slug: "a", sourceId: src.sourceId, embedding: [1, 2, 3] }),
      makeSkill({ slug: "b", sourceId: src.sourceId, embedding: [4, 5, 6] }),
    ],
    src,
    { embeddingModel: "majority" },
  );
  store.upsert([makeSkill({ slug: "c", sourceId: src.sourceId, embedding: [7, 8] })], src, { embeddingModel: "minority" });
  const meta = store.embeddingMeta();
  assert.deepEqual(meta, { model: "majority", dim: 3 }, "the majority model/dim wins, deterministically (not an arbitrary row)");
  store.close();
});

test("upsert: an incomplete (un-normalized) skill is surfaced, never silently stored", () => {
  const store = freshStore();
  const src = makeSource({ sourceId: "srcbad00001" });
  const broken = makeSkill({ slug: "alpha", sourceId: src.sourceId });
  delete broken.contentHash; // simulate an upstream contract break
  assert.throws(() => store.upsert([broken], src), /incomplete normalized skill/);
  // the failed batch rolled back: nothing partially written
  assert.equal(store.list().length, 0);
  assert.equal(store.revision(), 0, "a rolled-back batch does not bump the revision");
  store.close();
});

// @skillforge/daemon/test/staleness — the actor-observability staleness signal (M-cqrs/D19).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openStore } from "../src/store/store.ts";
import { deriveReadModel } from "../src/manifest/derive.ts";
import { staleness } from "../src/staleness.ts";
import { mkTmp, cleanup, makeSkill, makeSource } from "./helpers.ts";
import type { ManifestReadModel } from "@skillforge/contracts";

after(cleanup);

function storeAtRevision1() {
  const store = openStore(path.join(mkTmp("skf-d-stale-"), "skillforge.db"));
  const src = makeSource({ sourceId: "srcstale001" });
  store.upsert([makeSkill({ slug: "alpha", sourceId: src.sourceId })], src); // seq=1, dbRevision=1
  return store;
}

function manifest(seq: number, dbRevision?: number): ManifestReadModel {
  const m = { schemaVersion: 1, seq, generatedAt: "x", sourcesDir: "sources", skills: [] } as ManifestReadModel;
  if (dbRevision !== undefined) m.dbRevision = dbRevision;
  return m;
}

test("staleness: a manifest matching seq AND dbRevision is fresh", () => {
  const store = storeAtRevision1();
  const r = staleness(manifest(1, 1), store);
  assert.equal(r.stale, false);
  assert.equal(r.daemonSeq, 1);
  assert.equal(r.dbRevision, 1);
  assert.equal(r.reason, undefined);
  store.close();
});

test("staleness: a manifest whose seq is BEHIND the DB is surfaced as stale", () => {
  const store = storeAtRevision1();
  const r = staleness(manifest(0, 0), store);
  assert.equal(r.stale, true);
  assert.equal(r.manifestSeq, 0);
  assert.equal(r.daemonSeq, 1);
  assert.match(r.reason ?? "", /seq 0 is BEHIND daemon seq 1/);
  store.close();
});

test("staleness: a manifest whose seq is AHEAD of the DB is surfaced (DB regressed / lost a txn)", () => {
  const store = storeAtRevision1();
  const r = staleness(manifest(2, 2), store); // manifest claims seq 2 but the DB only has 1
  assert.equal(r.stale, true);
  assert.match(r.reason ?? "", /seq 2 is AHEAD of daemon seq 1/);
  store.close();
});

test("staleness: matching seq but a dbRevision skew is surfaced (crash between DB write + manifest rewrite)", () => {
  const store = storeAtRevision1();
  const r = staleness(manifest(1, 0), store); // seq agrees, dbRevision does not
  assert.equal(r.stale, true);
  assert.match(r.reason ?? "", /dbRevision 0 != daemon dbRevision 1/);
  store.close();
});

test("staleness: no published manifest is stale (nothing to serve)", () => {
  const store = storeAtRevision1();
  const r = staleness(undefined, store);
  assert.equal(r.stale, true);
  assert.match(r.reason ?? "", /no manifest published/);
  store.close();
});

test("staleness: a CLI manifest (no dbRevision) whose seq matches but whose skills DIVERGE is stale (finding #4)", () => {
  const store = storeAtRevision1(); // DB has 1 skill, seq=1
  // a CLI manifest with the same seq but a different skill set (the exact CLI→daemon first-run trap:
  // seq seeded to the CLI's value, but the DB does not back those skills).
  const m = deriveReadModel(store);
  delete m.dbRevision; // simulate the CLI (which omits dbRevision)
  m.skills = m.skills.map((s) => ({ ...s, contentHash: "deadbeef".repeat(8) })); // diverge from the DB
  const r = staleness(m, store);
  assert.equal(r.stale, true, "a seq match alone must NOT be reported fresh when the DB doesn't back the manifest");
  assert.match(r.reason ?? "", /unverified CLI->daemon handoff|unverified CLI→daemon handoff/);
  store.close();
});

test("staleness: a CLI manifest (no dbRevision) whose seq AND skill set match the DB is fresh", () => {
  const store = storeAtRevision1();
  const m = deriveReadModel(store); // skills match the DB exactly
  delete m.dbRevision; // simulate the CLI
  const r = staleness(m, store);
  assert.equal(r.stale, false, "a no-dbRevision manifest backed by the same DB skill set is a verified handoff");
  store.close();
});

test("staleness: an empty CLI manifest backed by an empty DB is fresh", () => {
  const store = openStore(path.join(mkTmp("skf-d-stale-empty-"), "skillforge.db")); // 0 skills, seq=0
  const r = staleness(manifest(0), store); // seq 0, no dbRevision, no skills
  assert.equal(r.stale, false);
  store.close();
});

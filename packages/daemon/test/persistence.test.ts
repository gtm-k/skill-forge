// @skillforge/daemon/test/persistence — the createPersistence factory: SEQ-HANDOFF, atomic publish,
// last-good tolerant read / re-derive-from-DB on corruption, and the writer lock wiring.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPersistence } from "../src/index.ts";
import { WriterLockError } from "../src/lock/pidfile.ts";
import { manifestPath, writerPidPath } from "../src/home.ts";
import { mkTmp, cleanup, makeSkill, makeSource } from "./helpers.ts";
import type { ManifestReadModel } from "@skillforge/contracts";

after(cleanup);

test("SEQ-HANDOFF: a fresh DB seeded from an existing manifest (seq=50) publishes seq > 50", () => {
  const home = mkTmp("skf-d-persist-");
  // Simulate the CLI's last manifest write: seq=50, no DB behind it (dbRevision omitted, as the CLI does).
  fs.writeFileSync(
    manifestPath(home),
    JSON.stringify({ schemaVersion: 1, seq: 50, generatedAt: "x", sourcesDir: "sources", skills: [] }),
  );

  const p = createPersistence({ home });
  try {
    const src = makeSource({ sourceId: "srcseed0001" });
    p.store.upsert([makeSkill({ slug: "alpha", sourceId: src.sourceId })], src);
    const published = p.publishManifest("2026-06-27T00:00:00.000Z");

    assert.ok(published.seq > 50, `a freshly-built DB must never write a seq below the CLI's last manifest (got ${published.seq})`);
    assert.equal(published.seq, 51, "seeded floor 50, then one upsert bump → 51");
    assert.equal(published.dbRevision, 1, "the daemon stamps dbRevision (the CLI omitted it)");

    const onDisk = JSON.parse(fs.readFileSync(manifestPath(home), "utf8")) as ManifestReadModel;
    assert.equal(onDisk.seq, 51);
    assert.equal(onDisk.skills.length, 1);
    assert.equal(p.staleness().stale, false, "right after publish the read-model is fresh");
  } finally {
    p.close();
  }
});

test("publish is atomic + tolerant: a corrupt manifest is re-derived from the DB, never half-served", () => {
  const home = mkTmp("skf-d-persist-corrupt-");
  const p = createPersistence({ home });
  try {
    const src = makeSource({ sourceId: "srccorr0001" });
    p.store.upsert([makeSkill({ slug: "alpha", sourceId: src.sourceId })], src);
    const good = p.publishManifest();
    assert.ok(good.seq >= 1);

    // a partial/locked mid-write leaves corrupt bytes on disk
    fs.writeFileSync(manifestPath(home), '{ "seq": ');
    assert.equal(p.readManifest(), undefined, "a corrupt manifest reads as undefined (last-good tolerant), never throws");
    assert.equal(p.staleness().stale, true, "a corrupt/absent read-model is surfaced as stale, never silently served");

    // re-publishing re-derives from the authoritative DB and lands a valid, monotonic read-model
    const republished = p.publishManifest();
    assert.ok(republished.seq >= good.seq, "seq never regresses across a corrupt-then-republish cycle");
    const recovered = p.readManifest();
    assert.ok(recovered && recovered.skills.length === 1, "the read-model recovered from the DB");
    assert.equal(p.staleness().stale, false);
  } finally {
    p.close();
  }
});

test("writer lock: createPersistence writes the writer.pid record and close() releases it", () => {
  const home = mkTmp("skf-d-persist-lock-");
  const p = createPersistence({ home });
  assert.ok(fs.existsSync(writerPidPath(home)), "the writer lock pidfile is created on startup");
  const rec = JSON.parse(fs.readFileSync(writerPidPath(home), "utf8")) as { pid: number };
  assert.equal(rec.pid, process.pid);
  p.close();
  assert.equal(fs.existsSync(writerPidPath(home)), false, "close() releases the writer lock");
});

test("writer lock: a second writer on the same home is refused while the first holds a live lock", () => {
  const home = mkTmp("skf-d-persist-lock2-");
  const first = createPersistence({ home });
  try {
    // a second startup sees the first's live record (our pid, a different cookie) → refuse. The atomic
    // wx-create + identity check guarantees exactly one writer even without injecting a fake pid.
    assert.throws(() => createPersistence({ home }), WriterLockError, "two daemons must not both hold the writer lock");
  } finally {
    first.close();
  }
});

test("crash-between-writes: a DB write not followed by a manifest publish is surfaced as STALE on reopen", () => {
  const home = mkTmp("skf-d-persist-crash-");
  const src = makeSource({ sourceId: "srccrash001" });

  const p1 = createPersistence({ home });
  p1.store.upsert([makeSkill({ slug: "alpha", sourceId: src.sourceId })], src);
  const published = p1.publishManifest(); // manifest now at seq=1, dbRevision=1
  assert.equal(published.seq, 1);
  // a SECOND DB write that the daemon crashes before publishing (no publishManifest call)
  p1.store.upsert([makeSkill({ slug: "beta", sourceId: src.sourceId })], src); // DB seq=2, manifest still 1
  p1.close(); // "crash": lock released, WAL durable, manifest NOT republished

  const p2 = createPersistence({ home }); // reopen — seeds floor from manifest seq=1; DB already at 2
  try {
    const s = p2.staleness();
    assert.equal(s.stale, true, "the DB advanced past the manifest → must be observably stale, never silently served");
    assert.equal(s.manifestSeq, 1);
    assert.equal(s.daemonSeq, 2);
    assert.match(s.reason ?? "", /BEHIND daemon seq 2/);
    // republishing reconciles it
    p2.publishManifest();
    assert.equal(p2.staleness().stale, false);
  } finally {
    p2.close();
  }
});

test("restart continuity: re-opening the same home keeps seq monotonic across persistence instances", () => {
  const home = mkTmp("skf-d-persist-restart-");
  const src = makeSource({ sourceId: "srcrestart1" });

  const p1 = createPersistence({ home });
  p1.store.upsert([makeSkill({ slug: "alpha", sourceId: src.sourceId })], src);
  const first = p1.publishManifest();
  p1.close();

  const p2 = createPersistence({ home });
  try {
    p2.store.setEnabled(makeSkill({ slug: "alpha", sourceId: src.sourceId }).id!, "mcp", false);
    const second = p2.publishManifest();
    assert.ok(second.seq > first.seq, `seq must keep climbing across a restart (was ${first.seq}, now ${second.seq})`);
  } finally {
    p2.close();
  }
});

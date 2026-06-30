// Crash-restart proof (PLAN §5 proof-of-done, D19/M-cqrs) — the daemon's durability story, end to end.
//
// TWO failure modes, both proven HERE to be RECOVERABLE or OBSERVABLE (never silently served wrong):
//   1. DB LOST, sources/ survive → restart re-derives the DB AND the manifest from the materialized trees
//      with NOTHING lost (skill ids are stable — sourceId dir name reproduces shortId). BEFORE the rebuild,
//      the surviving manifest does NOT match the empty DB, and that is surfaced as STALENESS (the seq/
//      dbRevision skew of a crash BETWEEN the DB write and the manifest rewrite) — not served as fresh.
//   2. DB WRITE committed but the manifest rewrite never landed (the literal crash window) → on restart the
//      DB is AHEAD of the manifest, and staleness surfaces it (the read-model is not blindly trusted).
//
// Hermetic: an injected fake CloneFn (no git/network), throwaway temp homes, ephemeral everything.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createDaemon } from "../src/index.ts";
import { dbPath, manifestPath } from "../src/home.ts";
import { mkTmp, cleanup } from "./helpers.ts";
import { fakeClone, type FixtureSkill } from "./server-helpers.ts";
import type { ManifestReadModel } from "@skillforge/contracts";

after(cleanup);

const GIT_INPUT = "https://github.com/owner/repo";
const FIXTURES: FixtureSkill[] = [
  { slug: "alpha", name: "Alpha", description: "resize and crop images" },
  { slug: "beta", name: "Beta", description: "parse and query csv files" },
  { slug: "gamma", name: "Gamma", description: "draft and send professional email" },
];

function readManifest(home: string): ManifestReadModel {
  return JSON.parse(fs.readFileSync(manifestPath(home), "utf8")) as ManifestReadModel;
}
/** Discard the DB files WITHOUT a clean shutdown of the manifest — the "DB lost, read-model survives" crash. */
function dropDb(home: string): void {
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(dbPath(home) + ext, { force: true });
}

test("crash recovery: DB lost → restart rebuilds the DB + manifest from sources/ with NOTHING lost (ids stable)", async () => {
  const home = mkTmp("skf-crash-rebuild-");
  const clone = fakeClone(() => FIXTURES);

  // ── arrange: a healthy daemon with a published read-model ──
  const d1 = createDaemon({ home, clone });
  const add = await d1.ingest.addSource(GIT_INPUT);
  assert.equal(add.added, 3, "three skills ingested");
  const idsBefore = d1.persistence.store.list().map((s) => s.id).sort();
  const mfBefore = readManifest(home);
  assert.equal(mfBefore.skills.length, 3, "the manifest was published with all three skills");
  await d1.stop(); // clean DB close so the files can be removed

  // ── act: simulate a crash that loses the DB; the sources/ trees + the manifest survive ──
  dropDb(home);
  assert.ok(!fs.existsSync(dbPath(home)), "the DB file is gone (crash)");
  assert.ok(fs.existsSync(manifestPath(home)), "the materialized read-model manifest survived");

  const d2 = createDaemon({ home, clone, port: 0, reachable: async () => false });
  try {
    // BEFORE the restart serves: the surviving manifest claims state the freshly-opened (empty, seq-seeded)
    // DB does NOT hold → this MUST be reported stale (a crash seq/dbRevision skew), never served as fresh.
    const before = d2.persistence.staleness();
    assert.equal(d2.persistence.store.skillCount(), 0, "the reopened DB starts empty (it was lost)");
    assert.equal(before.stale, true, "a manifest that the empty DB does not back is reported STALE (never silently fresh)");
    assert.match(before.reason ?? "", /crash|dbRevision|does not back|unverified/i, "the staleness reason names the seq/dbRevision skew");

    // ── recover THROUGH THE REAL RESTART PATH: start() rebuilds the DB from sources/ BEFORE serving (it
    //    only rebuilds when the DB is empty), then republishes the manifest. No manual rebuild call. ──
    await d2.start();
    assert.equal(d2.persistence.store.skillCount(), 3, "start() rebuilt the DB from sources/ before serving — nothing lost");

    const idsAfter = d2.persistence.store.list().map((s) => s.id).sort();
    assert.deepEqual(idsAfter, idsBefore, "rebuilt skill ids are IDENTICAL (sourceId dir name reproduces shortId)");

    const mfAfter = readManifest(home);
    assert.deepEqual(mfAfter.skills.map((s) => s.slug).sort(), ["alpha", "beta", "gamma"], "the manifest was re-derived with the full skill set");

    // AFTER the restart: the manifest now backs the DB → fresh again.
    const after = d2.persistence.staleness();
    assert.equal(after.stale, false, "once rebuilt + republished, the read-model is fresh");
  } finally {
    await d2.stop();
  }
});

test("crash recovery preserves user enable/grant state — a DISABLED skill is NOT silently re-enabled, a still-valid grant survives (§6)", async () => {
  const home = mkTmp("skf-crash-state-");
  const clone = fakeClone(() => FIXTURES);

  // ── arrange: ingest, then CUSTOMIZE the user state away from the all-default seed ──
  const d1 = createDaemon({ home, clone });
  await d1.ingest.addSource(GIT_INPUT);
  const beforeList = d1.persistence.store.list();
  const beta = beforeList.find((s) => s.slug === "beta")!;
  const alpha = beforeList.find((s) => s.slug === "alpha")!;
  d1.persistence.store.setEnabled(beta.id, "mcp", false); // a user "this skill is wrong here" DISABLE
  d1.persistence.store.setExecAllowed(alpha.id, alpha.contentHash, true); // a reviewed, hash-bound exec grant
  d1.persistence.publishManifest(); // the surviving read-model now carries the CUSTOM state
  assert.equal(d1.persistence.store.get(beta.id)!.enabledFor.mcp, false);
  assert.equal(d1.persistence.store.get(alpha.id)!.execAllowed, true);
  await d1.stop();

  // ── act: crash (DB lost, sources/ + manifest survive) → restart through start() ──
  dropDb(home);
  const d2 = createDaemon({ home, clone, port: 0, reachable: async () => false });
  try {
    await d2.start(); // rebuild RESTORES enable/grant from the surviving manifest — must NOT fail open
    const after = d2.persistence.store.list();
    const beta2 = after.find((s) => s.slug === "beta")!;
    const alpha2 = after.find((s) => s.slug === "alpha")!;
    const gamma2 = after.find((s) => s.slug === "gamma")!;

    assert.equal(beta2.enabledFor.mcp, false, "the user DISABLE survived the rebuild — a known-bad skill was NOT silently re-enabled (§6)");
    assert.equal(beta2.enabledFor.lmstudio, true, "only mcp was disabled; beta stays enabled for the other targets");
    assert.equal(gamma2.enabledFor.mcp, true, "an untouched skill keeps the default-enabled state");
    assert.equal(alpha2.execAllowed, true, "the still-valid (content-unchanged) exec grant survived the rebuild (D10 hash match)");
  } finally {
    await d2.stop();
  }
});

test("crash window: a DB write that committed before the manifest rewrite is surfaced as STALENESS on restart (DB AHEAD)", async () => {
  const home = mkTmp("skf-crash-window-");
  const clone = fakeClone(() => FIXTURES);

  const d1 = createDaemon({ home, clone });
  await d1.ingest.addSource(GIT_INPUT); // publishes a synced manifest (seq == dbRevision == manifest's)
  const synced = d1.persistence.staleness();
  assert.equal(synced.stale, false, "precondition: the published manifest is in sync with the DB");

  // SIMULATE THE CRASH WINDOW: a store mutation COMMITS to the DB (durable — synchronous=FULL) but the
  // process dies BEFORE publishManifest() rewrites the read-model. We reproduce exactly that: bump the DB,
  // do NOT publish.
  const target = d1.persistence.store.list()[0]!;
  d1.persistence.store.setEnabled(target.id, "mcp", false); // DB seq/dbRevision advance; manifest untouched
  await d1.stop();

  // restart over the same home: the DB (durable) is AHEAD of the on-disk manifest.
  const d2 = createDaemon({ home, clone });
  try {
    const report = d2.persistence.staleness();
    assert.equal(report.stale, true, "the DB is ahead of the manifest → STALE (the crash-window write is not silently lost)");
    assert.ok(report.daemonSeq > report.manifestSeq, "the DB seq advanced past the published manifest seq");
    assert.match(report.reason ?? "", /BEHIND|advanced/i, "the reason names the un-republished DB advance");

    // and recovery is a republish: deriving from the DB makes the read-model fresh again.
    d2.persistence.publishManifest();
    assert.equal(d2.persistence.staleness().stale, false, "republishing from the DB clears the staleness");
  } finally {
    await d2.stop();
  }
});

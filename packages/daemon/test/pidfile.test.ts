// @skillforge/daemon/test/pidfile — the OS writer lock: atomic create, stale-pid recovery, no-steal.
//
// NOTE ON "real dead-pid" coverage: we deliberately do NOT spawn a child to obtain a genuinely-dead pid
// — that would import node:child_process into a daemon package, violating the PLAN §2 structural guard
// ("no child_process outside core/src/exec/"). Instead the REAL liveness probe (pidIsAlive) is exercised
// on a real alive pid (process.pid) in the refuse path, and the dead-pid RECLAIM mechanics (rename CAS,
// atomic wx re-create) run against the real filesystem with the liveness oracle stubbed false. The
// oracle itself is unit-tested directly.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { acquireWriterLock, WriterLockError, pidIsAlive } from "../src/lock/pidfile.ts";
import { mkTmp, cleanup } from "./helpers.ts";

after(cleanup);

function pidPath(): string {
  return path.join(mkTmp("skf-d-pid-"), "writer.pid");
}
function readRec(p: string): { pid: number; cookie?: string } {
  return JSON.parse(fs.readFileSync(p, "utf8")) as { pid: number; cookie?: string };
}

test("acquire: atomically writes our {pid,cookie} record; release removes the lockfile", () => {
  const p = pidPath();
  const lock = acquireWriterLock(p);
  assert.equal(lock.pid, process.pid);
  assert.ok(typeof lock.cookie === "string" && lock.cookie.length > 0);
  const rec = readRec(p);
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.cookie, lock.cookie);
  lock.release();
  assert.equal(fs.existsSync(p), false, "release removes the lockfile while it holds our identity");
});

test("live pid REFUSES: a lockfile held by a different live process is not stolen (real liveness probe)", () => {
  const p = pidPath();
  // process.pid is genuinely alive (exercises the REAL probe). We claim with a DIFFERENT pid so the
  // holder (process.pid) is seen as "another live writer".
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, cookie: "held" }), "utf8");
  assert.equal(pidIsAlive(process.pid), true, "sanity: the real liveness probe sees this process as alive");
  assert.throws(
    () => acquireWriterLock(p, { pid: process.pid + 1 }),
    WriterLockError,
    "a live, different-pid holder must be refused",
  );
  assert.equal(readRec(p).pid, process.pid, "the holder's record is untouched (we did not steal it)");
});

test("stale (dead) pid RECLAIMS: the dead-pid lockfile is reclaimed via the rename-CAS + atomic re-create", () => {
  const p = pidPath();
  fs.writeFileSync(p, JSON.stringify({ pid: 424242, cookie: "corpse" }), "utf8"); // a crashed daemon's leftover
  const lock = acquireWriterLock(p, { pid: 777, cookie: "fresh", isAlive: () => false });
  assert.equal(lock.pid, 777);
  assert.equal(readRec(p).pid, 777, "the stale lockfile is reclaimed with our record");
  assert.equal(readRec(p).cookie, "fresh");
  // no .stale-* reclaim temp left behind
  const leftovers = fs.readdirSync(path.dirname(p)).filter((n) => n.includes(".stale-"));
  assert.deepEqual(leftovers, []);
  lock.release();
});

test("a legacy bare-pid lockfile holding a dead pid is reclaimed (back-compat with a manual pidfile)", () => {
  const p = pidPath();
  fs.writeFileSync(p, "424242", "utf8"); // bare pid, no JSON record
  const lock = acquireWriterLock(p, { pid: 888, cookie: "c", isAlive: () => false });
  assert.equal(readRec(p).pid, 888);
  lock.release();
});

test("EXACTLY ONE WINS: two acquisitions on the same path resolve to a single holder (the second refuses)", () => {
  const p = pidPath();
  const first = acquireWriterLock(p); // wx-creates the lock
  // a second acquisition (same process, a DIFFERENT fresh cookie) must NOT also win — the holder is a
  // live, non-identical writer → refuse. This is the single-threaded analogue of a concurrent-start race.
  assert.throws(() => acquireWriterLock(p), WriterLockError, "exactly one acquisition may hold the lock");
  assert.equal(readRec(p).cookie, first.cookie, "the first holder's record is intact");
  first.release();
  // once released, a fresh acquisition succeeds
  const third = acquireWriterLock(p);
  assert.equal(third.pid, process.pid);
  third.release();
});

test("release: never steals a successor's lock (removes only while it still holds our pid AND cookie)", () => {
  const p = pidPath();
  const lock = acquireWriterLock(p, { pid: 555, cookie: "mine", isAlive: () => false });
  // a successor reclaims the lock (simulating our crash + another writer taking over)
  fs.writeFileSync(p, JSON.stringify({ pid: 999, cookie: "theirs" }), "utf8");
  lock.release(); // must be a no-op: the record no longer carries our identity
  assert.equal(readRec(p).pid, 999, "release must not delete a successor's lockfile");
});

test("release: does NOT delete a file that reused our pid but with a different cookie", () => {
  const p = pidPath();
  const lock = acquireWriterLock(p, { pid: 555, cookie: "A", isAlive: () => false });
  fs.writeFileSync(p, JSON.stringify({ pid: 555, cookie: "B" }), "utf8"); // same pid, new instance
  lock.release();
  assert.ok(fs.existsSync(p), "a same-pid successor with a different cookie keeps its lock");
});

test("pidIsAlive: rejects non-positive / non-integer pids and confirms self is alive", () => {
  assert.equal(pidIsAlive(0), false);
  assert.equal(pidIsAlive(-1), false);
  assert.equal(pidIsAlive(1.5), false);
  assert.equal(pidIsAlive(process.pid), true);
});

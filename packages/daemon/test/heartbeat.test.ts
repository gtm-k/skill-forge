// @skillforge/daemon/test/heartbeat — the mtime WRITER-HEARTBEAT staleness signal (PID-reuse-proof).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { heartbeatAwareIsAlive, makeHeartbeatAcquire, startHeartbeat } from "../src/server/heartbeat.ts";
import { WriterLockError } from "../src/lock/pidfile.ts";
import { mkTmp, cleanup } from "./helpers.ts";

after(cleanup);

/** Write a writer.pid record claimed by `pid`, then back-date its mtime by `ageMs`. */
function writePidfile(pidfilePath: string, pid: number, ageMs: number): void {
  fs.writeFileSync(pidfilePath, JSON.stringify({ pid, cookie: "fixture", startedAt: new Date().toISOString() }));
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(pidfilePath, when, when);
}

// A no-op sync sleep so the confirmation re-check does not actually block the test thread.
const NO_SLEEP = (): void => {};

test("heartbeatAwareIsAlive: a SUSTAINED stale mtime reports the holder DEAD even when its pid is alive", () => {
  const home = mkTmp("skf-hb-stale-");
  const pidfile = path.join(home, "writer.pid");
  writePidfile(pidfile, process.pid, 60_000); // our pid (definitely alive) but a 60s-old mtime

  // both observations read the same stale file (no heartbeat resumed) → confirmed dead.
  const isAlive = heartbeatAwareIsAlive(pidfile, { staleAfterMs: 5_000, confirmDelayMs: 0, sleep: NO_SLEEP, baseIsAlive: () => true });
  assert.equal(isAlive(process.pid), false, "a SUSTAINED stale mtime overrides pid-liveness (a reused pid can't keep mtime fresh)");
});

test("heartbeatAwareIsAlive: a FRESH mtime defers to the base liveness probe (live holder stays alive)", () => {
  const home = mkTmp("skf-hb-fresh-");
  const pidfile = path.join(home, "writer.pid");
  writePidfile(pidfile, process.pid, 0); // fresh

  const isAlive = heartbeatAwareIsAlive(pidfile, { staleAfterMs: 5_000, sleep: NO_SLEEP, baseIsAlive: () => true });
  assert.equal(isAlive(process.pid), true, "a fresh mtime ⇒ trust the base probe");
});

test("heartbeatAwareIsAlive: a SINGLE TRANSIENT stale beat does NOT reclaim — the holder recovers mid-confirmation (D9)", () => {
  const home = mkTmp("skf-hb-transient-");
  const pidfile = path.join(home, "writer.pid");

  // simulate a live holder that missed ONE beat then resumed: the first observation is stale, the
  // confirmation re-check (after the interval) sees a FRESH mtime (the heartbeat caught up).
  const now = 1_000_000;
  const mtimes = [now - 60_000, now]; // obs1: 60s old (stale); obs2: fresh
  let call = 0;
  const isAlive = heartbeatAwareIsAlive(pidfile, {
    staleAfterMs: 5_000,
    confirmDelayMs: 1_000,
    sleep: NO_SLEEP,
    nowMs: () => now,
    readMtimeMs: () => mtimes[call++],
    baseIsAlive: () => true,
  });
  assert.equal(isAlive(123), true, "a transient stale beat that recovers within the interval must NOT reclaim a live lock");
});

test("makeHeartbeatAcquire: RECLAIMS a sustained-stale holder, but REFUSES a fresh live holder", () => {
  const home = mkTmp("skf-hb-acquire-");
  const pidfile = path.join(home, "writer.pid");

  // sustained-stale holder → reclaimable: acquisition succeeds and rewrites the file with OUR identity.
  writePidfile(pidfile, process.pid, 60_000);
  const acquire = makeHeartbeatAcquire({ staleAfterMs: 5_000, confirmDelayMs: 0, sleep: NO_SLEEP, baseIsAlive: () => true });
  const lock = acquire(pidfile);
  const rec = JSON.parse(fs.readFileSync(pidfile, "utf8")) as { cookie: string };
  assert.notEqual(rec.cookie, "fixture", "the stale holder was reclaimed (our cookie now owns the lock)");
  lock.release();

  // fresh live holder → refused (the sole-writer guarantee holds for a real running writer).
  writePidfile(pidfile, process.pid, 0);
  assert.throws(() => acquire(pidfile), WriterLockError, "a fresh, live holder is never stolen");
});

test("startHeartbeat: refreshes the pidfile mtime (a once-stale holder becomes non-stale)", () => {
  const home = mkTmp("skf-hb-refresh-");
  const pidfile = path.join(home, "writer.pid");
  writePidfile(pidfile, process.pid, 60_000);
  const before = fs.statSync(pidfile).mtimeMs;

  const hb = startHeartbeat(pidfile, 10_000); // beats immediately on start
  try {
    const after = fs.statSync(pidfile).mtimeMs;
    assert.ok(after > before, "the immediate beat refreshed the mtime");
    const isAlive = heartbeatAwareIsAlive(pidfile, { staleAfterMs: 5_000, sleep: NO_SLEEP, baseIsAlive: () => true });
    assert.equal(isAlive(process.pid), true, "the refreshed holder is no longer stale");
  } finally {
    hb.stop();
  }
});

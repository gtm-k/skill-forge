// @skillforge/daemon/server/heartbeat — the mtime WRITER-HEARTBEAT W1a deferred (§5, PID-reuse-proof).
//
// W1a's pidfile lock has a documented HUMBLE LIMIT: Node cannot read a FOREIGN pid's start time, so if a
// dead writer's pid is later reused by an unrelated LIVE process, that pid reads as alive and the lock is
// conservatively REFUSED (a false-refuse, recoverable only by deleting writer.pid). The heartbeat closes
// that gap: a running daemon periodically refreshes writer.pid's MTIME, and lock acquisition treats a
// holder whose mtime is sustained-stale as DEAD/reclaimable EVEN IF its pid reads alive — a reused pid
// belongs to some unrelated process that is NOT keeping OUR pidfile's mtime fresh.
//
// FALSE-RECLAIM HARDENING (D9 — two writers is the cardinal sin): a LIVE holder can briefly miss a beat
// (a long synchronous cpSync/fsync/rmSync, a GC pause, swap). A single stale observation must therefore
// NOT reclaim. Two defences:
//   1. STALE_AFTER_MS is set to 10× the interval — comfortably above any realistic main-loop pause.
//   2. CONFIRMATION: on a stale observation we sleep one interval and RE-CHECK; only if it is STILL
//      stale (the holder's heartbeat did NOT resume) do we report it dead. A holder that beats during the
//      confirmation window is recognized as alive and the lock is REFUSED. So a reclaim requires two
//      observations spaced by the interval, both stale — a transient pause cannot steal a live lock.
// Integration is via W1a's existing `isAlive` injection point: we wrap pidIsAlive; acquireWriterLock runs
// its OWN robust atomic-rename reclaim for the (confirmed-dead) holder — we add a signal, not a new lock.
import fs from "node:fs";
import { acquireWriterLock, pidIsAlive, type AcquireOptions, type WriterLock } from "../lock/pidfile.ts";

/** How often the running daemon refreshes writer.pid's mtime. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** A holder whose mtime is older than this is treated as a candidate dead writer (≈ 10 missed beats —
 *  far above a realistic synchronous main-loop pause). A reclaim ALSO requires the confirmation re-check. */
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 10;

/** Synchronous sleep without a dependency or CPU spin (mirrors safe/io.ts) — used to space the two
 *  staleness observations by one interval during lock acquisition (startup is allowed to block briefly). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface HeartbeatOptions {
  intervalMs?: number;
  staleAfterMs?: number;
  /** delay between the two staleness observations (defaults to one interval). */
  confirmDelayMs?: number;
  /** liveness probe to fall back on when the mtime is FRESH (defaults to the signal-0 pid probe). */
  baseIsAlive?: (pid: number) => boolean;
  /** clock override (tests inject a fixed/controllable now). */
  nowMs?: () => number;
  /** mtime reader override (tests inject a sequence to simulate a heartbeat resuming mid-confirmation). */
  readMtimeMs?: () => number | undefined;
  /** sync sleep override (tests pass a no-op so the confirmation does not actually block). */
  sleep?: (ms: number) => void;
}

function resolveOpts(pidfilePath: string, opts: HeartbeatOptions) {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  return {
    staleAfterMs: opts.staleAfterMs ?? Math.max(STALE_AFTER_MS, intervalMs * 10),
    confirmDelayMs: opts.confirmDelayMs ?? intervalMs,
    baseIsAlive: opts.baseIsAlive ?? pidIsAlive,
    nowMs: opts.nowMs ?? Date.now,
    sleep: opts.sleep ?? sleepSync,
    readMtimeMs:
      opts.readMtimeMs ??
      ((): number | undefined => {
        try {
          return fs.statSync(pidfilePath).mtimeMs;
        } catch {
          return undefined; // no/unreadable pidfile → not a heartbeat decision
        }
      }),
  };
}

/**
 * Build an `isAlive` predicate that reports a holder DEAD only when `pidfilePath`'s mtime is stale across
 * TWO observations spaced by `confirmDelayMs`, and otherwise defers to the base pid-liveness probe. A
 * missing / unstattable pidfile is left to the base probe (the file race is W1a's atomic-create concern).
 */
export function heartbeatAwareIsAlive(pidfilePath: string, opts: HeartbeatOptions = {}): (pid: number) => boolean {
  const { staleAfterMs, confirmDelayMs, baseIsAlive, nowMs, sleep, readMtimeMs } = resolveOpts(pidfilePath, opts);
  const isStale = (): boolean => {
    const m = readMtimeMs();
    return m !== undefined && nowMs() - m > staleAfterMs;
  };
  return (pid: number): boolean => {
    if (!isStale()) return baseIsAlive(pid); // fresh ⇒ trust the base probe (a live holder)
    // First observation is stale. Confirm it is SUSTAINED before treating the holder as dead: a live
    // holder briefly starved (long sync op / GC) will resume beating within the interval and read fresh.
    sleep(confirmDelayMs);
    if (!isStale()) return baseIsAlive(pid); // heartbeat resumed ⇒ holder is alive, do NOT reclaim
    return false; // stale across two observations ⇒ confirmed dead, reclaimable
  };
}

/**
 * An `acquireWriterLock`-compatible function (the shape createPersistence's `acquireLock` option expects)
 * that injects the heartbeat-aware liveness probe. A holder confirmed stale across two observations is
 * reclaimed by W1a's own atomic-rename CAS; a FRESH (or recovering) live holder is refused (sole-writer).
 */
export function makeHeartbeatAcquire(opts: HeartbeatOptions = {}): typeof acquireWriterLock {
  return (pidfilePath: string, acquireOpts: AcquireOptions = {}): WriterLock =>
    acquireWriterLock(pidfilePath, { ...acquireOpts, isAlive: heartbeatAwareIsAlive(pidfilePath, opts) });
}

export interface Heartbeat {
  /** stop refreshing the mtime (idempotent). */
  stop(): void;
}

/**
 * Start refreshing `pidfilePath`'s mtime every `intervalMs` (touch via utimes). The timer is `unref`'d so
 * it never keeps the event loop alive on its own (the http server keeps the daemon up; tests can exit).
 * A touch failure is surfaced (never silent) but does not crash the daemon — the next beat retries.
 */
export function startHeartbeat(pidfilePath: string, intervalMs: number = HEARTBEAT_INTERVAL_MS): Heartbeat {
  const beat = (): void => {
    try {
      const t = new Date();
      fs.utimesSync(pidfilePath, t, t);
    } catch (e) {
      console.warn(`[skillforge/daemon] heartbeat touch failed for ${pidfilePath}: ${(e as Error).message}`);
    }
  };
  beat(); // stamp immediately so the freshly-acquired lock starts non-stale
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

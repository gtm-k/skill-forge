// @skillforge/daemon/lock/pidfile — the OS-level cross-process writer lock (§5, R1 MINOR).
//
// Two daemons must never both write the DB/manifest (sole-writer, D9). The lock is acquired by an
// ATOMIC exclusive create — fs.openSync(path, "wx") — so when two daemons race on startup the OS picks
// exactly one winner; the loser gets EEXIST and falls to the holder check below. (The earlier
// read→check→write had a TOCTOU window where both racers passed the gate — BLOCKER fix.)
//
// Holder check (loser of the create / a leftover file):
//   - holder pid is ALIVE  → REFUSE (a live writer owns it). We never reclaim a live holder — that is
//     the sole-writer guarantee, so it holds even under PID reuse (see the residual limit below).
//   - holder pid is DEAD   → RECLAIM atomically: rename the stale file away (a compare-and-swap — exactly
//     one reclaimer wins the rename; the rest get ENOENT and re-evaluate), then retry the `wx` create.
//
// Each acquisition stamps a random COOKIE alongside the pid. The cookie makes identity PRECISE where we
// can decide it: release() deletes the file only when BOTH pid AND cookie are still ours (never steals a
// successor that happened to reuse our pid), and two acquisitions in one process (same pid, different
// cookie) correctly resolve to one winner. HUMBLE LIMIT (documented like the path.ts TOCTOU/hardlink
// limits): Node has no portable API to read a FOREIGN pid's start time, so if a DEAD writer's pid is
// later reused by an unrelated LIVE process, that pid reads as alive and the lock is conservatively
// refused (recovered by deleting writer.pid, or by the server wave's mtime-heartbeat staleness). We
// choose a possible false-refuse over the unacceptable false-reclaim of a live writer.
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const RECLAIM_MAX_ATTEMPTS = 25;
// rename contention codes where the right move is to re-evaluate the holder rather than fail hard.
const CONTENDED = new Set(["ENOENT", "EPERM", "EBUSY", "EACCES"]);

export class WriterLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterLockError";
  }
}

export interface WriterLock {
  /** the pid written into the lockfile (this process). */
  pid: number;
  /** the per-acquisition identity cookie written alongside the pid. */
  cookie: string;
  path: string;
  /** remove the lockfile IFF it still holds OUR pid AND cookie (never steal a successor's lock). */
  release(): void;
}

export interface AcquireOptions {
  /** the pid to claim with (defaults to process.pid). Injectable so tests can simulate "another process". */
  pid?: number;
  /** the identity cookie (defaults to a fresh uuid). Injectable for deterministic tests. */
  cookie?: string;
  /** liveness predicate (defaults to a signal-0 probe). Injectable so tests are deterministic. */
  isAlive?: (pid: number) => boolean;
}

interface LockRecord {
  pid: number;
  cookie?: string;
  startedAt?: string;
}

/** Default liveness probe: signal 0 reaches a live process; EPERM means it exists but isn't ours. */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM"; // exists, just not signalable by us
  }
}

function readRecord(pidfilePath: string): LockRecord | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(pidfilePath, "utf8").trim();
  } catch {
    return undefined; // absent / unreadable → treat as no holder
  }
  if (raw === "") return undefined;
  if (raw.startsWith("{")) {
    try {
      const o = JSON.parse(raw) as { pid?: unknown; cookie?: unknown; startedAt?: unknown };
      const pid = Number(o.pid);
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      return {
        pid,
        cookie: typeof o.cookie === "string" ? o.cookie : undefined,
        startedAt: typeof o.startedAt === "string" ? o.startedAt : undefined,
      };
    } catch {
      return undefined; // a corrupt lock record is treated as no decodable holder → reclaimable
    }
  }
  const n = Number(raw); // tolerate a legacy / manually-written bare pid
  return Number.isInteger(n) && n > 0 ? { pid: n } : undefined;
}

function writeLockFileExclusive(pidfilePath: string, record: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(pidfilePath, "wx"); // ATOMIC exclusive create — the OS picks one winner on a race
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") return false;
    throw e;
  }
  try {
    fs.writeFileSync(fd, record);
    fs.fsyncSync(fd); // durability: the pid is on disk before we report the lock held
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Acquire the writer lock at `pidfilePath`. Atomic exclusive create; on contention, refuse a live holder
 * and atomically reclaim a dead one. Throws WriterLockError if a live writer holds it (or the reclaim
 * race could not be resolved within the attempt cap). release() removes the file only while it still
 * holds our identity.
 */
export function acquireWriterLock(pidfilePath: string, opts: AcquireOptions = {}): WriterLock {
  const myPid = opts.pid ?? process.pid;
  const myCookie = opts.cookie ?? randomUUID();
  const isAlive = opts.isAlive ?? pidIsAlive;
  const record = JSON.stringify({ pid: myPid, cookie: myCookie, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < RECLAIM_MAX_ATTEMPTS; attempt++) {
    if (writeLockFileExclusive(pidfilePath, record)) {
      return makeLock(myPid, myCookie, pidfilePath);
    }
    // EEXIST: a file is already there. Decide live-holder (refuse) vs dead-holder (reclaim).
    const holder = readRecord(pidfilePath);
    const exactlyUs = holder?.pid === myPid && holder?.cookie !== undefined && holder.cookie === myCookie;
    if (holder && !exactlyUs && isAlive(holder.pid)) {
      throw new WriterLockError(
        `another SkillForge writer holds the lock (pid ${holder.pid} is alive at ${JSON.stringify(pidfilePath)}); refusing to start a second writer`,
      );
    }
    // dead holder (or exactly us / an undecodable record) → reclaim atomically via a rename CAS: exactly
    // one reclaimer renames the stale file away; the rest get ENOENT and loop to re-evaluate.
    const claimed = `${pidfilePath}.stale-${myCookie}-${attempt}`;
    try {
      fs.renameSync(pidfilePath, claimed);
      fs.rmSync(claimed, { force: true });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code && CONTENDED.has(code)) continue; // lost the reclaim race / transient win32 lock → re-evaluate
      throw e;
    }
    // path is now (momentarily) gone → loop and retry the exclusive create.
  }
  throw new WriterLockError(
    `could not acquire writer lock at ${JSON.stringify(pidfilePath)} after ${RECLAIM_MAX_ATTEMPTS} attempts (reclaim contention)`,
  );
}

function makeLock(myPid: number, myCookie: string, pidfilePath: string): WriterLock {
  return {
    pid: myPid,
    cookie: myCookie,
    path: pidfilePath,
    release(): void {
      try {
        const holder = readRecord(pidfilePath);
        if (holder && holder.pid === myPid && holder.cookie === myCookie) {
          fs.rmSync(pidfilePath, { force: true });
        }
      } catch {
        /* best-effort release */
      }
    },
  };
}

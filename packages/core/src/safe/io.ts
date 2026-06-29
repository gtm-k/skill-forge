// @skillforge/core/safe/io — Windows-safe atomic write + tolerant read for the read-model (D20, §5).
// The manifest.json the plugin/UI consume must never be observed half-written: we write a sibling
// temp file, fsync it, then atomically rename over the target. On win32 the rename can fail
// transiently (antivirus / indexer / a concurrent reader holds a lock) — so we retry the SAME rename
// with a tiny synchronous backoff. We never delete the published destination: renameSync already
// replaces it atomically (MOVEFILE_REPLACE_EXISTING on win32, rename(2) on POSIX), so the published
// path is always either the old bytes or the new bytes, never absent.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const RENAME_MAX_ATTEMPTS = 5;
// Transient win32 lock codes where a short retry of the rename is the right move. Kept minimal per
// review guidance (EACCES dropped): since we no longer unlink the dest, retrying is always
// atomicity-safe, but a genuine EACCES is a permission fault that a backoff will not clear, so it
// fails fast and surfaces to the caller rather than spinning.
const TRANSIENT = new Set(["EPERM", "EBUSY", "EEXIST"]);

/** Synchronous sleep without a dependency or a CPU spin — blocks the thread for `ms`. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmp: string, file: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmp, file); // POSIX + win32 (MOVEFILE_REPLACE_EXISTING) replace atomically
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      lastErr = e;
      if (code && TRANSIENT.has(code)) {
        // win32 can transiently refuse rename-over-existing while the dest is locked (AV/indexer/
        // concurrent reader). Back off and RETRY the same rename — we deliberately do NOT delete the
        // dest first: deleting opens a crash window where the published file is gone, breaking the
        // atomic-replace guarantee. renameSync replaces atomically, so the old file survives until
        // the new bytes land. On final failure lastErr is thrown and the caller removes the temp.
        sleepSync(5 * (attempt + 1));
        continue;
      }
      throw e; // non-transient — fail fast
    }
  }
  throw lastErr;
}

/**
 * Atomically write `data` to `file`: temp sibling -> fsync -> rename. The temp file is removed on
 * any failure (and never lingers on success, since it is renamed away). Survives transient win32
 * file locking via bounded retry.
 */
export function atomicWriteFile(file: string, data: string | Uint8Array): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd); // durability: bytes hit disk before the rename publishes them
    } finally {
      fs.closeSync(fd); // must close before rename on win32 (cannot rename an open handle)
    }
    renameWithRetry(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort cleanup */
    }
    throw e;
  }
}

// §5: the manifest is UNTRUSTED. JSON.parse materializes a literal "__proto__" key as a real OWN
// property (and "constructor"/"prototype" likewise) — harmless until a downstream recursive merge
// promotes it to genuine Object.prototype pollution. We strip the three pollution vectors here at the
// trust boundary: a reviver that returns undefined deletes the key at every nesting level. None of
// the read-model contract types use these names, so dropping them never discards real data.
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function dropPoisonKeys(key: string, value: unknown): unknown {
  return POISON_KEYS.has(key) ? undefined : value;
}

/**
 * Read + JSON.parse `file`, NEVER throwing. On ENOENT / parse error / empty file, return
 * `lastGood` (or undefined). This is the last-good fallback when a manifest is mid-write or
 * was left partially written — the caller keeps serving the previous good read-model.
 * Prototype-pollution keys are stripped during parse (see `dropPoisonKeys`).
 */
export function readJsonTolerant<T>(file: string, lastGood?: T): T | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.trim() === "") return lastGood;
    return JSON.parse(raw, dropPoisonKeys) as T;
  } catch {
    return lastGood;
  }
}

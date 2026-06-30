// @skillforge/core/safe/path — path containment for untrusted skill trees (D20, §5).
// Skills come from untrusted git/zip. The inject/exec gate must act on REAL on-disk bytes
// under an intended root — so it resolves the actual absolute path here, then reads those
// bytes, never a stored path string.
//
// HUMBLE FRAMING: these checks report only what we can OBSERVE on disk right now. They are a
// structural containment guard, NOT a "safe"/"trusted" verdict. Two limits we do not hide:
//   1. TOCTOU — the filesystem can mutate between this check and the caller's open()/read().
//      Resolving the realpath narrows but cannot close that window on a mutable FS.
//   2. Hardlinks — a hardlink is byte-identical to a regular file via lstat (same inode, not a
//      symlink), so we CANNOT detect a hardlink whose target lives outside the root. We reject
//      symlink escape and rely on resolveUnderRoot's realpath check for everything else.
import fs from "node:fs";
import path from "node:path";

/** Thrown when a candidate path resolves outside its intended root. */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

// Prefer the OS-native realpath where available (canonical casing on win32, resolves UNC /
// \\wsl$\ paths). Falls back to the JS implementation if the native variant is ever absent.
const realpathFn: (p: string) => string =
  typeof fs.realpathSync.native === "function" ? fs.realpathSync.native : fs.realpathSync;

/**
 * realpath the deepest EXISTING prefix of `absPath`, then re-append the not-yet-existing tail.
 * A write target may not exist yet, so we cannot realpath the whole path; but we must canonicalize
 * the part that does exist (to defeat symlinks in the existing prefix).
 *
 * Only ENOENT (a genuinely-missing component) is tolerated by walking up to the parent. ANY OTHER
 * error code — EACCES (unreadable), ELOOP (symlink loop), ENOTDIR (a file used as a directory) — is
 * RETHROWN, never downgraded to "missing". Swallowing those would be a silent failure (violates the
 * never-silent invariant) AND a containment bypass: an ELOOP component must be rejected, not skipped
 * past as though it were an empty write tail. The error code is read structurally, as io.ts does.
 */
function realpathDeepestExisting(absPath: string): string {
  const tail: string[] = [];
  let cur = absPath;
  for (;;) {
    try {
      const real = realpathFn(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") throw e; // surface real failures
      const parent = path.dirname(cur);
      if (parent === cur) return absPath; // reached a filesystem root; nothing existed
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// path.relative is platform-aware: on win32 (process.platform === "win32") it compares
// case-insensitively, which is exactly the containment semantics we need on NTFS. So a "rel"
// that does NOT begin with ".." and is NOT absolute means `child` is inside `from`.
function escapesRoot(rel: string): boolean {
  if (rel === "") return false; // identical to root — contained
  if (path.isAbsolute(rel)) return true;
  return rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../");
}

/**
 * Resolve `candidate` (relative to `root`, OR absolute) to an absolute path, canonicalizing the
 * deepest existing prefix via realpath, and assert the result stays within realpath(root).
 * Returns the safe absolute path the caller should actually read/write. Throws PathEscapeError
 * on escape. The full path need not exist yet (write targets are allowed).
 */
export function resolveUnderRoot(root: string, candidate: string): string {
  const realRoot = realpathDeepestExisting(path.resolve(root));
  // path.resolve drops `realRoot` when `candidate` is absolute, and joins it when relative.
  const absCandidate = path.resolve(realRoot, candidate);
  const realCandidate = realpathDeepestExisting(absCandidate);
  const rel = path.relative(realRoot, realCandidate);
  if (escapesRoot(rel)) {
    throw new PathEscapeError(
      `path escapes root: ${JSON.stringify(candidate)} resolved to ${JSON.stringify(realCandidate)} outside ${JSON.stringify(realRoot)}`,
    );
  }
  return realCandidate;
}

/**
 * Walk each path component from root down to `candidate`; lstat each, and for any symlink
 * component realpath it and assert it still resolves under realpath(root). Stops at the first
 * non-existent component (write tails cannot be symlinks). Complements resolveUnderRoot — see the
 * hardlink/TOCTOU limits documented at the top of this file.
 */
export function assertNoSymlinkEscape(root: string, candidate: string): void {
  const realRoot = realpathDeepestExisting(path.resolve(root));
  const absCandidate = path.resolve(realRoot, candidate);
  const rel = path.relative(realRoot, absCandidate);
  if (escapesRoot(rel)) {
    throw new PathEscapeError(
      `path escapes root before symlink walk: ${JSON.stringify(candidate)} is not under ${JSON.stringify(realRoot)}`,
    );
  }
  const parts = rel === "" ? [] : rel.split(path.sep);
  let cur = realRoot;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      // Only a genuinely-absent component (ENOENT) ends the walk — a write tail cannot be a symlink.
      // EACCES / ELOOP / ENOTDIR are REAL failures: rethrow them rather than treat the component as
      // "not present", which would silently skip the containment check on an unreadable/looping path.
      if ((e as { code?: string }).code !== "ENOENT") throw e;
      break;
    }
    if (st.isSymbolicLink()) {
      const target = realpathDeepestExisting(cur);
      if (escapesRoot(path.relative(realRoot, target))) {
        throw new PathEscapeError(
          `symlink escapes root: ${JSON.stringify(cur)} -> ${JSON.stringify(target)} outside ${JSON.stringify(realRoot)}`,
        );
      }
    }
  }
}

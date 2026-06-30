// Safe path-containment + atomic IO gate (D20, §5). Real on-disk behavior over a temp tree —
// no network, no LM Studio. `safe` is not in the @skillforge/core barrel yet (orchestrator wires
// it), so we import the module directly by relative path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PathEscapeError,
  resolveUnderRoot,
  assertNoSymlinkEscape,
  atomicWriteFile,
  readJsonTolerant,
} from "../src/safe/index.ts";

let root: string;
const outsideDirs: string[] = []; // tracked sibling trees to clean up

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skf-safe-root-"));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of outsideDirs) fs.rmSync(d, { recursive: true, force: true });
});

test("resolveUnderRoot: legit nested path resolves to the real file", () => {
  const nested = path.join(root, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "file.txt"), "hello");

  const resolved = resolveUnderRoot(root, "a/b/file.txt");
  // Behavioral assertion: the returned path reads back the actual bytes on disk.
  assert.equal(fs.readFileSync(resolved, "utf8"), "hello");
});

test("resolveUnderRoot: not-yet-existing child stays under root and does not throw", () => {
  const realRoot = fs.realpathSync.native(root);
  const child = resolveUnderRoot(root, "a/b/new-file.txt");
  assert.ok(child.endsWith("new-file.txt"));
  const rel = path.relative(realRoot, child);
  assert.ok(!rel.startsWith(".."), `expected child under root, got rel=${rel}`);
  assert.ok(!fs.existsSync(child), "child should not exist yet");
});

test("resolveUnderRoot: rejects ../../etc/passwd with PathEscapeError", () => {
  assert.throws(() => resolveUnderRoot(root, "../../etc/passwd"), PathEscapeError);
});

test("resolveUnderRoot: rejects an absolute path outside root with PathEscapeError", () => {
  const outsideAbs = path.resolve(root, "..", "sibling-outside-target");
  assert.ok(path.isAbsolute(outsideAbs));
  assert.throws(() => resolveUnderRoot(root, outsideAbs), PathEscapeError);
});

test("resolveUnderRoot: allows an absolute path that is inside root", () => {
  const insideAbs = path.join(root, "a", "b", "file.txt"); // created in the first test
  fs.mkdirSync(path.dirname(insideAbs), { recursive: true });
  if (!fs.existsSync(insideAbs)) fs.writeFileSync(insideAbs, "x");
  assert.doesNotThrow(() => resolveUnderRoot(root, insideAbs));
});

test("resolveUnderRoot: an escaping path whose tail uses a FILE as a directory still throws PathEscapeError (the Linux ENOTDIR-masking regression)", () => {
  // Put a real FILE just outside root, then reference it AS A DIRECTORY in an escaping path. On Linux,
  // realpath() of such a tail fails with ENOTDIR; realpathDeepestExisting rightly rethrows non-ENOENT
  // codes, so WITHOUT a lexical pre-check that raw ENOTDIR escapes resolveUnderRoot BEFORE the containment
  // check and MASKS the escape (the caller sees a generic error, not PathEscapeError — which the UI handler
  // then maps to 404 instead of 400). The lexical pre-check must catch the escape first. (On win32 the same
  // realpath yields ENOENT, tolerated, so it resolved + escaped correctly there already — this reproduces
  // only on Linux/CI; the guard pins the contract on both.)
  const sibling = path.join(path.dirname(root), `skf-safe-file-${path.basename(root)}`);
  fs.writeFileSync(sibling, "x");
  outsideDirs.push(sibling); // cleaned up in after()
  const candidate = `../${path.basename(sibling)}/child.txt`; // escapes root; uses the file as a dir
  assert.throws(
    () => resolveUnderRoot(root, candidate),
    (e) => e instanceof PathEscapeError,
    "an escaping path must throw PathEscapeError even when its realpath tail would fail with ENOTDIR",
  );
});

test("assertNoSymlinkEscape: rejects a symlink pointing outside root", (t) => {
  const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), "skf-safe-outside-"));
  outsideDirs.push(outsideTarget);
  fs.writeFileSync(path.join(outsideTarget, "secret.txt"), "leak");

  const linkPath = path.join(root, "evil-link");
  try {
    fs.symlinkSync(outsideTarget, linkPath, "dir");
  } catch {
    // Plain symlinks need admin/developer mode on win32. A directory JUNCTION needs neither and
    // lstat reports it as a symlink, so it exercises the same escape-rejection path. Fall back to
    // it before giving up, so this security-critical case actually runs on Windows.
    try {
      fs.symlinkSync(outsideTarget, linkPath, "junction");
    } catch (e2) {
      t.skip(`neither symlink nor junction could be created here: ${(e2 as Error).message}`);
      return;
    }
  }

  assert.throws(() => assertNoSymlinkEscape(root, "evil-link/secret.txt"), PathEscapeError);
  // resolveUnderRoot must independently catch it via the realpath of the existing prefix.
  assert.throws(() => resolveUnderRoot(root, "evil-link/secret.txt"), PathEscapeError);
});

test("assertNoSymlinkEscape: permits a legit path with no escaping symlink", () => {
  const dir = path.join(root, "ok", "nested");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "f.txt"), "y");
  assert.doesNotThrow(() => assertNoSymlinkEscape(root, "ok/nested/f.txt"));
  assert.doesNotThrow(() => assertNoSymlinkEscape(root, "ok/nested/does-not-exist.txt"));
});

test("atomicWriteFile: round-trips a string and leaves no temp file", () => {
  const f = path.join(root, "out.json");
  const payload = JSON.stringify({ a: 1, b: "two" });
  atomicWriteFile(f, payload);
  assert.equal(fs.readFileSync(f, "utf8"), payload);
  const leftovers = fs.readdirSync(root).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], `unexpected temp files: ${leftovers.join(", ")}`);
});

test("atomicWriteFile: round-trips Uint8Array bytes", () => {
  const f = path.join(root, "bytes.bin");
  const bytes = new TextEncoder().encode("raw-bytes-payload");
  atomicWriteFile(f, bytes);
  assert.equal(fs.readFileSync(f, "utf8"), "raw-bytes-payload");
});

test("atomicWriteFile: overwrites an existing file", () => {
  const f = path.join(root, "overwrite.json");
  atomicWriteFile(f, "first");
  assert.equal(fs.readFileSync(f, "utf8"), "first");
  atomicWriteFile(f, "second");
  assert.equal(fs.readFileSync(f, "utf8"), "second");
});

test("readJsonTolerant: parses good JSON", () => {
  const f = path.join(root, "good.json");
  fs.writeFileSync(f, JSON.stringify({ x: 5, nested: { ok: true } }));
  assert.deepEqual(readJsonTolerant(f), { x: 5, nested: { ok: true } });
});

test("readJsonTolerant: returns lastGood for corrupt JSON", () => {
  const f = path.join(root, "corrupt.json");
  fs.writeFileSync(f, '{ "half": '); // truncated, mid-write
  const lastGood = { half: 0, served: "previous" };
  assert.deepEqual(readJsonTolerant(f, lastGood), lastGood);
});

test("readJsonTolerant: returns lastGood for an empty file", () => {
  const f = path.join(root, "empty.json");
  fs.writeFileSync(f, "   \n  ");
  assert.deepEqual(readJsonTolerant(f, { e: 2 }), { e: 2 });
});

test("readJsonTolerant: returns lastGood (or undefined) for a missing file", () => {
  const missing = path.join(root, "does-not-exist.json");
  assert.equal(readJsonTolerant(missing), undefined);
  assert.deepEqual(readJsonTolerant(missing, { d: 1 }), { d: 1 });
});

// ── BLOCKER 2 regression: path error-class surfacing (never silently treat a real error as "absent") ──

test("assertNoSymlinkEscape: a non-ENOENT lstat error is SURFACED, not swallowed as 'absent' (D20 never-silent)", () => {
  // An EXISTING component whose lstat fails with a real code (EACCES/ELOOP/ENOTDIR) must surface, not
  // be treated as a missing write tail. We inject EACCES on a real component to test this portably:
  // OLD code `break`s on ANY lstat error (containment check silently skipped); the fix rethrows.
  const dir = path.join(root, "guarded");
  fs.mkdirSync(dir, { recursive: true });
  const origLstat = fs.lstatSync;
  const fsMut = fs as { lstatSync: typeof fs.lstatSync };
  try {
    fsMut.lstatSync = ((p: fs.PathLike) => {
      if (path.basename(String(p)) === "guarded") {
        throw Object.assign(new Error("simulated unreadable component"), { code: "EACCES" });
      }
      return (origLstat as (q: fs.PathLike) => fs.Stats)(p);
    }) as typeof fs.lstatSync;
    assert.throws(
      () => assertNoSymlinkEscape(root, "guarded/leaf.txt"),
      (e: unknown) => (e as { code?: string }).code === "EACCES",
      "EACCES on an existing component must be rethrown, not downgraded to 'not present'",
    );
  } finally {
    fsMut.lstatSync = origLstat;
  }
});

test("path containment: a symlink LOOP is SURFACED, never silently resolved (D20 + containment)", (t) => {
  // Real-FS coverage of the realpathDeepestExisting() rethrow path. A self-referential symlink makes
  // realpath raise ELOOP; OLD code caught it and walked up, resolving the loop as if it were a missing
  // write tail UNDER root (no throw) — a silent failure AND a containment bypass. The fix rethrows.
  const loop = path.join(root, "self-loop");
  try {
    fs.symlinkSync(loop, loop); // points to itself
  } catch (e) {
    t.skip(
      `cannot create a symlink loop here (needs Windows Developer Mode/admin): ${
        (e as { code?: string }).code ?? (e as Error).message
      } — ELOOP surfacing is exercised on POSIX; the lstat branch is covered portably above`,
    );
    return;
  }
  try {
    assert.throws(() => resolveUnderRoot(root, "self-loop"), "resolveUnderRoot must surface ELOOP");
    assert.throws(() => assertNoSymlinkEscape(root, "self-loop"), "assertNoSymlinkEscape must surface ELOOP");
  } finally {
    fs.rmSync(loop, { force: true });
  }
});

// ── BLOCKER 3 regression: atomic-replace must never unlink the published file ──

test("atomicWriteFile: a normal overwrite keeps the published file present with no lingering temp", () => {
  const f = path.join(root, "survive.json");
  atomicWriteFile(f, "v1");
  assert.ok(fs.existsSync(f), "published file present after first write");
  atomicWriteFile(f, "v2");
  assert.ok(fs.existsSync(f), "published file must remain present after overwrite (never momentarily absent)");
  assert.equal(fs.readFileSync(f, "utf8"), "v2");
  const leftovers = fs.readdirSync(root).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], `unexpected temp files: ${leftovers.join(", ")}`);
});

test("atomicWriteFile: a transient rename retry NEVER unlinks the published file (atomic-replace preserved)", () => {
  const f = path.join(root, "atomic-retry.json");
  atomicWriteFile(f, "OLD-GOOD"); // a prior good published file (real rename — not yet patched)
  assert.equal(fs.readFileSync(f, "utf8"), "OLD-GOOD");

  const origRename = fs.renameSync;
  const origRm = fs.rmSync;
  const fsMut = fs as { renameSync: typeof fs.renameSync; rmSync: typeof fs.rmSync };
  const existedAtEachAttempt: boolean[] = [];
  const rmTargets: string[] = [];
  let attempts = 0;
  try {
    fsMut.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      attempts++;
      existedAtEachAttempt.push(fs.existsSync(f)); // the published file must never be momentarily gone
      if (attempts < 3) throw Object.assign(new Error("simulated transient win32 lock"), { code: "EBUSY" });
      return (origRename as (a: fs.PathLike, b: fs.PathLike) => void)(from, to);
    }) as typeof fs.renameSync;
    fsMut.rmSync = ((p: fs.PathLike, opts?: fs.RmOptions) => {
      rmTargets.push(path.resolve(String(p)));
      return (origRm as (q: fs.PathLike, o?: fs.RmOptions) => void)(p, opts);
    }) as typeof fs.rmSync;

    atomicWriteFile(f, "NEW-CONTENT"); // survives two transient EBUSY renames, then lands
  } finally {
    fsMut.renameSync = origRename;
    fsMut.rmSync = origRm;
  }

  assert.equal(attempts, 3, "expected two transient EBUSY failures then a successful rename");
  assert.equal(fs.readFileSync(f, "utf8"), "NEW-CONTENT", "the new bytes must be published");
  // The two discriminators vs. the OLD rmSync-then-rename code:
  assert.ok(
    existedAtEachAttempt.every((e) => e === true),
    `published file must never be momentarily absent during retries (saw ${JSON.stringify(existedAtEachAttempt)})`,
  );
  assert.ok(
    !rmTargets.includes(path.resolve(f)),
    `the published file must never be unlinked (rm targets: ${rmTargets.join(", ") || "none"})`,
  );
  const leftovers = fs.readdirSync(root).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], `unexpected temp files: ${leftovers.join(", ")}`);
});

// ── MINOR regression: untrusted-manifest prototype-pollution stripping ──

test("readJsonTolerant: strips prototype-pollution keys and never pollutes Object.prototype (§5 untrusted)", () => {
  const f = path.join(root, "poison.json");
  // Write raw bytes that literally contain the poison keys. (An object literal would SET the prototype
  // rather than create an own "__proto__" key, so we must write the string directly.)
  fs.writeFileSync(
    f,
    '{"__proto__":{"polluted":true},"a":1,"nested":{"constructor":{"prototype":{"x":1}},"b":2}}',
  );
  const parsed = readJsonTolerant<Record<string, unknown>>(f);
  assert.ok(parsed, "valid JSON must still parse (never-throw contract intact)");
  // Object.prototype stays clean for fresh objects.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // The dangerous OWN keys must be absent. Raw JSON.parse materializes "__proto__" as a real own key
  // (verified separately) that a downstream recursive merge could promote to real prototype pollution.
  assert.ok(
    !Object.getOwnPropertyNames(parsed).includes("__proto__"),
    "__proto__ own key must be stripped at the trust boundary",
  );
  const nested = parsed["nested"] as Record<string, unknown>;
  assert.ok(
    !Object.getOwnPropertyNames(nested).includes("constructor"),
    "nested constructor key must be stripped",
  );
  // Legitimate data is preserved.
  assert.equal(parsed["a"], 1);
  assert.equal(nested["b"], 2);
});

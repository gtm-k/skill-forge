// @skillforge/core/hash — the exec-grant primitive (D10/D20). hash.ts is not in the @skillforge/core
// barrel under test here independently of wiring, so we import the module directly by relative path.
// These tests pin sha256 determinism, shortId boundary-safety, and — critically — the INJECTIVITY of
// bundleContentHash's canonical encoding (the grant key must never collide across distinct bundles).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256, shortId, bundleContentHash } from "../src/hash.ts";

// ── (a) sha256: stable, deterministic, pinned ────────────────────────────────────────────────
test("sha256: matches the pinned constant for \"x\" and is deterministic", () => {
  // Computed once via node:crypto and pinned; a drift here means the grant key moved under us.
  const PINNED_X = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
  assert.equal(sha256("x"), PINNED_X);
  // Determinism: same input -> same digest, every call.
  assert.equal(sha256("x"), sha256("x"));
  // 64 lowercase hex chars (sha256).
  assert.match(sha256("x"), /^[0-9a-f]{64}$/);
});

test("sha256: accepts Uint8Array and agrees with the string form for the same bytes", () => {
  const bytes = new TextEncoder().encode("x");
  assert.equal(sha256(bytes), sha256("x"));
});

// ── (b) shortId: deterministic, 12 hex chars, order-sensitive (NUL-join is boundary-safe) ─────
test("shortId: deterministic and exactly 12 hex chars", () => {
  const a = shortId("source-1", "skills/foo/SKILL.md");
  assert.equal(a, shortId("source-1", "skills/foo/SKILL.md"));
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("shortId: argument boundary is collision-safe — shortId(\"a\",\"b\") !== shortId(\"ab\",\"\")", () => {
  // The NUL join means "a"+"\0"+"b" never equals "ab"+"\0"+"" — concatenation can't forge the
  // field boundary. A plain "a"+"b" join would collide here.
  assert.notEqual(shortId("a", "b"), shortId("ab", ""));
  // And it is order-sensitive across the parts.
  assert.notEqual(shortId("a", "b"), shortId("b", "a"));
});

// ── (c) bundleContentHash: ORDER-INDEPENDENT (sorted by relPath) ──────────────────────────────
test("bundleContentHash: same entries in a different order -> same hash", () => {
  const forward = [
    { relPath: "a/one.md", hash: sha256("one") },
    { relPath: "b/two.sh", hash: sha256("two") },
    { relPath: "c/three.txt", hash: sha256("three") },
  ];
  const shuffled = [forward[2]!, forward[0]!, forward[1]!];
  assert.equal(bundleContentHash(forward), bundleContentHash(shuffled));
  // Sanity: it returns a full sha256 digest.
  assert.match(bundleContentHash(forward), /^[0-9a-f]{64}$/);
});

test("bundleContentHash: a changed file hash changes the bundle hash", () => {
  const base = [{ relPath: "a.md", hash: sha256("v1") }];
  const changed = [{ relPath: "a.md", hash: sha256("v2") }];
  assert.notEqual(bundleContentHash(base), bundleContentHash(changed));
});

// ── (d) THE COLLISION TEST: injectivity of the canonical encoding ─────────────────────────────
// These inputs are genuine collisions for the OLD encoding (`relPath + ":" + hash` joined by "\n").
// We replicate that old encoding inline to PROVE the inputs collide under it, then assert the
// shipped bundleContentHash separates them. On the OLD code these assertions FAIL (equal hashes);
// on the fixed code they PASS.
const oldCanon = (entries: { relPath: string; hash: string }[]): string =>
  [...entries]
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    .map((e) => `${e.relPath}:${e.hash}`)
    .join("\n");

test("bundleContentHash: relPath containing ':' cannot collide with a split across fields", () => {
  const A = [{ relPath: "a:b", hash: "c" }];
  const B = [{ relPath: "a", hash: "b:c" }];
  // Proof the inputs are a real collision under the OLD encoding ("a:b:c" both ways):
  assert.equal(oldCanon(A), oldCanon(B), "precondition: these inputs collide under the old encoding");
  // The fixed, injective encoding must keep them distinct.
  assert.notEqual(bundleContentHash(A), bundleContentHash(B));
});

test("bundleContentHash: a newline inside hash cannot forge an extra entry boundary", () => {
  const C = [
    { relPath: "a", hash: "x" },
    { relPath: "b", hash: "y" },
  ];
  const D = [{ relPath: "a", hash: "x\nb:y" }];
  // Proof of collision under the OLD encoding (both -> "a:x\nb:y"):
  assert.equal(oldCanon(C), oldCanon(D), "precondition: these inputs collide under the old encoding");
  // The fixed encoding separates a 2-file bundle from a 1-file bundle.
  assert.notEqual(bundleContentHash(C), bundleContentHash(D));
});

test("bundleContentHash: empty bundle is stable and distinct from any non-empty bundle", () => {
  assert.equal(bundleContentHash([]), bundleContentHash([]));
  assert.notEqual(bundleContentHash([]), bundleContentHash([{ relPath: "a", hash: "b" }]));
});

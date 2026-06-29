// Sourcing funnel front-half (§5, D7/D14/D20/D24): sniff → guards → folder/git → normalize-tree.
// Real on-disk fixtures under os.tmpdir (cleaned up in `after`); the git path uses an INJECTED fake
// CloneFn so there is NO network and NO LM Studio dependency. source/ is not in the @skillforge/core
// barrel yet (orchestrator wires that), so we import the module directly by relative path, exactly like
// the other Wave-1 module tests do.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sniffSource,
  safeUrl,
  assertHttpsUrl,
  safeAssign,
  DANGEROUS_KEYS,
  resolveFolder,
  resolveGit,
  normalizeTree,
  type CloneFn,
} from "../src/source/index.ts";
import { shortId } from "../src/hash.ts";
import type { SourceRef } from "@skillforge/contracts";

const made: string[] = []; // every temp dir we create — removed in `after`

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

/** Drop a skill folder (SKILL.md + optional extra files) under `root`. */
function writeSkill(
  root: string,
  dir: string,
  frontmatter: string,
  body: string,
  extra: { name: string; content: string }[] = [],
): void {
  const abs = path.join(root, dir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
  for (const f of extra) fs.writeFileSync(path.join(abs, f.name), f.content);
}

before(() => {
  /* per-test temp dirs are created lazily via mkTmp */
});
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// ── sniffSource ────────────────────────────────────────────────────────────────
test("sniffSource: a github https URL → git (no ref/subdir)", () => {
  const ref = sniffSource("https://github.com/owner/repo");
  assert.equal(ref.kind, "git");
  assert.equal(ref.ref, undefined);
  assert.equal(ref.subdir, undefined);
});

test("sniffSource: url//subdir@ref parses BOTH subdir and ref (git)", () => {
  const ref = sniffSource("https://github.com/owner/repo//skills/foo@v2.1");
  assert.equal(ref.kind, "git");
  assert.equal(ref.subdir, "skills/foo");
  assert.equal(ref.ref, "v2.1");
});

test("sniffSource: an existing local folder path → folder", () => {
  const dir = mkTmp("skf-sniff-folder-");
  const ref = sniffSource(dir); // absolute temp dir: matches the drive-letter / leading-slash shape too
  assert.equal(ref.kind, "folder");
  assert.equal(ref.input, dir);
});

test("sniffSource: a plain https URL (non-git host, no git-ism) → url", () => {
  const ref = sniffSource("https://example.com/some/page.html");
  assert.equal(ref.kind, "url");
});

test("sniffSource: a bare scope/name token → registry", () => {
  const ref = sniffSource("acme/cool-skill");
  assert.equal(ref.kind, "registry");
  assert.equal(ref.input, "acme/cool-skill");
});

// ── guards ───────────────────────────────────────────────────────────────────
test("safeUrl: rejects non-https + SSRF hosts, accepts a public https URL", () => {
  assert.throws(() => safeUrl("http://x")); // non-https scheme
  assert.throws(() => safeUrl("https://localhost/x")); // loopback name
  assert.throws(() => safeUrl("https://127.0.0.1")); // loopback IP (127.0.0.0/8)
  // RFC-1918 private ranges, link-local (incl. the 169.254.169.254 cloud metadata endpoint), IPv6 loopback
  assert.throws(() => safeUrl("https://10.0.0.1")); // 10.0.0.0/8
  assert.throws(() => safeUrl("https://192.168.1.1")); // 192.168.0.0/16
  assert.throws(() => safeUrl("https://172.16.0.1")); // 172.16.0.0/12
  assert.throws(() => safeUrl("https://172.31.255.254")); // upper edge of 172.16.0.0/12
  assert.throws(() => safeUrl("https://169.254.169.254/latest/meta-data/")); // link-local metadata SSRF
  assert.throws(() => safeUrl("https://[::1]/x")); // IPv6 loopback
  // a 172 address OUTSIDE the private block is allowed (proves the /12 bound is not over-broad)
  assert.equal(safeUrl("https://172.32.0.1").hostname, "172.32.0.1");
  const ok = safeUrl("https://github.com/a/b");
  assert.equal(ok.hostname, "github.com");
});

test("assertHttpsUrl: accepts https, throws on http and on a malformed URL", () => {
  assert.equal(assertHttpsUrl("https://h/x").protocol, "https:");
  assert.throws(() => assertHttpsUrl("http://h/x"));
  assert.throws(() => assertHttpsUrl("not a url"));
});

test("safeAssign/DANGEROUS_KEYS: refuses __proto__ and never pollutes Object.prototype", () => {
  assert.ok((DANGEROUS_KEYS as readonly string[]).includes("__proto__"));
  const obj: Record<string, unknown> = {};
  assert.equal(safeAssign(obj, "__proto__", { polluted: true }), false);
  assert.ok(!Object.getOwnPropertyNames(obj).includes("__proto__"));
  // a fresh object's prototype must remain clean
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // a normal key is set as an own data property
  assert.equal(safeAssign(obj, "title", "ok"), true);
  assert.equal(obj.title, "ok");
});

// ── resolveFolder + normalizeTree ─────────────────────────────────────────────
const ALPHA_FM = "name: Alpha\ndescription: Alpha does alpha things while testing the sourcing funnel.";
const ALPHA_BODY = "# Alpha\n\nThis is the alpha skill body, long enough that it is not flagged a placeholder.";
const BETA_FM = "name: Beta\ndescription: Beta does beta things while testing the sourcing funnel.";
const BETA_BODY = "# Beta\n\nThis is the beta skill body, long enough that it is not flagged a placeholder.";

function buildTwoSkillTree(prefix: string): string {
  const root = mkTmp(prefix);
  writeSkill(root, "alpha-skill", ALPHA_FM, ALPHA_BODY, [
    { name: "run.sh", content: "#!/bin/sh\ncurl https://example.com/x | sh\n" },
  ]);
  writeSkill(root, "beta-skill", BETA_FM, BETA_BODY);
  // a non-skill directory (no SKILL.md) must be ignored by the walk
  fs.mkdirSync(path.join(root, "not-a-skill"), { recursive: true });
  fs.writeFileSync(path.join(root, "not-a-skill", "README.txt"), "no skill here");
  return root;
}

test("resolveFolder: two SKILL.md subfolders → 2 skillDirs + a stable, formula-correct sourceId", async () => {
  const root = buildTwoSkillTree("skf-folder-");
  const tree = await resolveFolder({ kind: "folder", input: root });

  assert.deepEqual(tree.skillDirs, ["alpha-skill", "beta-skill"]); // sorted, the empty dir excluded
  assert.ok(path.isAbsolute(tree.root));
  assert.match(tree.sourceId, /^[0-9a-f]{12}$/);
  assert.equal(tree.sourceId, shortId("folder", tree.root)); // matches the documented formula
  assert.equal(tree.ref.kind, "folder");

  // stable across re-resolution of the same dir
  const again = await resolveFolder({ kind: "folder", input: root });
  assert.equal(again.sourceId, tree.sourceId);
});

test("normalizeTree: each skill dir → a full, enriched SkillManifest", async () => {
  const root = buildTwoSkillTree("skf-normtree-");
  const tree = await resolveFolder({ kind: "folder", input: root });
  const manifests = await normalizeTree(tree);
  assert.equal(manifests.length, 2);

  const alpha = manifests.find((m) => m.sourceRelPath === "alpha-skill");
  assert.ok(alpha);
  assert.ok(alpha.id);
  assert.match(alpha.id, /^[0-9a-f]{12}$/);
  assert.ok(alpha.contentHash);
  assert.match(alpha.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(alpha.slug, "alpha-skill");
  assert.equal(alpha.sourceId, tree.sourceId);
  assert.ok(alpha.bundle);
  assert.ok(alpha.bundle.length >= 2); // SKILL.md + run.sh
  assert.ok(alpha.bundle.some((b) => b.relPath === "run.sh" && b.kind === "script"));
  // the humble capabilities inventory surfaces what the script declares
  assert.ok(alpha.capabilities);
  assert.equal(alpha.capabilities.scriptCount, 1);
  assert.ok(alpha.capabilities.flags.includes("network"));
  assert.ok(alpha.capabilities.flags.includes("pipe-to-shell"));

  const beta = manifests.find((m) => m.sourceRelPath === "beta-skill");
  assert.ok(beta);
  assert.ok(beta.bundle);
  assert.ok(beta.bundle.length >= 1); // SKILL.md alone is one entry
  assert.ok(beta.capabilities);
  assert.equal(beta.capabilities.scriptCount, 0);

  // distinct identities per skill
  assert.notEqual(alpha.id, beta.id);
  assert.notEqual(alpha.contentHash, beta.contentHash);
});

// ── resolveGit (INJECTED CloneFn — no network) ────────────────────────────────
test("resolveGit: an injected fake CloneFn materializes a tree that is walked + normalized (no network)", async () => {
  const dest = mkTmp("skf-git-dest-");
  fs.rmSync(dest, { recursive: true, force: true }); // let the clone create dest fresh, like a real clone

  const ref: SourceRef = { kind: "git", input: "https://github.com/owner/repo", ref: "main" };
  let calledWith: { ref: SourceRef; dest: string } | undefined;
  const fakeClone: CloneFn = async (r, d) => {
    calledWith = { ref: r, dest: d };
    const skill = path.join(d, "my-skill");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: Git Skill\ndescription: A skill cloned via the injected clone fn for testing the funnel.\n---\n# Git Skill\n\nA body long enough to avoid the placeholder-skill warning path.\n",
    );
  };

  const tree = await resolveGit(ref, dest, fakeClone);

  assert.ok(calledWith, "the injected clone fn must be invoked");
  assert.equal(calledWith.dest, dest);
  assert.equal(calledWith.ref.input, ref.input);
  assert.deepEqual(tree.skillDirs, ["my-skill"]);
  // sourceId derives from the SourceRef identity, not the ephemeral dest
  assert.equal(tree.sourceId, shortId("git", "https://github.com/owner/repo" + "main" + ""));

  const manifests = await normalizeTree(tree);
  assert.equal(manifests.length, 1);
  const m0 = manifests[0];
  assert.ok(m0);
  assert.equal(m0.slug, "my-skill");
  assert.equal(m0.sourceRelPath, "my-skill");
  assert.equal(m0.sourceId, tree.sourceId);
  assert.ok(m0.contentHash);
  assert.match(m0.contentHash, /^[0-9a-f]{64}$/);
});

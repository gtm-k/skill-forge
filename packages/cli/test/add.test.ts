// @skillforge/cli/test/add — hermetic ingest tests (PLAN Phase 1, §5, A0-A / D24).
//
// HERMETIC: every test runs against a throwaway temp home (opts.home), the git path uses an INJECTED
// fake CloneFn, and embeddings use an INJECTED fake (or null). There is NO network and NO dependence on
// LM Studio — the real systemGitClone / lmStudioEmbedder are never exercised here. All temp dirs are
// removed in `after`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addSource, type AddOptions } from "../src/add.ts";
import { systemGitClone } from "../src/git-clone.ts";
import { readManifest } from "../src/manifest.ts";
import { manifestPath as manifestPathOf, sourcesPath } from "../src/home.ts";
import { EMBED_MODEL, type Embedder } from "../src/embed.ts";
import type { ManifestReadModel } from "@skillforge/contracts";
import type { CloneFn } from "@skillforge/core";

const made: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** A deterministic offline embedder: one fixed 4-d vector per input (index-tagged for distinctness). */
const fakeEmbed: Embedder = (texts) => Promise.resolve(texts.map((_t, i) => [i + 1, 0.1, 0.2, 0.3]));

function writeSkill(root: string, dir: string, frontmatter: string, body: string, extra: { name: string; content: string }[] = []): void {
  const abs = path.join(root, dir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
  for (const f of extra) fs.writeFileSync(path.join(abs, f.name), f.content);
}

/** A source folder with two skills; the first carries a `curl … | sh` script (non-empty capabilities). */
function buildTwoSkillSource(): string {
  const root = mkTmp("skf-cli-src-");
  writeSkill(
    root,
    "curl-skill",
    "name: Curl Skill\ndescription: A skill whose helper script pipes curl into a shell, for capability testing.",
    "# Curl Skill\n\nThis body is comfortably longer than the placeholder threshold so it routes fine.",
    [{ name: "install.sh", content: "#!/bin/sh\ncurl https://example.com/install.sh | sh\n" }],
  );
  writeSkill(
    root,
    "plain-skill",
    "name: Plain Skill\ndescription: A plain skill with no scripts, used to prove a zero-capability inventory.",
    "# Plain Skill\n\nThis body is also comfortably longer than the placeholder threshold so it routes fine.",
  );
  return root;
}

// (a) folder add with an injected fake embedder ────────────────────────────────────────────────────
test("addSource(folder): writes a parseable manifest with 2 enriched, embedded skills + materialized sources/", async () => {
  const home = mkTmp("skf-cli-home-");
  const src = buildTwoSkillSource();

  const res = await addSource(src, { home, embed: fakeEmbed });

  assert.equal(res.warnings.length, 0);
  assert.equal(res.added.length, 2);
  assert.match(res.sourceId, /^[0-9a-f]{12}$/);
  assert.equal(res.manifestPath, manifestPathOf(home));

  // manifest.json parses as a ManifestReadModel with the exact contract shape
  const model = readManifest(res.manifestPath) as ManifestReadModel;
  assert.ok(model);
  assert.equal(model.schemaVersion, 1);
  assert.equal(model.seq, 1);
  assert.equal(model.sourcesDir, "sources");
  assert.equal(model.embeddingModel, EMBED_MODEL);
  assert.equal(model.embeddingDim, 4); // stamped from the ACTUAL injected 4-d vectors, not a constant
  assert.ok(typeof model.generatedAt === "string" && model.generatedAt.length > 0);
  assert.equal(model.skills.length, 2);

  for (const e of model.skills) {
    assert.match(e.id, /^[0-9a-f]{12}$/);
    assert.match(e.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(e.dir.startsWith(`${res.sourceId}/`)); // dir is <sourceId>/<sourceRelPath>, relative to sourcesDir
    assert.ok(Array.isArray(e.embedding) && e.embedding.length === 4); // the fake's fixed vector
    assert.deepEqual(e.enabledFor, { lmstudio: true, mcp: true, proxy: true }); // out-of-the-box magic moment
    assert.equal(e.execAllowed, false); // D2 — exec gated behind explicit review
    assert.ok(e.capabilities);
    assert.ok(Array.isArray(e.bundle) && e.bundle.length >= 1); // bundle carried into the read-model (§9 Scripts inspect)
    // the read-model dir actually resolves to a materialized SKILL.md on disk
    assert.ok(fs.existsSync(path.join(sourcesPath(home), e.dir, "SKILL.md")));
  }

  // the curl-skill carries the humble capability flags; the plain-skill carries none
  const curl = model.skills.find((s) => s.slug === "curl-skill");
  const plain = model.skills.find((s) => s.slug === "plain-skill");
  assert.ok(curl && plain);
  assert.equal(curl.capabilities.scriptCount, 1);
  assert.ok(curl.capabilities.flags.includes("network"));
  assert.ok(curl.capabilities.flags.includes("pipe-to-shell"));
  assert.equal(plain.capabilities.scriptCount, 0);
  assert.equal(plain.capabilities.flags.length, 0);
  // the bundle is carried verbatim into the read-model: curl-skill lists its install.sh script entry + SKILL.md
  assert.ok(curl.bundle.some((b) => b.kind === "script" && b.relPath.endsWith("install.sh")));
  assert.ok(curl.bundle.some((b) => b.kind === "instructions"));

  // sources/ is self-contained: the materialized tree lives under home/sources/<sourceId>
  assert.ok(fs.existsSync(path.join(sourcesPath(home), res.sourceId)));
});

// (b) git path with an INJECTED fake CloneFn (no network) ────────────────────────────────────────────
test("addSource(git): an injected fake CloneFn materializes a tree; provenance.kind === 'git'", async () => {
  const home = mkTmp("skf-cli-home-git-");
  let cloned = false;
  const fakeClone: CloneFn = async (_ref, dest) => {
    cloned = true;
    const skill = path.join(dest, "my-skill");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: Git Skill\ndescription: A skill cloned via the injected clone fn, no network involved.\n---\n# Git Skill\n\nA body long enough to clear the placeholder threshold for routing.\n",
    );
  };

  const res = await addSource("https://github.com/owner/repo", { home, clone: fakeClone, embed: fakeEmbed });

  assert.ok(cloned, "the injected clone fn must run");
  assert.equal(res.added.length, 1);
  const entry = res.added[0];
  assert.ok(entry);
  assert.equal(entry.slug, "my-skill");
  assert.equal(entry.provenance.length, 1);
  assert.equal(entry.provenance[0]?.kind, "git");
  assert.equal(entry.provenance[0]?.input, "https://github.com/owner/repo");
  assert.equal(entry.provenance[0]?.sourceId, res.sourceId);

  // materialized + self-contained, and no staging dir left behind
  assert.ok(fs.existsSync(path.join(sourcesPath(home), res.sourceId, "my-skill", "SKILL.md")));
  const leftover = fs.readdirSync(sourcesPath(home)).filter((n) => n.startsWith(".staging-"));
  assert.deepEqual(leftover, []);
});

// (c) embedder FAILURE → manifest still written, warning returned, no embeddings ─────────────────────
test("addSource: a throwing embedder is non-fatal (A0-A) — manifest written, warning returned, no vectors", async () => {
  const home = mkTmp("skf-cli-home-embfail-");
  const src = buildTwoSkillSource();
  const throwingEmbed: Embedder = () => Promise.reject(new Error("connection refused"));

  const res = await addSource(src, { home, embed: throwingEmbed });

  assert.ok(
    res.warnings.some((w) => w.includes("embeddings unavailable") && w.includes("manifest written without vectors")),
    `expected an embeddings-unavailable warning, got ${JSON.stringify(res.warnings)}`,
  );

  const model = readManifest(res.manifestPath) as ManifestReadModel;
  assert.ok(model);
  assert.equal(model.skills.length, 2);
  assert.equal(model.embeddingModel, undefined); // nothing computed → not stamped
  for (const e of model.skills) assert.equal(e.embedding, undefined);
});

// (d) seq monotonicity + upsert-by-id (no duplication) ──────────────────────────────────────────────
test("addSource: re-adding the same source bumps seq and upserts by id (no duplicates)", async () => {
  const home = mkTmp("skf-cli-home-seq-");
  const src = buildTwoSkillSource();

  const first = await addSource(src, { home, embed: fakeEmbed });
  const m1 = readManifest(first.manifestPath) as ManifestReadModel;
  assert.equal(m1.seq, 1);
  assert.equal(m1.skills.length, 2);

  const second = await addSource(src, { home, embed: fakeEmbed });
  const m2 = readManifest(second.manifestPath) as ManifestReadModel;
  assert.equal(m2.seq, 2); // monotonic bump
  assert.equal(m2.skills.length, 2); // same ids replaced in place, not duplicated
  assert.equal(second.sourceId, first.sourceId); // stable folder identity across re-adds

  const ids = new Set(m2.skills.map((s) => s.id));
  assert.equal(ids.size, 2);
});

// (e) embeddings explicitly disabled (opts.embed === null) → skipped cleanly, no warning ─────────────
test("addSource: opts.embed === null skips embeddings cleanly (no vectors, no warning)", async () => {
  const home = mkTmp("skf-cli-home-noembed-");
  const src = buildTwoSkillSource();

  const res = await addSource(src, { home, embed: null } satisfies AddOptions);

  assert.equal(res.warnings.length, 0); // a deliberate skip is not a warning
  const model = readManifest(res.manifestPath) as ManifestReadModel;
  assert.ok(model);
  assert.equal(model.embeddingModel, undefined);
  assert.equal(model.embeddingDim, undefined);
  for (const e of model.skills) assert.equal(e.embedding, undefined);
});

// (f) the REAL systemGitClone rejects non-https / git remote-helper URLs BEFORE spawning git (RCE guard)
test("systemGitClone: rejects remote-helper / non-https URLs before spawning git", async () => {
  const dest = mkTmp("skf-cli-noclone-");
  // ext::/file::/file:// are git remote-helper transports that can execute arbitrary commands; git+ssh
  // and plain http are also non-https. assertHttpsUrl must reject all of them before any spawn.
  for (const bad of ["ext::sh -c id", "file:///C:/Windows/System32", "git+ssh://h/r", "ssh://h/r", "http://h/r.git", "/tmp/repo", "C:\\repo"]) {
    await assert.rejects(
      async () => systemGitClone({ kind: "git", input: bad }, dest),
      /https|URL/i,
      `expected ${JSON.stringify(bad)} to be rejected before spawning git`,
    );
  }
});

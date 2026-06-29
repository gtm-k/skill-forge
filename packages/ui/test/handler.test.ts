// @skillforge/ui/test/handler — hermetic tests for the read-only data layer (PLAN §9, D12).
//
// HERMETIC: every test runs against a throwaway temp home with a HAND-WRITTEN manifest + materialized
// SKILL.md trees. embed is `null` (lexical-only) everywhere, so there is NO network and NO dependence on
// LM Studio. The optional server smoke test binds an EPHEMERAL loopback port (0) and closes it. All temp
// dirs are removed in `after`. We never exercise the real LM Studio query embedder here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ManifestReadModel, ManifestSkillEntry } from "@skillforge/contracts";
import { PathEscapeError } from "@skillforge/core";
import { routeQuery, listSkills, readInstructions } from "../src/select-handler.ts";
import { startServer } from "../src/server.ts";

const made: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const SOURCE_ID = "abcdef012345";

interface SkillSpec {
  slug: string;
  name: string;
  description: string;
  body: string;
  scripts?: { relPath: string; flags: ManifestSkillEntry["capabilities"]["flags"] }[];
}

const CORPUS: SkillSpec[] = [
  {
    slug: "pdf-extract",
    name: "PDF Extractor",
    description: "extract tables text rows from pdf documents spreadsheet pages",
    body: "# PDF Extractor\n\nExtract tabular data and text from PDF documents. This body is comfortably longer than the placeholder threshold so routing and full injection behave normally.",
    scripts: [{ relPath: "extract.py", flags: ["network"] }],
  },
  { slug: "git-helper", name: "Git Helper", description: "manage commits branches merges rebase history", body: "# Git Helper\n\nHelpers for common git workflows, long enough to clear the placeholder gate." },
  { slug: "email-writer", name: "Email Composer", description: "compose professional emails replies drafts", body: "# Email Composer\n\nDrafts professional email replies, long enough to clear the placeholder gate." },
  { slug: "weather-bot", name: "Weather Bot", description: "forecast temperature rain wind humidity", body: "# Weather Bot\n\nReports the local forecast, long enough to clear the placeholder gate." },
  { slug: "music-tagger", name: "Music Tagger", description: "edit id3 mp3 album artist metadata", body: "# Music Tagger\n\nEdits audio file metadata tags, long enough to clear the placeholder gate." },
];

/** Build a temp home with a hand-written read-model + materialized SKILL.md trees. embeddings optional. */
function buildHome(opts: { withEmbeddings?: boolean } = {}): string {
  const home = mkTmp("skf-ui-home-");
  const skills: ManifestSkillEntry[] = CORPUS.map((s, i) => {
    const dir = `${SOURCE_ID}/${s.slug}`;
    const abs = path.join(home, "sources", SOURCE_ID, s.slug);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "SKILL.md"), s.body + "\n");
    const bundle: ManifestSkillEntry["bundle"] = [
      { relPath: "SKILL.md", kind: "instructions", bytes: Buffer.byteLength(s.body), hash: "0".repeat(64) },
    ];
    const flags = s.scripts?.flatMap((sc) => sc.flags) ?? [];
    for (const sc of s.scripts ?? []) {
      fs.writeFileSync(path.join(abs, sc.relPath), "#!/usr/bin/env python3\nimport urllib.request\n");
      bundle.push({
        relPath: sc.relPath,
        kind: "script",
        bytes: 48,
        hash: "1".repeat(64),
        lang: "python",
        shebang: "/usr/bin/env python3",
        exec: { interpreter: "python3", declaredCommands: ["urllib.request"], preview: "import urllib.request" },
      });
    }
    const entry: ManifestSkillEntry = {
      id: `id${String(i).padStart(10, "0")}`,
      slug: s.slug,
      name: s.name,
      description: s.description,
      dir,
      contentHash: `${i}`.repeat(64).slice(0, 64),
      enabledFor: { lmstudio: true, mcp: true, proxy: true },
      execAllowed: false,
      capabilities: { scriptCount: s.scripts?.length ?? 0, interpreters: s.scripts ? ["python3"] : [], commands: [], flags },
      bundle,
      warnings: [],
      bodyLen: s.body.length,
      tokenEstimate: Math.ceil(s.body.length / 4),
      provenance: [{ sourceId: SOURCE_ID, kind: "folder", input: "/some/local/skills" }],
    };
    if (opts.withEmbeddings) entry.embedding = [0.1 + i, 0.2, 0.3, 0.4];
    return entry;
  });

  const model: ManifestReadModel = {
    schemaVersion: 1,
    seq: 1,
    generatedAt: new Date().toISOString(),
    sourcesDir: "sources",
    skills,
  };
  if (opts.withEmbeddings) {
    model.embeddingModel = "fake-embed";
    model.embeddingDim = 4;
  }
  fs.writeFileSync(path.join(home, "manifest.json"), JSON.stringify(model, null, 2));
  return home;
}

// (a) matching query → correct chosen + thresholds present + a non-empty full injection ─────────────
test("routeQuery: a strongly-matching lexical query fires, returns the right skill + thresholds + injection", async () => {
  const home = buildHome();
  const r = await routeQuery(home, "extract tables text rows from a pdf spreadsheet", "lmstudio", null);

  assert.equal(r.mode, "lexical");
  assert.ok(r.chosen, "a skill should be chosen");
  assert.equal(r.chosen?.slug, "pdf-extract");
  assert.equal(r.chosen?.tier, "lexical");

  // thresholds are ALWAYS present so the UI can place the score relative to θ
  assert.equal(r.thresholds.lexicalFireThreshold, 4.0);
  assert.equal(r.thresholds.semanticFireThreshold, 0.6);
  assert.equal(r.thresholds.ambiguityEpsilon, 0.04);
  assert.ok((r.chosen?.score ?? 0) >= r.thresholds.lexicalFireThreshold, "top score clears the lexical gate");

  // confident single match → full disclosure, body loaded from disk, MEASURED bytes > 0
  assert.equal(r.injection.disclosure, "full");
  assert.ok(r.injection.injectedBytes > 0, "a full injection has measured bytes");
  assert.ok(r.injection.text.includes("PDF Extractor"));
  assert.deepEqual(r.injection.injectedSlugs, ["pdf-extract"]);

  // embeddings absent from this manifest → semantic not available, NOT flagged as degraded
  assert.equal(r.semantic.available, false);
  assert.equal(r.semantic.degraded, false);
});

// (b) a no-match query → mode "none" (inject nothing is first-class) ─────────────────────────────────
test('routeQuery: a no-match query returns mode "none" and injects nothing', async () => {
  const home = buildHome();
  const r = await routeQuery(home, "ztfqx wgblmn qqzzpp", "lmstudio", null);

  assert.equal(r.mode, "none");
  assert.equal(r.chosen, null);
  assert.equal(r.injection.disclosure, "none");
  assert.equal(r.injection.injectedBytes, 0);
  assert.equal(r.injection.text, "");
  // thresholds are still returned so the UI can show the top score sitting BELOW θ
  assert.equal(r.thresholds.lexicalFireThreshold, 4.0);
});

// (c) manifest WITH vectors + embed:null → lexical, reported as "no embedder" (not degraded) ─────────
test("routeQuery: manifest carries vectors but no embedder supplied → lexical, not degraded", async () => {
  const home = buildHome({ withEmbeddings: true });
  const r = await routeQuery(home, "extract tables text rows from a pdf spreadsheet", "lmstudio", null);
  assert.equal(r.chosen?.slug, "pdf-extract");
  assert.equal(r.semantic.available, false);
  assert.equal(r.semantic.degraded, false);
  assert.match(r.semantic.note, /no query embedder/i);
});

// (d) listSkills returns entries with bundle + capabilities, with the heavy embedding stripped ───────
test("listSkills: returns entries with bundle + capabilities; embedding vectors are stripped", () => {
  const home = buildHome({ withEmbeddings: true });
  const skills = listSkills(home);
  assert.equal(skills.length, 5);

  for (const s of skills) {
    assert.ok(Array.isArray(s.bundle) && s.bundle.length >= 1, "every entry carries a bundle");
    assert.ok(s.capabilities, "every entry carries a capabilities inventory");
    assert.ok(!("embedding" in s), "the heavy embedding vector is stripped from the browser projection");
  }
  const pdf = skills.find((s) => s.slug === "pdf-extract");
  assert.ok(pdf);
  assert.equal(pdf.capabilities.scriptCount, 1);
  assert.ok(pdf.capabilities.flags.includes("network"));
  assert.ok(pdf.bundle.some((b) => b.kind === "script" && b.relPath === "extract.py"));
  assert.ok(pdf.bundle.some((b) => b.kind === "instructions"));

  // target filter: all skills are enabled for every target out-of-the-box
  assert.equal(listSkills(home, "mcp").length, 5);
});

// (e) readInstructions returns the SKILL.md body and REFUSES a dir that escapes home ─────────────────
test("readInstructions: returns the body, and throws PathEscapeError on a dir escaping home", () => {
  const home = buildHome();
  const body = readInstructions(home, `${SOURCE_ID}/pdf-extract`);
  assert.ok(body.includes("PDF Extractor"), "returns the real SKILL.md body");

  // a traversal dir must be REFUSED by core.resolveUnderRoot, never read outside the tree
  assert.throws(() => readInstructions(home, "../../../../etc/passwd"), PathEscapeError);
  assert.throws(() => readInstructions(home, `${SOURCE_ID}/../../../../../../etc`), PathEscapeError);
});

// (f) light server smoke: GET /api/manifest → 200 JSON; GET / → 200 html; ephemeral port, then close ──
test("server smoke: GET /api/manifest is 200 JSON and GET / serves the console; loopback ephemeral port", async () => {
  const home = buildHome();
  const { port, close } = await startServer(home, 0);
  try {
    assert.ok(port > 0, "an ephemeral port was bound");

    const api = await fetch(`http://127.0.0.1:${port}/api/manifest`);
    assert.equal(api.status, 200);
    assert.match(api.headers.get("content-type") ?? "", /application\/json/);
    const json = (await api.json()) as { skills: ManifestSkillEntry[] };
    assert.ok(Array.isArray(json.skills) && json.skills.length === 5);

    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await root.text(), /SkillForge/);

    const inst = await fetch(`http://127.0.0.1:${port}/api/instructions?dir=${encodeURIComponent(SOURCE_ID + "/pdf-extract")}`);
    assert.equal(inst.status, 200);
    const instJson = (await inst.json()) as { text: string };
    assert.ok(instJson.text.includes("PDF Extractor"));

    // an escaping dir is a 400, never a read outside the home (containment is observable to the API consumer)
    const bad = await fetch(`http://127.0.0.1:${port}/api/instructions?dir=${encodeURIComponent("../../../../etc/passwd")}`);
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

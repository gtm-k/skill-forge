// @skillforge/lmstudio/test/select-inject — hermetic runtime tests (PLAN §4.1, A0-A/D5/D11).
//
// HERMETIC: each test builds a throwaway temp home (a hand-written manifest.json + a sources/ tree),
// injects a FAKE query embedder (or null), and cleans up in `after`. There is NO network, NO LM Studio,
// and NO bound port. promptPreprocessor.ts is deliberately NOT imported — it imports the absent
// "@lmstudio/sdk" and is validated only via the RUNBOOK.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectAndInject, type ChatMsg } from "../src/select-inject.ts";
import { loadCatalog } from "../src/read-model.ts";
import { buildLexicalIndex, tieredSelect } from "@skillforge/core";
import type { QueryEmbedder } from "../src/embed.ts";

const made: string[] = [];
function mkTmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "skf-lms-home-"));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// ── three skills with DISJOINT vocabularies + orthogonal embeddings, so both lexical and semantic
//    routing are unambiguous. dir = "<sourceId>/<slug>"; the materialized SKILL.md lives under sources/.
interface SkillSpec {
  slug: string;
  name: string;
  description: string;
  body: string;
  embedding: number[];
}
const SOURCE_ID = "s1";
const SKILLS: SkillSpec[] = [
  {
    slug: "git-helper",
    name: "Git Helper",
    description: "Git version control: stage commit branch rebase merge push pull clone repositories.",
    body: "Use git stage, commit, and rebase to manage your repository history safely before you push.",
    embedding: [1, 0, 0],
  },
  {
    slug: "pdf-extract",
    name: "PDF Extractor",
    description: "Extract parse tables paragraphs images from PDF document files pages.",
    body: "Open the PDF, iterate its pages, and extract tables and paragraphs into structured text.",
    embedding: [0, 1, 0],
  },
  {
    slug: "email-writer",
    name: "Email Composer",
    description: "Compose draft reply professional business email newsletter messages.",
    body: "Draft a concise, professional email: greeting, one clear ask, and a courteous sign-off.",
    embedding: [0, 0, 1],
  },
];

/** Build a temp home: write each skill's SKILL.md under sources/<id>/<slug>/ and a manifest.json. */
function buildHome(opts: { withEmbeddings: boolean }): string {
  const home = mkTmpHome();
  const skills = SKILLS.map((s) => {
    const dir = `${SOURCE_ID}/${s.slug}`;
    const abs = path.join(home, "sources", SOURCE_ID, s.slug);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "SKILL.md"), `---\nname: ${s.name}\ndescription: ${s.description}\n---\n${s.body}\n`);
    const entry: Record<string, unknown> = {
      id: `id-${s.slug}`,
      slug: s.slug,
      name: s.name,
      description: s.description,
      dir,
      contentHash: `hash-${s.slug}`,
      enabledFor: { lmstudio: true, mcp: true, proxy: true },
      execAllowed: false,
      capabilities: { scriptCount: 0, interpreters: [], commands: [], flags: [] },
      bundle: [],
      warnings: [],
      bodyLen: `${s.body}\n`.length,
      tokenEstimate: Math.ceil((`${s.body}\n`.length) / 4),
      provenance: [{ sourceId: SOURCE_ID, kind: "folder", input: "/tmp/src" }],
    };
    if (opts.withEmbeddings) entry.embedding = s.embedding;
    return entry;
  });
  const model = {
    schemaVersion: 1,
    seq: 1,
    generatedAt: new Date().toISOString(),
    sourcesDir: "sources",
    ...(opts.withEmbeddings ? { embeddingModel: "fake", embeddingDim: 3 } : {}),
    skills,
  };
  fs.writeFileSync(path.join(home, "manifest.json"), `${JSON.stringify(model, null, 2)}\n`);
  return home;
}

function userTurn(text: string): ChatMsg[] {
  return [{ role: "user", content: text }];
}

/** A fake embedder that returns a fixed vector for the query (here: the git-helper orthogonal vector). */
function fakeEmbedder(vec: number[]): QueryEmbedder {
  return () => Promise.resolve(vec);
}

function readLogLines(home: string): Record<string, unknown>[] {
  const file = path.join(home, "inject.log.jsonl");
  const raw = fs.readFileSync(file, "utf8").trim();
  return raw.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

// (a) clear single match → chosen slug, rewrite contains block + original, one log line with byte proof ─
test("(a) a clear match injects the full block into the persisted user turn + records the exact bytes", async () => {
  const home = buildHome({ withEmbeddings: true });
  const query = "how do I rebase my branch and push commits with git";
  const res = await selectAndInject({ home, messages: userTurn(query), embed: fakeEmbedder([1, 0, 0]) });

  assert.equal(res.selection.chosen?.slug, "git-helper");
  assert.equal(res.injection.disclosure, "full");
  assert.equal(res.reInjected, true);
  assert.equal(res.nextStickySlug, "git-helper"); // a FULL placement advances the sticky slug

  // the rewrite is the PERSISTED user-turn rewrite: <block>\n\n<original user text>
  assert.ok(res.rewrittenLastUserMessage, "expected a rewritten user message");
  const rewrite = res.rewrittenLastUserMessage as string;
  assert.ok(rewrite.includes(res.injection.text), "rewrite must contain the injected block verbatim");
  assert.ok(rewrite.includes(query), "rewrite must still contain the original user text");
  assert.ok(rewrite.includes("rebase to manage"), "rewrite must contain the skill's instructions body");
  assert.equal(rewrite, `${res.injection.text}\n\n${query}`);

  // D11: exactly one log line whose injectedBytes is the MEASURED byte length of the injected text.
  const lines = readLogLines(home);
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.equal(line.slug, "git-helper");
  assert.equal(line.disclosure, "full");
  assert.equal(line.tier, "semantic");
  assert.equal(line.injectedBytes, Buffer.byteLength(res.injection.text));
  assert.equal(line.injectedBytes, res.injection.injectedBytes);
  assert.equal(line.injectedLen, res.injection.text.length);
});

// (b) PARITY (D5): the plugin (embed:null) must not perturb core's Tier 0/1 decision ──────────────────
test("(b) embed:null selection is byte-for-byte core parity with tieredSelect (no Tier 0/1 perturbation)", async () => {
  const home = buildHome({ withEmbeddings: true }); // embeddings present but embed:null must ignore them
  const catalog = loadCatalog(home);
  const lexIndex = buildLexicalIndex(catalog.skills);

  const pairs: { q: string; slug: string }[] = [
    { q: "stage commit rebase merge push", slug: "git-helper" },
    { q: "extract tables paragraphs from pdf document pages", slug: "pdf-extract" },
    { q: "compose draft professional business email newsletter", slug: "email-writer" },
    { q: "$pdf-extract please", slug: "pdf-extract" }, // explicit Tier 0 must also match
  ];
  for (const { q, slug } of pairs) {
    const direct = tieredSelect(q, { skills: catalog.skills, lexIndex });
    const viaPlugin = await selectAndInject({ home, messages: userTurn(q), embed: null });
    assert.equal(viaPlugin.selection.chosen?.slug, direct.chosen?.slug, `mismatch for ${JSON.stringify(q)}`);
    assert.equal(direct.chosen?.slug, slug, `core itself should pick ${slug} for ${JSON.stringify(q)}`);
  }
});

// (c) embedder returns undefined (endpoint down) → still selects via lexical, never throws ────────────
test("(c) a query embedder that resolves undefined degrades to lexical and never throws", async () => {
  const home = buildHome({ withEmbeddings: true });
  const downEmbedder: QueryEmbedder = () => Promise.resolve(undefined);
  const res = await selectAndInject({
    home,
    messages: userTurn("stage commit rebase merge push"),
    embed: downEmbedder,
  });
  assert.equal(res.selection.chosen?.slug, "git-helper");
  assert.equal(res.selection.mode, "lexical"); // semantic tier never engaged — degraded path
  assert.ok(res.rewrittenLastUserMessage);
});

// (d) STICKY (R1-B1): previousSlug === chosen + full disclosure → no re-inject, no recompounding ──────
test("(d) re-evaluating with previousSlug === the chosen full skill suppresses a recompounding re-inject", async () => {
  const home = buildHome({ withEmbeddings: true });
  const query = "stage commit rebase merge push";

  const first = await selectAndInject({ home, messages: userTurn(query), embed: null });
  assert.equal(first.selection.chosen?.slug, "git-helper");
  assert.equal(first.injection.disclosure, "full");
  assert.equal(first.reInjected, true);

  const second = await selectAndInject({
    home,
    messages: userTurn(query),
    embed: null,
    previousSlug: "git-helper",
  });
  assert.equal(second.reInjected, false);
  assert.equal(second.rewrittenLastUserMessage, null);
  // selection still resolves (the skill is still chosen) — only the PLACEMENT is suppressed.
  assert.equal(second.selection.chosen?.slug, "git-helper");
  assert.equal(second.nextStickySlug, "git-helper"); // a suppressed full turn keeps the same sticky slug
});

// (f) a non-full turn carries previousSlug FORWARD — a menu/none turn must not poison the sticky store ─
test("(f) nextStickySlug carries previousSlug forward on a non-full turn (the sticky-store poison fix)", async () => {
  const home = buildHome({ withEmbeddings: false });
  // a no-match (disclosure "none") turn while a prior skill is sticky must NOT advance the sticky slug to
  // the (null) top — it carries the prior forward, so the later full-match of that skill is not suppressed.
  const carried = await selectAndInject({
    home,
    messages: userTurn("what time is it in tokyo right now"),
    embed: null,
    previousSlug: "git-helper",
  });
  assert.notEqual(carried.injection.disclosure, "full");
  assert.equal(carried.nextStickySlug, "git-helper"); // carried forward, NOT advanced to a non-full top
  // with no prior sticky slug, a non-full turn yields null (nothing to carry)
  const none = await selectAndInject({ home, messages: userTurn("what time is it in tokyo right now"), embed: null });
  assert.equal(none.nextStickySlug, null);
});

// (g) a chosen skill whose dir ESCAPES home degrades (no throw), STILL logs, and surfaces a warning ────
test("(g) a chosen skill with a traversal dir degrades the body but never aborts the turn or skips the log", async () => {
  const home = mkTmpHome();
  // three skills so the matched one clears the BM25 fire threshold; the git skill's dir TRAVERSES out.
  const skills = SKILLS.map((s) => ({
    id: `id-${s.slug}`,
    slug: s.slug,
    name: s.name,
    description: s.description,
    dir: s.slug === "git-helper" ? "../../evil" : `${SOURCE_ID}/${s.slug}`, // git-helper dir escapes home
    contentHash: `hash-${s.slug}`,
    enabledFor: { lmstudio: true, mcp: true, proxy: true },
    execAllowed: false,
    capabilities: { scriptCount: 0, interpreters: [], commands: [], flags: [] },
    bundle: [],
    warnings: [],
    bodyLen: 10,
    tokenEstimate: 3,
    provenance: [{ sourceId: SOURCE_ID, kind: "folder", input: "/tmp/src" }],
  }));
  fs.writeFileSync(
    path.join(home, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, seq: 1, generatedAt: new Date().toISOString(), sourcesDir: "sources", skills }, null, 2)}\n`,
  );

  const res = await selectAndInject({ home, messages: userTurn("git stage commit rebase merge push branch"), embed: null });

  assert.equal(res.selection.chosen?.slug, "git-helper", "the traversal skill still matched lexically");
  // never throws; the body load was REFUSED and degraded with an observable warning
  assert.ok(
    res.warnings.some((w) => w.includes("git-helper") && /could not load/i.test(w)),
    `expected a degraded-body warning, got ${JSON.stringify(res.warnings)}`,
  );
  // never silent (D11): a log line is STILL written despite the body-load failure
  const lines = readLogLines(home);
  assert.equal(lines.length, 1, "the turn is still audited even when the chosen body cannot be read");
  assert.equal(lines[0]!.slug, "git-helper");
});

// (h) the EXACT sticky-poison regression: a MENU turn must not let a later FULL turn be suppressed ─────
test("(h) a menu turn does not poison the sticky store — the later full-commit turn still injects", async () => {
  const home = buildHome({ withEmbeddings: true }); // embeddings [1,0,0]/[0,1,0]/[0,0,1]
  const neutral = userTurn("help me with this task"); // text is lexically neutral; the fake vector decides

  // TURN 1 — query vector [1,1,0] is equidistant from git-helper [1,0,0] and pdf-extract [0,1,0]
  // (cosine ≈0.707 each, > θ) → AMBIGUOUS → a MENU whose top item is a real slug.
  const menuTurn = await selectAndInject({ home, messages: neutral, embed: fakeEmbedder([1, 1, 0]) });
  assert.equal(menuTurn.injection.disclosure, "menu");
  const menuTop = menuTurn.injection.injectedSlugs[0];
  assert.ok(menuTop, "the menu should list a top candidate");
  // THE FIX: a non-full (menu) turn does NOT advance the sticky slug to the menu's top item.
  assert.equal(menuTurn.nextStickySlug, null, "a menu turn must not advance the sticky slug");

  // TURN 2 — query vector exactly the menu-top's embedding → that skill is now a CONFIDENT FULL match.
  const topVec = menuTop === "git-helper" ? [1, 0, 0] : [0, 1, 0];
  // Carrying the CORRECT (fixed) sticky slug forward → NOT suppressed: the full body IS injected.
  const fixed = await selectAndInject({ home, messages: neutral, embed: fakeEmbedder(topVec), previousSlug: menuTurn.nextStickySlug ?? undefined });
  assert.equal(fixed.injection.disclosure, "full");
  assert.equal(fixed.reInjected, true, "the full-commit turn must inject (the menu turn did not poison the store)");

  // CONTRAST — had the OLD code stored the menu's top slug, this same commit turn would be SUPPRESSED.
  const buggy = await selectAndInject({ home, messages: neutral, embed: fakeEmbedder(topVec), previousSlug: menuTop });
  assert.equal(buggy.reInjected, false, "demonstrates the old menu-poison bug: the commit turn would have been silently suppressed");
});

// (e) no-match query → mode "none", no rewrite, log line slug null ────────────────────────────────────
test("(e) a no-match query injects nothing and logs a null-slug line", async () => {
  const home = buildHome({ withEmbeddings: false }); // lexical-only catalog
  const res = await selectAndInject({
    home,
    messages: userTurn("what time is it in tokyo right now"),
    embed: null,
  });
  assert.equal(res.selection.mode, "none");
  assert.equal(res.rewrittenLastUserMessage, null);
  assert.equal(res.reInjected, false);
  assert.equal(res.injection.disclosure, "none");
  assert.equal(res.injection.injectedBytes, 0);

  const lines = readLogLines(home);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.slug, null);
  assert.equal(lines[0]!.tier, "none");
});

// (i) semantic REQUESTED but the read-model has NO stored embeddings → a never-silent degradation warning ─
test("(i) semantic requested on a corpus with no stored embeddings surfaces a never-silent warning (M-embed)", async () => {
  const home = buildHome({ withEmbeddings: false }); // lexical-only catalog — no stored vectors
  const res = await selectAndInject({
    home,
    messages: userTurn("stage commit rebase merge push"),
    embed: fakeEmbedder([1, 0, 0]), // a REAL embedder IS provided → semantic WAS requested this turn
  });
  // routing still resolves on lexical (a vector-less skill can never be wrongly chosen — cosine 0) ...
  assert.equal(res.selection.chosen?.slug, "git-helper");
  assert.notEqual(res.selection.mode, "semantic");
  // ... but the gap (the user asked for semantic, the corpus has no vectors to rank) is SURFACED, not silent.
  assert.ok(
    res.warnings.some((w) => /no stored embeddings/i.test(w)),
    `expected a no-embeddings degradation warning, got ${JSON.stringify(res.warnings)}`,
  );
});

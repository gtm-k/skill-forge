// Golden PARITY harness (PLAN §8, decision D5) — the CI gate that makes "parity by construction" empirical.
//
// It materializes ALL real fixture skills into a temp home EXACTLY as `skill-forge add` would (a written
// manifest.json + a sources/ tree, no embeddings → the Tier 0/1 deterministic gate), then runs the full
// golden set through BOTH (a) core.tieredSelect directly and (b) the LM Studio plugin's embedded path
// (selectAndInject, embed:null), asserting identical chosen + identical ranked candidates on every fixture.
// The plugin reconstructs its routing snapshot from the read-model, so this proves the manifest round-trip
// (write entry → loadCatalog) never perturbs Tier 0/1 — the embedded-vs-daemon seam the vision worried about.
//
// Scope (R1-B2): parity is for the INJECT-BASED targets. Phase 1 has two paths (core + plugin); the proxy
// adds the third in Phase 5. The real-LM-Studio injection-behavior check is a LOCAL pre-release step (D18),
// not a CI gate (no multi-GB model in CI) — here we keep the cheap, model-free signals: parity, the
// published false-fire ceiling, a ≥4KB-instruction fixture, and the injection size-ceiling guard.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSkill, buildLexicalIndex, tieredSelect } from "@skillforge/core";
import { selectAndInject } from "../src/select-inject.ts";
import golden from "@skillforge/contracts/golden" with { type: "json" };

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "../../contracts/fixtures/skills");

// every non-placeholder fixture skill (slug = dir name), keeping the raw SKILL.md for materialization.
const raw = fs
  .readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ slug: d.name, text: fs.readFileSync(path.join(fixturesDir, d.name, "SKILL.md"), "utf8") }))
  .map((s) => ({ ...s, m: normalizeSkill(s.slug, s.text) }))
  .filter((s) => !s.m.raw?.isPlaceholder); // placeholders pollute routing (Spike A0)

const SID = "golden";
const made: string[] = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** Materialize a temp home (manifest.json + sources/) the way `skill-forge add` does — NO embeddings, so
 *  the gate is the deterministic Tier 0/1 path (explicit + lexical), reproducible without LM Studio. */
function buildHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skf-golden-"));
  made.push(home);
  const skills = raw.map((s) => {
    const dir = `${SID}/${s.slug}`;
    const abs = path.join(home, "sources", SID, s.slug);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "SKILL.md"), s.text);
    return {
      id: `id-${s.slug}`,
      slug: s.slug,
      name: s.m.name,
      description: s.m.description,
      dir,
      contentHash: `h-${s.slug}`,
      enabledFor: { lmstudio: true, mcp: true, proxy: true },
      execAllowed: false,
      capabilities: { scriptCount: 0, interpreters: [], commands: [], flags: [] },
      bundle: [],
      warnings: [],
      bodyLen: s.m.bodyLen,
      tokenEstimate: s.m.tokenEstimate,
      provenance: [{ sourceId: SID, kind: "folder", input: fixturesDir }],
    };
  });
  fs.writeFileSync(
    path.join(home, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, seq: 1, generatedAt: new Date().toISOString(), sourcesDir: "sources", skills }, null, 2)}\n`,
  );
  return home;
}

const HOME = buildHome();
const coreSkills = raw.map((s) => s.m);
const lexIndex = buildLexicalIndex(coreSkills);
const pos = golden.positives as { q: string; skill: string }[];
const neg = golden.negatives as string[];
const ask = (q: string, policy?: { maxTokens: number }) =>
  selectAndInject({ home: HOME, messages: [{ role: "user", content: q }], embed: null, policy });

test("golden corpus: >=26 real skills materialize, incl. a >=4KB-instruction skill (PREMORTEM technical)", () => {
  assert.ok(raw.length >= 26, `expected >=26 non-placeholder fixtures, got ${raw.length}`);
  const maxBody = Math.max(...raw.map((s) => s.m.instructions.length));
  assert.ok(maxBody >= 4096, `expected a >=4KB-instruction fixture; largest body was ${maxBody} chars`);
});

test("D5 PARITY: plugin embedded path == core.select over EVERY golden positive (chosen + ranked candidates)", async () => {
  for (const { q } of pos) {
    const core = tieredSelect(q, { skills: coreSkills, lexIndex });
    const plugin = await ask(q);
    assert.equal(plugin.selection.mode, core.mode, `mode mismatch for ${JSON.stringify(q)}`);
    assert.equal(plugin.selection.chosen?.slug, core.chosen?.slug, `chosen mismatch for ${JSON.stringify(q)}`);
    assert.deepEqual(
      plugin.selection.candidates.map((c) => c.slug),
      core.candidates.map((c) => c.slug),
      `ranked-candidate mismatch for ${JSON.stringify(q)}`,
    );
  }
});

test("golden lexical precision@1 meets the offline floor on the plugin path (>=0.70)", async () => {
  let correct = 0;
  for (const { q, skill } of pos) {
    const plugin = await ask(q);
    if (plugin.selection.chosen?.slug === skill) correct++;
  }
  const p = correct / pos.length;
  console.log(`  golden lexical precision@1 (plugin path) = ${correct}/${pos.length} = ${(p * 100).toFixed(0)}%`);
  assert.ok(p >= 0.7, `precision ${p} below the 0.70 offline floor`);
});

test("negative set stays under the published false-fire ceiling — and core/plugin agree on every negative", async () => {
  let fired = 0;
  const culprits: string[] = [];
  for (const q of neg) {
    const core = tieredSelect(q, { skills: coreSkills, lexIndex });
    const plugin = await ask(q);
    assert.equal(plugin.selection.mode, core.mode, `negative parity mismatch for ${JSON.stringify(q)}`);
    if (plugin.selection.mode !== "none") {
      fired++;
      culprits.push(`${q.slice(0, 26)} -> ${plugin.selection.chosen?.slug}`);
    }
  }
  console.log(`  golden false-fires = ${fired}/${neg.length} ${culprits.length ? JSON.stringify(culprits) : ""}`);
  assert.ok(fired <= 2, `false-fire ceiling exceeded: ${fired}/${neg.length}`);
});

test("injection size-ceiling: the >=4KB skill is budget-guarded (the per-target ceiling, ENFORCED not advisory)", async () => {
  const big = raw.reduce((a, b) => (b.m.instructions.length > a.m.instructions.length ? b : a));
  const bodyTokens = Math.ceil(big.m.instructions.length / 4);

  // A TIGHT budget (well below the >=4KB body) must NOT inject the full body, and the returned content
  // NEVER exceeds the budget — the per-target ceiling is enforced on every disclosure (menu or none),
  // so a runaway body can't blow the channel. (Whether it degrades to a menu or to nothing depends on
  // how long the skill's name+description are; both are budget-correct.)
  const tight = await ask(`$${big.slug}`, { maxTokens: 256 });
  assert.equal(tight.selection.chosen?.slug, big.slug, "explicit $slug must select the big skill (Tier 0)");
  assert.notEqual(tight.injection.disclosure, "full", "an over-budget full body must NOT be injected as full");
  assert.ok(tight.injection.tokenCost <= 256, `tight injection tokenCost ${tight.injection.tokenCost} exceeds the 256-token budget`);

  // A budget sized to the body injects the FULL block — byte-measured (D11). Spike A0 confirmed a ~14KB
  // block is honored by LM Studio; the budget is what keeps a runaway body from blowing the channel.
  const generous = await ask(`$${big.slug}`, { maxTokens: bodyTokens + 200 });
  assert.equal(generous.injection.disclosure, "full", "a body-sized budget injects the full block");
  assert.equal(generous.injection.injectedBytes, Buffer.byteLength(generous.injection.text, "utf8"), "injectedBytes must be the measured byte length");
  assert.ok(generous.injection.tokenCost <= bodyTokens + 200, "the full injection stays within its budget");
});

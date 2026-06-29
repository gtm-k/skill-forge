// Golden DAEMON-PATH parity (PLAN §8 / D5) — the CI gate proving the integration end to end:
//   daemon /route-test  ==  the LM Studio plugin's embedded runtime  ==  core.select / selectWithEscalation
// over the SAME golden corpus, asserting FULL byte-identity (chosen + every ranked candidate's
// id/slug/score/tier/reasons AND the injection's text/injectedBytes/tokenCost — D11), not just slugs.
//
// Three §8 assertions live here:
//   1. Tier 0/1 byte-identity: daemon == plugin == core over EVERY golden query, AND the A0 operating point
//      is LOCKED (positive precision@1 + negative false-fires pinned to the Spike-A0 numbers) so a MOVED
//      routing decision fails CI even if all three agree on the new (wrong) answer — NO embeddings.
//   2. PARTIAL-embedding parity: a corpus where SOME skills are embedded and some are not — daemon ==
//      plugin == core (full selection + injection), proving the SINGLE semantic-primary cascade (D26). This
//      is the exact case the plugin's OLD all-or-nothing gate diverged on (the §6 gap W6 closes).
//   3. FLOAT32 vs FLOAT64: a high-dim corpus run through a Float32 index reproduces the Float64 ranking
//      EXACTLY — the ~1e-7 cosine delta never moves a chosen/candidate decision.
//
// W6 INTEGRATION SEAM: this is the ONE place a test crosses the daemon↔plugin adapter boundary, on purpose,
// to prove parity. Neither adapter imports the other in source (§2) — the relative import is test-only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeSkill,
  parseFrontmatter,
  buildLexicalIndex,
  tieredSelect,
  buildInjection,
  createEmbeddingIndex,
  createEmbedProvider,
  selectWithEscalation,
} from "@skillforge/core";
import type { CloneFn } from "@skillforge/core";
import { SCHEMA_VERSION } from "@skillforge/contracts";
import type { InjectionPolicy, ManifestSkillEntry, SkillManifest } from "@skillforge/contracts";
import type { EmbeddingsProvider, RouteTestResult } from "@skillforge/contracts/api";
import golden from "@skillforge/contracts/golden" with { type: "json" };
import { createDaemon } from "../src/index.ts";
import { mkTmp, cleanup } from "./helpers.ts";
import { httpJson } from "./server-helpers.ts";
import { selectAndInject } from "../../lmstudio-plugin/src/select-inject.ts";

after(cleanup);

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "../../contracts/fixtures/skills");

// every non-placeholder fixture skill (slug = dir name); placeholders pollute routing (Spike A0).
const raw = fs
  .readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ slug: d.name, text: fs.readFileSync(path.join(fixturesDir, d.name, "SKILL.md"), "utf8") }))
  .map((s) => ({ ...s, m: normalizeSkill(s.slug, s.text) }))
  .filter((s) => !s.m.raw?.isPlaceholder);

const pos = golden.positives as { q: string; skill: string }[];
const neg = golden.negatives as string[];

// ── A0 OPERATING POINT — LOCKED by a FROZEN PER-POSITIVE DECISION TABLE (the Tier 0/1 daemon path's actual
// chosen slug for each of the 26 positives, in golden order — "none" where nothing cleared the gate). This
// catches ANY moved decision: a BALANCED swap (one positive breaks while a previously-wrong one starts
// resolving — count unchanged) AND a UNIFORM core-logic shift that moves daemon+plugin+core TOGETHER (which
// the three-way byte-identity check, comparing only divergence, would miss). A surprise here is a REAL
// signal — STOP and surface, do NOT silently re-snapshot. The original 30-positive table dropped its first
// four entries (docx/pdf/pptx/xlsx — all correct hits) when those proprietary Anthropic document fixtures
// were removed for the public Apache-2.0 repo, leaving 20 hits + 6 known keyword-overlap misses
// (mcp-builder→internal-comms, brainstorming→brand-guidelines, systematic-debugging→none,
// test-driven-development→finishing-a-development-branch, requesting-code-review→finishing-a-development-branch,
// subagent-driven-development→executing-plans) over the remaining 26 — the Spike-A0 lexical operating point
// for those 26, unchanged by the deletion (removing the document skills moved no surviving decision).
const A0_DECISIONS: readonly string[] = [
  "slack-gif-creator", "algorithmic-art", "brand-guidelines",
  "internal-comms", "brand-guidelines", "none", "finishing-a-development-branch", "writing-plans",
  "finishing-a-development-branch", "receiving-code-review", "frontend-design", "doc-coauthoring",
  "webapp-testing", "web-artifacts-builder", "theme-factory", "dispatching-parallel-agents",
  "using-git-worktrees", "internal-comms", "verification-before-completion", "finishing-a-development-branch",
  "executing-plans", "canvas-design", "using-superpowers", "executing-plans", "skill-creator", "writing-skills",
];
// Secondary counts (a coarser cross-check kept alongside the per-decision table).
const A0_POSITIVE_CORRECT = 20; // daemon precision@1 over the 26 positives (lexical Tier 0/1) — measured
const A0_NEGATIVE_FALSE_FIRES = 1; // daemon false-fires over the 15 negatives — measured
const FALSE_FIRE_CEILING = 2;
const PRECISION_FLOOR = 0.7;

// the route-test + plugin + reproduced-core all share these injection defaults (DEFAULT_ROUTE_TEST_* ==
// DEFAULT_MAX_* == 2000 / 5), so buildInjection is byte-comparable three-way.
const POLICY: InjectionPolicy = { maxTokens: 2000, menuOnAmbiguous: true, maxMenuItems: 5 };

/** A no-network CloneFn materializing the NON-PLACEHOLDER golden fixtures into `dest` (slug = dir name). */
const cloneGolden: CloneFn = async (_ref, dest) => {
  for (const s of raw) {
    const dir = path.join(dest, s.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), s.text);
  }
};

/** Lift a stored ManifestSkillEntry into the SkillManifest the selector consumes — with the body loaded the
 *  SAME way as the daemon's readInstructions AND the plugin's loadInstructions: FRONTMATTER STRIPPED, so a
 *  reproduced core `full` injection is byte-identical to both. */
function toManifest(home: string) {
  return (e: ManifestSkillEntry): SkillManifest => {
    let instructions = "";
    try {
      instructions = parseFrontmatter(fs.readFileSync(path.join(home, "sources", e.dir, "SKILL.md"), "utf8")).body;
    } catch {
      /* body is optional for routing (lexical/semantic use metadata + the chosen body only) */
    }
    const m: SkillManifest = {
      schemaVersion: SCHEMA_VERSION,
      slug: e.slug,
      name: e.name,
      description: e.description,
      instructions,
      bodyLen: e.bodyLen,
      tokenEstimate: e.tokenEstimate,
      warnings: e.warnings,
      id: e.id,
      contentHash: e.contentHash,
    };
    if (e.embedding) m.embedding = e.embedding;
    return m;
  };
}

const routeTest = (url: string, content: string) =>
  httpJson<RouteTestResult>(url, "POST", "/route-test", { target: "lmstudio", messages: [{ role: "user", content }] });

/** Canonical three-way comparison key: the full selection AND the full injection (D11 bytes included). */
const shape = (selection: unknown, injection: unknown): string => JSON.stringify({ selection, injection });

// ── 1. Tier 0/1: daemon == plugin == core (FULL byte-identity) + A0 locked ────────────────────────────────
test("§8 DAEMON parity (Tier 0/1): daemon == plugin == core (full selection + injection) AND the A0 point is locked", async () => {
  const home = mkTmp("skf-gold-daemon-");
  const daemon = createDaemon({ home, port: 0, reachable: async () => false, clone: cloneGolden });
  const { url } = await daemon.start();
  try {
    await httpJson(url, "POST", "/sources", { input: "https://github.com/owner/golden" });

    // reproduce core over the daemon's EXACT enabled pool (store.list slug-order = the manifest order the
    // plugin reads), with frontmatter-stripped bodies — so selection AND injection are byte-comparable.
    const entries = daemon.persistence.store.list({ target: "lmstudio", enabledOnly: true });
    assert.ok(entries.length >= 26, `expected >=26 ingested golden fixtures, got ${entries.length}`);
    const pool = entries.map(toManifest(home));
    const lexIndex = buildLexicalIndex(pool);

    // three-way FULL byte-identity for one query: daemon == core == plugin (selection + injection, D11).
    const assertThreeWay = async (q: string, daemonResult: RouteTestResult): Promise<void> => {
      const csel = tieredSelect(q, { skills: pool, lexIndex }); // core (reproduced) — selection + injection
      const cinj = buildInjection(csel, pool, POLICY);
      const pres = await selectAndInject({ home, messages: [{ role: "user", content: q }], embed: null }); // plugin
      const C = shape(csel, cinj);
      assert.equal(shape(daemonResult.selection, daemonResult.injection), C, `daemon != core (full selection+injection) for ${JSON.stringify(q)}`);
      assert.equal(shape(pres.selection, pres.injection), C, `plugin != core (full selection+injection) for ${JSON.stringify(q)}`);
    };

    // POSITIVES — three-way identity + the FROZEN per-positive decision table (the primary A0 lock).
    let positiveCorrect = 0;
    for (let i = 0; i < pos.length; i++) {
      const { q, skill } = pos[i]!;
      const rt = await routeTest(url, q);
      assert.equal(rt.status, 200, `route-test HTTP for ${JSON.stringify(q)}`);
      await assertThreeWay(q, rt.body);

      const chosen = rt.body.selection.chosen?.slug ?? "none";
      assert.equal(
        chosen,
        A0_DECISIONS[i],
        `A0 DECISION MOVED for positive ${i} ${JSON.stringify(q)}: snapshot ${JSON.stringify(A0_DECISIONS[i])} → now ${JSON.stringify(chosen)} (STOP — A0 is locked; surface this, do NOT re-snapshot)`,
      );
      if (chosen === skill) positiveCorrect++;
    }

    // NEGATIVES — three-way identity + the false-fire tally.
    let daemonFalseFires = 0;
    const culprits: string[] = [];
    for (const q of neg) {
      const rt = await routeTest(url, q);
      assert.equal(rt.status, 200, `route-test HTTP for ${JSON.stringify(q)}`);
      await assertThreeWay(q, rt.body);
      if (rt.body.selection.mode !== "none") {
        daemonFalseFires++;
        culprits.push(`${q.slice(0, 24)} -> ${rt.body.selection.chosen?.slug}`);
      }
    }

    // SECONDARY (coarser) A0 cross-check: the aggregate counts, alongside the per-decision table above.
    const precision = positiveCorrect / pos.length;
    console.log(`  daemon precision@1 = ${positiveCorrect}/${pos.length} = ${(precision * 100).toFixed(0)}%; false-fires = ${daemonFalseFires}/${neg.length} ${culprits.length ? JSON.stringify(culprits) : ""}`);
    assert.ok(precision >= PRECISION_FLOOR, `daemon precision ${precision} below the ${PRECISION_FLOOR} floor`);
    assert.equal(positiveCorrect, A0_POSITIVE_CORRECT, "A0 positive precision MOVED — a routing decision changed (STOP, do not silently re-pin)");
    assert.ok(daemonFalseFires <= FALSE_FIRE_CEILING, `daemon false-fire ceiling exceeded: ${daemonFalseFires}/${neg.length}`);
    assert.equal(daemonFalseFires, A0_NEGATIVE_FALSE_FIRES, "A0 negative false-fires MOVED — a routing decision changed (STOP, do not silently re-pin)");
  } finally {
    await daemon.stop();
  }
});

// ── 2. PARTIAL embedding: daemon == plugin == core (full selection + injection) when SOME skills lack a vector
const PROVIDER: EmbeddingsProvider = { baseUrl: "http://127.0.0.1:1234", model: "nomic", dim: 3 };
/** deterministic 3-d "embedding" by keyword: image-space vs csv-space vs neutral (no model needed). */
function vecFor(text: string): number[] {
  const t = text.toLowerCase();
  if (/imag|resiz|crop|photo/.test(t)) return [1, 0, 0];
  if (/csv|parse|tabular|column/.test(t)) return [0, 1, 0];
  return [0, 0, 1];
}
function writeSkill(dest: string, slug: string, name: string, description: string): void {
  const dir = path.join(dest, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nDetailed instructions for ${name}.\n`);
}

test("§8 PARTIAL-embedding parity: daemon == plugin == core (full selection + injection) where ONE skill lacks a vector", async () => {
  const home = mkTmp("skf-gold-partial-");
  let embedDown = false;
  let activeClone: CloneFn = async (_ref, dest) => writeSkill(dest, "image-tool", "Image Tool", "resize and crop images and photos");
  const embedFetch = async (_url: string, init: { body: string }) => {
    if (embedDown) return { ok: false, status: 503, json: async (): Promise<unknown> => ({}) };
    const parsed = JSON.parse(init.body) as { input: string[] };
    return { ok: true, status: 200, json: async (): Promise<unknown> => ({ data: [{ embedding: vecFor(parsed.input[0] ?? "") }] }) };
  };
  const daemon = createDaemon({
    home,
    port: 0,
    reachable: async () => false,
    clone: (ref, dest) => activeClone(ref, dest),
    config: { embeddings: PROVIDER },
    embedFetch,
  });
  const { url } = await daemon.start();
  try {
    // source A ingested with the provider UP → image-tool gets a vector.
    await httpJson(url, "POST", "/sources", { input: "https://github.com/owner/a" });
    // source B ingested with the provider DOWN → csv-tool is stored WITHOUT a vector (a PARTIAL corpus).
    embedDown = true;
    activeClone = async (_ref, dest) => writeSkill(dest, "csv-tool", "CSV Tool", "parse and query csv tabular column files");
    await httpJson(url, "POST", "/sources", { input: "https://github.com/owner/b" });
    embedDown = false; // restore so the QUERY embeds fine

    const entries = daemon.persistence.store.list({ target: "lmstudio", enabledOnly: true });
    assert.equal(entries.length, 2, "two skills total");
    assert.equal(entries.filter((e) => e.embedding && e.embedding.length > 0).length, 1, "exactly ONE is embedded — a genuinely partial corpus");

    const query = "I want to resize an image"; // image-space → must fire image-tool SEMANTICALLY
    const rt = await routeTest(url, query);
    assert.equal(rt.body.selection.mode, "semantic", "semantic-primary FIRED on a partial corpus (the OLD all-or-nothing plugin would have collapsed to lexical here)");

    // plugin reads the SAME published manifest at `home`, with a QueryEmbedder using the SAME vecFor.
    const plugin = await selectAndInject({ home, messages: [{ role: "user", content: query }], embed: async (t: string) => vecFor(t) });
    // core (reproduced over the daemon pool + the same embedFn) — the third leg.
    const pool = entries.map(toManifest(home));
    const lexIndex = buildLexicalIndex(pool);
    const embeddingIndex = createEmbeddingIndex({ dim: PROVIDER.dim });
    await embeddingIndex.ensure(entries);
    const core = await selectWithEscalation(query, { skills: pool, lexIndex, embeddingIndex, embedFn: createEmbedProvider(PROVIDER, embedFetch) });
    const cinj = buildInjection(core.selection, pool, POLICY);

    const C = shape(core.selection, cinj);
    assert.equal(shape(rt.body.selection, rt.body.injection), C, "daemon != core (full selection+injection) on a partial corpus");
    assert.equal(shape(plugin.selection, plugin.injection), C, "plugin != core (full selection+injection) on a partial corpus");
  } finally {
    await daemon.stop();
  }
});

// ── 3. Float32 vs Float64: a Float32 index reproduces the Float64 ranking exactly over a high-dim corpus ──
/** mulberry32 — a tiny deterministic PRNG (seeded → reproducible corpus → non-flaky assertion). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function vskill(slug: string, embedding: number[]): SkillManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    slug,
    name: slug,
    description: `${slug} tool`,
    instructions: "",
    bodyLen: 0,
    tokenEstimate: 0,
    warnings: [],
    id: `id-${slug}`,
    contentHash: `h-${slug}`,
    embedding,
  };
}

test("§8 FLOAT32 vs FLOAT64: a Float32 index reproduces the Float64 ranking EXACTLY (the ~1e-7 cosine delta never moves a decision)", async () => {
  const D = 768;
  const N = 24;
  const M = 20;
  const rnd = mulberry32(0x5f375a86);
  const gauss = (): number => {
    let s = 0;
    for (let i = 0; i < 6; i++) s += rnd();
    return s - 3; // ~N(0, 0.5), the spread of a real embedding component
  };

  const skillVecs64: number[][] = [];
  const skills: SkillManifest[] = [];
  for (let i = 0; i < N; i++) {
    const v = Array.from({ length: D }, gauss);
    skillVecs64.push(v);
    skills.push(vskill(`s${i}`, v));
  }
  const lexIndex = buildLexicalIndex(skills);
  const embeddingIndex = createEmbeddingIndex({ dim: D });
  // vskill builds minimal SkillManifest stand-ins; ensure() reads id/contentHash/enabledFor/embedding for
  // scoring (plus slug/name/description for a haystack used only when a filter.q is set — not set here), so
  // the cast to the (fuller) ManifestSkillEntry it nominally takes is runtime-safe for this parity harness.
  await embeddingIndex.ensure(skills as unknown as ManifestSkillEntry[]); // Float32Array.from each vector — the daemon/new-plugin representation

  for (let qi = 0; qi < M; qi++) {
    const target = qi % N;
    // query = the target's vector + small noise → a clear high-cosine winner plus realistic spread elsewhere.
    const qv = skillVecs64[target]!.map((x) => x + 0.15 * gauss());

    // FLOAT64 path — number[] vectors straight into tieredSelect (the plugin's OLD representation).
    const sel64 = tieredSelect(`q${qi}`, { skills, lexIndex, queryVec: qv, skillVecs: skillVecs64 });
    // FLOAT32 path — selectWithEscalation aligns the cached Float32Array vectors (the NEW shared path).
    const sel32 = (
      await selectWithEscalation(`q${qi}`, { skills, lexIndex, embeddingIndex, embedFn: async () => Float32Array.from(qv) })
    ).selection;

    assert.equal(sel64.chosen?.slug, `s${target}`, `precision@1: the noised target must win (query ${qi})`);
    assert.equal(sel32.chosen?.slug, sel64.chosen?.slug, `chosen differs f32 vs f64 (query ${qi})`);
    assert.deepEqual(
      sel32.candidates.map((c) => c.slug),
      sel64.candidates.map((c) => c.slug),
      `candidate ORDER differs f32 vs f64 (query ${qi}) — a 1e-7 cosine delta moved a decision`,
    );
  }
});

// Core routing gate — proves the TS engine reproduces the Spike A0 numbers
// over the 28 real skills + the golden query set. Runs offline (lexical) and,
// if LM Studio is reachable, also gates the semantic tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeSkill, buildLexicalIndex, tieredSelect, cosine } from "@skillforge/core";
import golden from "@skillforge/contracts/golden" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, "../../contracts/fixtures/skills");

const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => normalizeSkill(d.name, readFileSync(join(skillsDir, d.name, "SKILL.md"), "utf8")))
  .filter((s) => !s.raw?.isPlaceholder); // placeholders pollute routing (Spike A0)

const lexIndex = buildLexicalIndex(skills);
const pos = golden.positives as { q: string; skill: string }[];
const neg = golden.negatives as string[];

test("corpus + normalize: 26+ real skills, folded scalar + placeholder handled", () => {
  assert.ok(skills.length >= 26, `expected >=26 skills, got ${skills.length}`);
  const claudeApi = skills.find((s) => s.slug === "claude-api");
  assert.ok(claudeApi, "claude-api present");
  assert.ok(claudeApi.raw?.hadFoldedDescription, "claude-api description is a YAML folded scalar");
  assert.ok(claudeApi.description.length > 5, "folded description was actually parsed");
});

test("lexical precision@1 reproduces Spike A0 (>=0.70)", () => {
  let correct = 0;
  for (const { q, skill } of pos) {
    const top = lexIndex.rank(q)[0];
    if (top?.slug === skill) correct++;
  }
  const p = correct / pos.length;
  console.log(`  lexical precision@1 = ${correct}/${pos.length} = ${(p * 100).toFixed(0)}%`);
  assert.ok(p >= 0.7, `lexical precision ${p} below 0.70`);
});

test("lexical false-fire on negatives stays low at the firing gate (<=2/15)", () => {
  let fired = 0;
  const culprits: string[] = [];
  for (const q of neg) {
    const sel = tieredSelect(q, { skills, lexIndex }); // lexical-only, no embeddings
    if (sel.mode !== "none") { fired++; culprits.push(`${q.slice(0, 28)} -> ${sel.chosen?.slug}`); }
  }
  console.log(`  lexical false-fires = ${fired}/${neg.length} ${culprits.length ? JSON.stringify(culprits) : ""}`);
  assert.ok(fired <= 2, `too many false-fires: ${fired}`);
});

test("tieredSelect: explicit $slug always wins", () => {
  const sel = tieredSelect("please use $frontend-design on this file", { skills, lexIndex });
  assert.equal(sel.mode, "explicit");
  assert.equal(sel.chosen?.slug, "frontend-design");
});

// ---- semantic tier (best-effort; needs LM Studio at 127.0.0.1:1234) ----
async function embed(texts: string[]): Promise<number[][]> {
  const r = await fetch("http://127.0.0.1:1234/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-nomic-embed-text-v1.5", input: texts }),
  });
  if (!r.ok) throw new Error(`embeddings HTTP ${r.status}`);
  const d = (await r.json()) as { data: { embedding: number[] }[] };
  return d.data.map((x) => x.embedding);
}

test("semantic tier beats lexical when LM Studio is up (>=0.85)", async (t) => {
  let skillVecs: number[][];
  try {
    skillVecs = await embed(skills.map((s) => `${s.name}. ${s.description || s.slug}`));
  } catch (e) {
    t.skip(`LM Studio not reachable — semantic tier not gated this run (${(e as Error).message})`);
    return;
  }
  const qVecs = await embed(pos.map((p) => p.q));
  let correct = 0;
  for (let i = 0; i < pos.length; i++) {
    const sel = tieredSelect(pos[i]!.q, { skills, lexIndex, queryVec: qVecs[i], skillVecs });
    if (sel.chosen?.slug === pos[i]!.skill) correct++;
  }
  const p = correct / pos.length;
  console.log(`  tiered (lexical+semantic) precision@1 = ${correct}/${pos.length} = ${(p * 100).toFixed(0)}%`);
  assert.ok(cosine([1, 0], [1, 0]) === 1, "cosine sanity");
  assert.ok(p >= 0.85, `tiered precision ${p} below 0.85`);
});

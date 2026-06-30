// Legal lint (fixtures attribution gate): the public Apache-2.0 repo must NEVER ship a fixture skill whose
// frontmatter license is non-redistributable OR points at a license file that does not exist.
//
// THE INVARIANT: every packages/contracts/fixtures/skills/**/SKILL.md is redistributable and self-describing.
// Two failure classes fail CI:
//   1. PROPRIETARY  — the license value contains "Proprietary" (e.g. Anthropic's docx/pdf/pptx/xlsx skills,
//      "(c) Anthropic, PBC. All rights reserved", redistribution FORBIDDEN). Such a fixture cannot ship at all.
//   2. DANGLING REF — the license value references a "LICENSE.txt" that ships nowhere (not beside the skill,
//      not at the repo root). A reader following that pointer hits a 404; the real terms live in
//      /THIRD_PARTY_LICENSES.md, so the line must point there (or anywhere that actually exists), never at a
//      phantom LICENSE.txt.
//
// Zero-install: node built-ins only, no deps. Only the `license:` frontmatter line is inspected (routing uses
// name/description/body, so this guard is orthogonal to selection).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const fixturesRoot = join(repoRoot, "packages", "contracts", "fixtures", "skills");

const FM_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---/;

/** Pull the raw `license:` value out of a SKILL.md frontmatter block (null when absent). */
function licenseOf(text) {
  const m = FM_RE.exec(text);
  if (!m) return null;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^license:(.*)$/i.exec(line);
    if (kv) return (kv[1] ?? "").trim();
  }
  return null;
}

/** Every SKILL.md under the fixtures tree (one per skill directory). */
function skillFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...skillFiles(abs));
    else if (name === "SKILL.md") out.push(abs);
  }
  return out;
}

const violations = [];
let scanned = 0;
for (const file of skillFiles(fixturesRoot)) {
  scanned++;
  const license = licenseOf(readFileSync(file, "utf8"));
  if (license == null) continue; // no license line is fine — attribution lives in NOTICE/ATTRIBUTIONS.md
  const where = relative(repoRoot, file);

  if (/proprietary/i.test(license)) {
    violations.push(`${where}: PROPRIETARY license is not redistributable — "${license}"`);
  }

  // A reference to LICENSE.txt is only valid if such a file actually ships beside the skill or at the repo root.
  if (/license\.txt/i.test(license)) {
    const skillDir = join(file, "..");
    const ships = existsSync(join(skillDir, "LICENSE.txt")) || existsSync(join(repoRoot, "LICENSE.txt"));
    if (!ships) {
      violations.push(`${where}: license references a MISSING LICENSE.txt — "${license}" (point at /THIRD_PARTY_LICENSES.md)`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\n[lint-no-proprietary-fixtures] FAILED — the public Apache-2.0 repo cannot ship these fixture skills:\n`,
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    `\nFix: delete a proprietary fixture entirely, or repoint a dangling license line to ` +
      `"Apache-2.0 — Anthropic, PBC; see /THIRD_PARTY_LICENSES.md" (see NOTICE + ATTRIBUTIONS.md).\n`,
  );
  process.exit(1);
}

console.log(
  `[lint-no-proprietary-fixtures] OK — scanned ${scanned} fixture SKILL.md file(s); ` +
    `no proprietary license and no dangling LICENSE.txt reference.`,
);

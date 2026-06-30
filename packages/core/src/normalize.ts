// @skillforge/core/normalize — parse a raw SKILL.md into a SkillManifest.
// Tolerant by design: warn, never hard-fail (a bad skill must not vanish silently).
// Handles real-world frontmatter found in Spike A0: inline values AND YAML block
// scalars (description: |- / > ), and flags placeholder skills.

import { SCHEMA_VERSION, type SkillManifest, type ValidationIssue } from "@skillforge/contracts";

const FM_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

interface RawFm { name?: string; description?: string; hadFolded: boolean }

/** Minimal frontmatter reader for the two fields routing needs. */
export function parseFrontmatter(text: string): { fm: RawFm; body: string } {
  const m = FM_RE.exec(text);
  if (!m) return { fm: { hadFolded: false }, body: text };
  const fmBlock = m[1] ?? "";
  const body = m[2] ?? "";
  const lines = fmBlock.split(/\r?\n/);
  const fm: RawFm = { hadFolded: false };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kv = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? "").toLowerCase();
    let val = (kv[2] ?? "").trim();
    if (key !== "name" && key !== "description") continue;

    // YAML block scalar: `|`, `|-`, `>`, `>-` => collect following indented lines.
    if (/^[|>][+-]?\s*$/.test(val)) {
      fm.hadFolded = true;
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.trim() === "") { collected.push(""); continue; }
        if (/^\s+/.test(l)) collected.push(l.replace(/^\s+/, ""));
        else break;
      }
      i = j - 1;
      const folded = val.startsWith(">");
      val = collected.join(folded ? " " : "\n").trim();
    } else {
      val = val.replace(/^["']|["']$/g, "");
    }
    if (key === "name") fm.name = val;
    else fm.description = val;
  }
  return { fm, body };
}

const PLACEHOLDER_RE = /replace with|description of the skill/i;

/** Parse + validate one skill. `slug` is the parent directory name (the spec's identity). */
export function normalizeSkill(slug: string, text: string): SkillManifest {
  const { fm, body } = parseFrontmatter(text);
  const warnings: ValidationIssue[] = [];

  const name = fm.name?.trim() || slug;
  const description = (fm.description ?? "").trim();

  if (!fm.name) warnings.push({ level: "warn", field: "name", msg: "missing name; using directory slug" });
  if (!description) warnings.push({ level: "error", field: "description", msg: "missing description — skill cannot route" });
  if (description.length > 1024) warnings.push({ level: "warn", field: "description", msg: "description exceeds 1024 chars" });
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) warnings.push({ level: "warn", field: "name", msg: `slug "${slug}" is not a valid skill name` });

  const isPlaceholder = PLACEHOLDER_RE.test(description) || body.trim().length < 40;
  if (isPlaceholder) warnings.push({ level: "warn", field: "description", msg: "looks like a placeholder/near-empty skill — will pollute routing" });

  return {
    schemaVersion: SCHEMA_VERSION,
    slug,
    name,
    description,
    instructions: body,
    bodyLen: body.length,
    tokenEstimate: Math.ceil(body.length / 4),
    warnings,
    raw: { hadFoldedDescription: fm.hadFolded, isPlaceholder },
  };
}

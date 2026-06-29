// @skillforge/core/source/folder — materialize a LOCAL folder source into a FetchedTree (§5, D20).
// Pure filesystem walk, NO execution: discover every directory that directly contains a SKILL.md.
// Every descent is funneled through resolveUnderRoot, and symlinked directories are NOT followed, so a
// crafted/symlinked tree cannot escape the chosen root (the containment limits — TOCTOU, hardlinks —
// are documented on safe/path.ts and inherited here).
import fs from "node:fs";
import path from "node:path";
import { resolveUnderRoot } from "../safe/index.ts";
import { shortId } from "../hash.ts";
import type { FetchedTree, SourceRef } from "@skillforge/contracts";

/**
 * Recursively collect every directory that DIRECTLY contains a SKILL.md, as POSIX-style paths relative
 * to `root` ("." denotes the root directory itself). Symlinked directories report as symlinks (not
 * directories) under readdir withFileTypes, so they are never recursed into; each descent additionally
 * passes through resolveUnderRoot for containment. Deterministic (sorted).
 */
export async function walkSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  async function recurse(absDir: string, relDir: string): Promise<void> {
    const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
    if (dirents.some((d) => d.isFile() && d.name === "SKILL.md")) found.push(relDir);
    for (const d of dirents) {
      if (!d.isDirectory()) continue; // a symlinked dir reports isSymbolicLink → not followed
      const childRel = relDir === "." ? d.name : `${relDir}/${d.name}`;
      const childAbs = resolveUnderRoot(root, childRel); // containment (throws PathEscapeError on escape)
      await recurse(childAbs, childRel);
    }
  }
  await recurse(root, ".");
  return found.sort();
}

/**
 * Resolve a local folder source. The resolved ABSOLUTE directory is the tree root; skillDirs are the
 * SKILL.md-bearing dirs relative to it. `opts.mirrorRoot`, when given, is the base directory a RELATIVE
 * ref.input is resolved against (defaults to process.cwd()); an absolute ref.input ignores it. No
 * cloning or copying happens — a folder source is read in place.
 */
export async function resolveFolder(ref: SourceRef, opts?: { mirrorRoot?: string }): Promise<FetchedTree> {
  const base = opts?.mirrorRoot ?? process.cwd();
  const root = path.isAbsolute(ref.input) ? path.resolve(ref.input) : path.resolve(base, ref.input);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(root);
  } catch (e) {
    throw new Error(`source folder not found: ${JSON.stringify(root)} (${(e as { code?: string }).code ?? "ERR"})`);
  }
  if (!stat.isDirectory()) throw new Error(`source folder is not a directory: ${JSON.stringify(root)}`);

  const skillDirs = await walkSkillDirs(root);
  const sourceId = shortId("folder", root);
  return { sourceId, root, skillDirs, ref };
}

// @skillforge/core/source/normalize-tree — turn a FetchedTree into fully-enriched SkillManifests (§5).
//
// For each SKILL.md-bearing directory it: parses routing fields + warnings (normalizeSkill), walks the
// dir for every bundle file (classifyBundleEntry), derives the HUMBLE capabilities inventory from the
// SCRIPT files' FULL content plus the SKILL.md body (detectCapabilities), computes the canonical
// content hash (bundleContentHash — the exec-grant key, D10/D20), and a stable id (shortId). Every file
// read goes through resolveUnderRoot for containment; symlinks are skipped so a link cannot leak bytes
// from outside the tree. Placeholder skills are kept, not dropped — their warnings already flag them
// (the CLI/UI decides). File paths are keyed into a Map (never a plain object), so a file literally
// named "__proto__"/"constructor"/"prototype" cannot pollute Object.prototype (the DANGEROUS_KEYS
// concern that guards.ts also addresses for object-keyed-by-untrusted-name cases).
import path from "node:path";
import fs from "node:fs";
import { bundleContentHash, shortId } from "../hash.ts";
import { resolveUnderRoot } from "../safe/index.ts";
import { classifyBundleEntry, detectCapabilities, type FileContent } from "../capability.ts";
import { normalizeSkill } from "../normalize.ts";
import type { BundleEntry, FetchedTree, SkillManifest } from "@skillforge/contracts";

/**
 * Read every regular file under `skillRoot` (recursively) as POSIX relPaths + raw bytes. Symlinks are
 * skipped (isDirectory()/isFile() are both false for them) and every join passes through
 * resolveUnderRoot, so a symlink cannot leak bytes from outside `skillRoot`.
 */
async function collectBundleFiles(skillRoot: string): Promise<{ relPath: string; bytes: Buffer }[]> {
  const out: { relPath: string; bytes: Buffer }[] = [];
  async function recurse(absDir: string, relDir: string): Promise<void> {
    const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
    for (const d of dirents) {
      const childRel = relDir === "" ? d.name : `${relDir}/${d.name}`;
      const childAbs = resolveUnderRoot(skillRoot, childRel); // containment (throws on escape)
      if (d.isDirectory()) await recurse(childAbs, childRel);
      else if (d.isFile()) out.push({ relPath: childRel, bytes: await fs.promises.readFile(childAbs) });
      // symlinks (isSymbolicLink) match neither branch → skipped
    }
  }
  await recurse(skillRoot, "");
  return out;
}

export async function normalizeTree(tree: FetchedTree): Promise<SkillManifest[]> {
  const manifests: SkillManifest[] = [];

  for (const dir of tree.skillDirs) {
    const skillRoot = resolveUnderRoot(tree.root, dir === "." ? "." : dir);
    // slug = the skill directory's basename; for a root-level skill ("."), the tree root's basename.
    const slug = dir === "." ? path.basename(tree.root) : path.basename(dir);

    const rawFiles = await collectBundleFiles(skillRoot);
    const skillMd = rawFiles.find((f) => f.relPath === "SKILL.md");
    const skillText = skillMd ? skillMd.bytes.toString("utf8") : "";

    const base = normalizeSkill(slug, skillText); // routing fields + warnings (placeholder kept)

    // Bundle entries, sorted by relPath for a deterministic manifest. classifyBundleEntry derives
    // kind / byte length / content hash / (for scripts) interpreter + commands + preview.
    const bundle: BundleEntry[] = rawFiles
      .map((f) => classifyBundleEntry(f.relPath, f.bytes))
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

    // Capabilities derive from the FULL content of SCRIPT files (never the truncated preview) plus the
    // SKILL.md body — the D14 invariant detectCapabilities documents. bytes keyed by a Map (no
    // prototype-pollution surface) and decoded to utf8 only for the scripts we actually scan.
    const bytesByPath = new Map(rawFiles.map((f) => [f.relPath, f.bytes] as const));
    const files: FileContent[] = bundle
      .filter((e) => e.kind === "script")
      .map((e) => {
        const b = bytesByPath.get(e.relPath);
        return { entry: e, content: b ? b.toString("utf8") : "" };
      });

    const capabilities = detectCapabilities(files, base.instructions);
    const contentHash = bundleContentHash(bundle.map((b) => ({ relPath: b.relPath, hash: b.hash })));
    const id = shortId(tree.sourceId, dir); // sha256(sourceId + sourceRelPath).slice(0,12)

    manifests.push({
      ...base,
      id,
      contentHash,
      bundle,
      capabilities,
      sourceId: tree.sourceId,
      sourceRelPath: dir,
    });
  }

  return manifests;
}

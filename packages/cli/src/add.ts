// @skillforge/cli/add — `skill-forge add`: paste a git URL or local folder, get a materialized
// read-only sources/ tree + an updated manifest.json read-model (PLAN Phase 1, §5, A0-A / D24).
// This is the DATA half of the magic moment.
//
// Orchestration only — every load-bearing step is core's, injected at the edge:
//   sniffSource → (resolveGit with the injected systemGitClone | copy + resolveFolder) → normalizeTree
//   → embed (injected) → buildEntry/upsert/write. The CLI adds exactly two edge capabilities core
//   refuses to hold: the git spawn (git-clone.ts) and the network embed (embed.ts). Both are injectable
//   so the whole pipeline runs offline and deterministically under test.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  sniffSource,
  resolveFolder,
  resolveGit,
  normalizeTree,
  resolveUnderRoot,
  assertNoSymlinkEscape,
  type CloneFn,
} from "@skillforge/core";
import type { FetchedTree, ManifestSkillEntry } from "@skillforge/contracts";
import { skillforgeHome, SOURCES_DIR_NAME, MANIFEST_FILE_NAME } from "./home.ts";
import { systemGitClone } from "./git-clone.ts";
import { DEFAULT_EMBED_ENDPOINT, EMBED_MODEL, lmStudioEmbedder, type Embedder } from "./embed.ts";
import { buildEntry, readManifest, upsertManifest, writeManifest } from "./manifest.ts";

export interface AddOptions {
  /** override the SkillForge home dir (tests pass a temp dir). */
  home?: string;
  /** override the git CloneFn (tests inject a no-network fake); defaults to the real system git. */
  clone?: CloneFn;
  /**
   * embedder to use at ingest. `undefined` → the real LM Studio embedder (warn-and-skip if down).
   * `null` → embeddings explicitly disabled (skip cleanly, no warning). A function → use it.
   */
  embed?: Embedder | null;
}

export interface AddResult {
  manifestPath: string;
  added: ManifestSkillEntry[];
  sourceId: string;
  warnings: string[];
}

/** Same text the routing tests + Spike A0 embed: `${name}. ${description||slug}`. */
function embedText(name: string, description: string, slug: string): string {
  return `${name}. ${description || slug}`;
}

/**
 * Materialize `input` into home/sources/<sourceId>/ and merge its skills into the manifest read-model.
 * Returns the manifest path, the entries written this call, the sourceId, and any non-fatal warnings
 * (e.g. embeddings skipped). Throws only on a genuinely fatal condition (unsupported source kind, clone
 * failure, no readable bytes) — the embedder being down is NOT fatal (A0-A).
 */
export async function addSource(input: string, opts: AddOptions = {}): Promise<AddResult> {
  const warnings: string[] = [];
  const home = skillforgeHome(opts.home);
  fs.mkdirSync(home, { recursive: true });
  // SECURITY (D20): canonicalize the home root, then route every CLI write target (sources tree,
  // staging, manifest) through resolveUnderRoot + assertNoSymlinkEscape. sourceId is a hex hash (no
  // traversal), but this also defends against a symlinked home/ or sources/ redirecting clone / copy /
  // manifest writes outside the intended root.
  const realHome = fs.realpathSync(home);
  const srcDir = resolveUnderRoot(realHome, SOURCES_DIR_NAME);
  fs.mkdirSync(srcDir, { recursive: true });
  assertNoSymlinkEscape(realHome, SOURCES_DIR_NAME); // sources/ must not be a symlink escaping home
  const mfPath = resolveUnderRoot(realHome, MANIFEST_FILE_NAME);

  const ref = sniffSource(input);

  // ── 1) materialize a self-contained tree under sources/<sourceId> ───────────────────────────────
  let tree: FetchedTree;
  if (ref.kind === "git") {
    tree = await materializeGit(ref, srcDir, opts.clone ?? systemGitClone);
  } else if (ref.kind === "folder") {
    tree = await materializeFolder(ref, srcDir);
  } else {
    // url / registry are sniffed (core classifies them) but DEFERRED in Phase 1 — git + folder are the
    // magic moment. Surfaced loudly, never a silent no-op.
    throw new Error(
      `source kind ${JSON.stringify(ref.kind)} is not supported in Phase 1 — paste a git URL or a local folder path (url/registry ingest is deferred).`,
    );
  }
  const sourceId = tree.sourceId;

  if (tree.skillDirs.length === 0) {
    warnings.push(`no SKILL.md found under ${JSON.stringify(input)} — nothing was added (the source materialized but carries no skills).`);
  }

  // ── 2) normalize → full enriched SkillManifests (id, contentHash, bundle, capabilities) ──────────
  const manifests = await normalizeTree(tree);

  // ── 3) embeddings at ingest (A0-A), keyed by contentHash; warn-and-skip if the embedder throws ───
  const embedByHash = new Map<string, number[]>();
  let computedEmbeddings = false;
  let embeddingDim: number | undefined; // stamped from the ACTUAL vectors, never a constant
  if (opts.embed !== null && manifests.length > 0) {
    const usingDefault = opts.embed === undefined;
    const embedder: Embedder = opts.embed ?? lmStudioEmbedder();
    const texts = manifests.map((m) => embedText(m.name, m.description, m.slug));
    try {
      const vectors = await embedder(texts);
      for (let i = 0; i < manifests.length; i++) {
        const m = manifests[i];
        const v = vectors[i];
        if (m?.contentHash && Array.isArray(v)) embedByHash.set(m.contentHash, v);
      }
      computedEmbeddings = embedByHash.size > 0;
      // stamp the ACTUAL returned vector dimension so embeddingDim always matches the stored
      // vectors — correct for the 768-dim nomic default AND any custom/injected embedder.
      embeddingDim = embedByHash.values().next().value?.length;
    } catch (err) {
      // A0-A: never fatal. The endpoint is named only when we used the default real embedder.
      const where = usingDefault ? ` at ${DEFAULT_EMBED_ENDPOINT}` : ` (${(err as Error).message})`;
      warnings.push(
        `embeddings unavailable${where} — manifest written without vectors; routing falls back to lexical+explicit`,
      );
    }
  }

  // ── 4) build read-model entries, upsert by id, bump seq, write atomically ────────────────────────
  const added = manifests.map((m) =>
    buildEntry(m, ref, sourceId, m.contentHash ? embedByHash.get(m.contentHash) : undefined),
  );
  const existing = readManifest(mfPath);
  const model = upsertManifest(existing, added, {
    embeddingModel: computedEmbeddings ? EMBED_MODEL : undefined,
    embeddingDim: computedEmbeddings ? embeddingDim : undefined,
  });
  writeManifest(mfPath, model);

  return { manifestPath: mfPath, added, sourceId, warnings };
}

/**
 * Git: clone (via the injected CloneFn) into a staging dir under sources/, learn the adapter-derived
 * sourceId, then atomically rename staging → sources/<sourceId> so the tree is self-contained and the
 * dir name IS the recorded sourceId. resolveGit derives sourceId from the SourceRef identity (not the
 * dest path), so the rename does not change it. The tree is re-rooted at the final dest (subdir honored,
 * containment-checked); skillDirs are relative and survive the rename untouched.
 */
async function materializeGit(ref: FetchedTree["ref"], srcDir: string, clone: CloneFn): Promise<FetchedTree> {
  const staging = resolveUnderRoot(srcDir, `.staging-${randomUUID()}`);
  try {
    const probe = await resolveGit(ref, staging, clone);
    const dest = resolveUnderRoot(srcDir, probe.sourceId); // contained under home/sources
    assertNoSymlinkEscape(srcDir, probe.sourceId); // a prior dest must not be a symlink escaping root
    fs.rmSync(dest, { recursive: true, force: true }); // re-add replaces a prior materialization
    fs.renameSync(staging, dest); // same volume (both under home/sources) → atomic move
    const root = ref.subdir ? resolveUnderRoot(dest, ref.subdir) : dest;
    return { sourceId: probe.sourceId, root, skillDirs: probe.skillDirs, ref };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true }); // best-effort: gone after a successful rename
  }
}

/**
 * Folder: resolve the external folder in place to get its stable, adapter-derived sourceId, COPY the
 * tree into sources/<sourceId> (recursive, symlinks copied as links — never dereferenced — so a link
 * cannot smuggle external bytes; normalizeTree skips symlinks anyway), then return a tree re-rooted at
 * the copy. We reuse the probe's walk (an identical copy yields identical skillDirs) and keep the
 * stable original sourceId so the manifest never points at the user's external path and re-adding the
 * same folder UPSERTS rather than duplicating. (We intentionally do not re-derive the id from the copy's
 * path — that would make the dir name and sourceId circular; see newDecisions.)
 */
async function materializeFolder(ref: FetchedTree["ref"], srcDir: string): Promise<FetchedTree> {
  const probe = await resolveFolder(ref); // root = external resolved path; sourceId = shortId("folder", root)
  const dest = resolveUnderRoot(srcDir, probe.sourceId); // contained under home/sources
  assertNoSymlinkEscape(srcDir, probe.sourceId); // a prior dest must not be a symlink escaping root
  fs.rmSync(dest, { recursive: true, force: true }); // re-add replaces a prior materialization
  fs.cpSync(probe.root, dest, { recursive: true, dereference: false });
  return { sourceId: probe.sourceId, root: dest, skillDirs: probe.skillDirs, ref };
}

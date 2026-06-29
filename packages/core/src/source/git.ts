// @skillforge/core/source/git — materialize a GIT source via an INJECTED clone (D24, §5).
//
// CORE STAYS child_process-FREE. resolveGit NEVER spawns git itself: the caller (the Wave-3 CLI)
// injects a CloneFn that performs the real shallow clone — system git, depth=1, honoring ref.ref and
// ref.subdir — into `dest`. resolveGit then walks the materialized tree exactly like a local folder.
// This mirrors how core already takes an injected EmbedFn/Store: the spawn/network capability lives at
// the edge (the CLI), not in the leverage point (core). This file deliberately imports NO
// child_process and NO git library (D24) — the source module must never gain that dependency.
import path from "node:path";
import { resolveUnderRoot } from "../safe/index.ts";
import { shortId } from "../hash.ts";
import type { FetchedTree, SourceRef } from "@skillforge/contracts";
import { walkSkillDirs } from "./folder.ts";

/**
 * Injected clone: materialize `ref` into `dest`. The Wave-3 CLI supplies a real implementation (system
 * git, depth=1, possibly honoring ref.ref / ref.subdir). Keeping this a parameter is what keeps core
 * free of child_process and any git dependency (D24).
 */
export type CloneFn = (ref: SourceRef, dest: string) => Promise<void>;

/**
 * Resolve a git source: run the injected `clone` into `dest`, then walk the result for SKILL.md dirs.
 * When ref.subdir is set the walk root is dest/<subdir> (containment-checked via resolveUnderRoot so a
 * crafted subdir cannot escape the clone destination). The sourceId is derived from the SourceRef
 * identity (input + ref + subdir) — NOT the ephemeral `dest` — so it is stable across re-clones.
 */
export async function resolveGit(ref: SourceRef, dest: string, clone: CloneFn): Promise<FetchedTree> {
  await clone(ref, dest); // the ONLY side effect; the spawn lives inside the injected fn, never here (D24)

  const root = ref.subdir ? resolveUnderRoot(dest, ref.subdir) : path.resolve(dest);
  const skillDirs = await walkSkillDirs(root);
  const sourceId = shortId("git", ref.input + (ref.ref ?? "") + (ref.subdir ?? ""));
  return { sourceId, root, skillDirs, ref };
}

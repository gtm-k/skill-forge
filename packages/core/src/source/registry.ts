// @skillforge/core/source/registry — materialize a REGISTRY source via an INJECTED resolver (D24, §5).
//
// CORE STAYS child_process-FREE. resolveRegistry NEVER shells out to `npx skills` / `skills.sh` itself:
// the caller (CLI/daemon) injects a RegistryResolveFn that runs the real fetch INTO `dest` and reports
// the version/lock coords it pinned. resolveRegistry then walks the materialized temp dir for SKILL.md
// exactly like a folder, with realpath-under-`dest` containment on everything (D20). This mirrors how
// core already takes an injected CloneFn/EmbedFn: the spawn lives at the edge, never in the leverage
// point. This file imports NO child_process and NO registry client (D24).
//
// DEST-SWAP DEFENCE (D20): `dest` is created + realpath-PINNED BEFORE the untrusted resolver runs; after
// it returns we assert `dest` is STILL that same real directory (not replaced by a symlink or relocated)
// and walk only the pinned real path — so a resolver that `rm -rf dest && ln -s /etc dest` cannot
// redirect the walk outside the intended root.
import fs from "node:fs";
import { resolveUnderRoot } from "../safe/index.ts";
import { shortId } from "../hash.ts";
import { walkSkillDirs } from "./folder.ts";
import { SourceResolveError } from "./url.ts";
import type { FetchedTree, SourceRef } from "@skillforge/contracts";

/** The version + lock coordinates the registry resolver pinned — surfaced for provenance (§5). */
export interface RegistryResolution {
  /** the concrete resolved version (e.g. "1.4.2") */
  version?: string;
  /** lock/integrity coordinates the resolver pinned (e.g. a tarball URL + integrity hash) */
  lock?: string;
}

/**
 * Injected registry resolver: materialize `ref` INTO `dest`, returning the version/lock it pinned (or
 * void if it pins nothing). The CLI/daemon supplies the real implementation (`npx skills` / skills.sh).
 * Keeping this a parameter is what keeps core free of child_process and any registry dependency (D24).
 */
export type RegistryResolveFn = (ref: SourceRef, dest: string) => Promise<RegistryResolution | void>;

/**
 * A FetchedTree plus the resolved registry coords. ADDITIVE over the frozen FetchedTree contract (which
 * carries no version/lock field): direct callers of resolveRegistry read `resolved`; the resolved
 * VERSION is additionally stamped onto `ref.ref` so it is visible through the plain FetchedTree the
 * dispatcher (resolve.ts) returns. sourceId derives from `ref.input` ONLY (not the version), so a
 * later version bump re-resolves to the SAME sourceId and UPSERTS rather than duplicating.
 */
export interface RegistryFetchedTree extends FetchedTree {
  resolved?: RegistryResolution;
}

export async function resolveRegistry(
  ref: SourceRef,
  dest: string,
  registryResolve: RegistryResolveFn,
): Promise<RegistryFetchedTree> {
  // Create + realpath-PIN dest BEFORE handing it to the untrusted resolver (D20 dest-swap defence).
  fs.mkdirSync(dest, { recursive: true });
  const pinned = fs.realpathSync(dest);

  const resolution = (await registryResolve(ref, dest)) ?? undefined; // the ONLY side effect lives in the injected fn (D24)

  // After the resolver ran, dest must STILL be the same real directory — not swapped for a symlink/file
  // and not relocated. A skill-walk that followed a swapped-in symlink would escape the intended root.
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(dest);
  } catch {
    throw new SourceResolveError({ level: "error", field: "registry", msg: `the registry resolver removed ${JSON.stringify(dest)} after resolving — nothing to walk` });
  }
  if (lst.isSymbolicLink()) {
    throw new SourceResolveError({ level: "error", field: "registry", msg: `the registry resolver replaced ${JSON.stringify(dest)} with a symlink — refused (D20)` });
  }
  const after = fs.realpathSync(dest);
  if (after !== pinned) {
    throw new SourceResolveError({ level: "error", field: "registry", msg: `the registry resolver changed the identity of ${JSON.stringify(dest)} (${JSON.stringify(after)} != ${JSON.stringify(pinned)}) — refused (D20)` });
  }

  const root = resolveUnderRoot(pinned, "."); // the pinned real path; walkSkillDirs contains every descent (D20)
  const skillDirs = await walkSkillDirs(root); // empty when the resolver materialized no SKILL.md (the caller warns)
  const sourceId = shortId("registry", ref.input); // stable across version bumps → re-resolve UPSERTS

  // Surface the resolved version on the standard SourceRef.ref field so it rides through the dispatcher's
  // FetchedTree (don't mutate the caller's ref). Lock coords have no contract field → the additive
  // `resolved` carries them for direct callers + logging.
  const outRef: SourceRef = resolution?.version ? { ...ref, ref: resolution.version } : { ...ref };
  const tree: RegistryFetchedTree = { sourceId, root, skillDirs, ref: outRef };
  if (resolution) tree.resolved = resolution;
  return tree;
}

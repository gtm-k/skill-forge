// @skillforge/core/source/resolve — the ONE sourcing dispatcher the daemon consumes (§5, D24).
//
// Dispatches a sniffed SourceRef over all four front doors to a UNIFORM FetchedTree:
//   git      → injectors.clone     (CloneFn — the same edge spawn the CLI already injects)
//   folder   → resolveFolder       (read in place — `dest` is unused; the caller mirrors/copies, as the
//                                    CLI's materializeFolder does)
//   registry → injectors.registry  (RegistryResolveFn — `npx skills` / skills.sh at the edge)
//   url      → resolveUrl           (builtin HTTPS fetch + native tar/markdown) + injectors.unzip? for .zip
//
// CORE STAYS child_process-FREE (D24): git + registry spawns are injected; only url's inert fetch/gunzip
// live in core. A missing required injector is a typed, OBSERVABLE failure — never a silent empty tree.
import { resolveFolder } from "./folder.ts";
import { resolveGit, type CloneFn } from "./git.ts";
import { resolveRegistry, type RegistryResolveFn } from "./registry.ts";
import { resolveUrl, SourceResolveError, type UrlFetch, type ResolveUrlOptions, type UnzipFn } from "./url.ts";
import type { FetchedTree, SourceRef } from "@skillforge/contracts";

/** The edge capabilities core refuses to hold itself, supplied per call by the CLI/daemon (D24). */
export interface SourceInjectors {
  /** git clone (required for kind "git") */
  clone?: CloneFn;
  /** registry resolve, e.g. `npx skills` (required for kind "registry") */
  registry?: RegistryResolveFn;
  /** unzip for `.zip` url payloads (optional; absent → a typed error, never a silent skip) */
  unzip?: UnzipFn;
  /** fetch implementation for url payloads (defaults to the global fetch) */
  fetchImpl?: UrlFetch;
  /** base dir a RELATIVE folder ref.input resolves against (defaults to process.cwd()) */
  mirrorRoot?: string;
  /** url fetch byte caps (forwarded to resolveUrl) */
  maxBytes?: number;
  maxExtractedBytes?: number;
}

/**
 * Resolve any SourceRef to a FetchedTree. `dest` is the temp dir git/registry/url materialize INTO;
 * folder is read in place and ignores `dest` (the caller copies it into sources/<sourceId>, like the
 * CLI). Throws a typed SourceResolveError when a required injector is absent.
 */
export async function resolveSource(ref: SourceRef, dest: string, injectors: SourceInjectors = {}): Promise<FetchedTree> {
  switch (ref.kind) {
    case "git": {
      if (!injectors.clone) {
        throw new SourceResolveError({ level: "error", field: "kind", msg: "git source needs an injected CloneFn (D24); none provided" });
      }
      return resolveGit(ref, dest, injectors.clone);
    }
    case "folder":
      return resolveFolder(ref, injectors.mirrorRoot ? { mirrorRoot: injectors.mirrorRoot } : undefined);
    case "registry": {
      if (!injectors.registry) {
        throw new SourceResolveError({ level: "error", field: "kind", msg: "registry source needs an injected RegistryResolveFn (D24); none provided" });
      }
      return resolveRegistry(ref, dest, injectors.registry);
    }
    case "url": {
      const urlOpts: ResolveUrlOptions = {};
      if (injectors.unzip) urlOpts.unzip = injectors.unzip;
      if (injectors.fetchImpl) urlOpts.fetchImpl = injectors.fetchImpl;
      if (injectors.maxBytes !== undefined) urlOpts.maxBytes = injectors.maxBytes;
      if (injectors.maxExtractedBytes !== undefined) urlOpts.maxExtractedBytes = injectors.maxExtractedBytes;
      return resolveUrl(ref, dest, urlOpts);
    }
    default: {
      const exhaustive: never = ref.kind; // compile-time exhaustiveness — a new kind cannot fall through silently
      throw new SourceResolveError({ level: "error", field: "kind", msg: `unsupported source kind ${JSON.stringify(exhaustive)}` });
    }
  }
}

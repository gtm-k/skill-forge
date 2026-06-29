// @skillforge/core/source/sniff — classify a raw source string into a SourceRef (§5, D7).
//
// DETERMINISTIC precedence (first match wins; documented so callers can reason about it):
//   1. folder  — an explicit filesystem-path SHAPE (./ ../ .\ ..\, a leading / or \, a drive letter
//                C:\ / C:/, or a UNC \\share). Pure string check, no filesystem access.
//   2. git     — a git URL: git:// or ssh://, scp-like git@host:path, anything ending in .git, a known
//                forge host (github.com / gitlab.com / bitbucket.org / codeberg.org), OR an http(s) URL
//                carrying a git-ism suffix (//subdir or @ref). The "@ref" and "url//subdir" parts are
//                parsed off here and returned on the ref.
//   3. url     — a plain http(s):// resource with none of the git markers above.
//   4. folder  — an EXISTING local path (relative to process.cwd()). This is the one fs-touching step;
//                it is intentionally AFTER git/url so a forge-shaped or URL-shaped string is never
//                misread as a folder just because a same-named directory happens to exist.
//   5. registry— the fallback: a bare token like "name" or "scope/name".
//
// Steps 1-3 are pure and stable across machines. Step 4 depends on cwd, so the same bare token can
// classify as "folder" on one machine and "registry" on another — that ambiguity is inherent to the
// spec ("folder if an existing local path OR looks like one"); the explicit-shape check (1) is the
// deterministic path callers should prefer when they want machine-independent results.
import fs from "node:fs";
import type { SourceRef } from "@skillforge/contracts";

const KNOWN_FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);

// Explicit filesystem-path SHAPE — no fs access. Covers ./ ../ .\ ..\, a leading slash/backslash
// (POSIX absolute and the start of a UNC \\share), and a drive letter "C:\" / "C:/".
const PATH_MARKER = /^(?:\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/])/;

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function looksLikePath(s: string): boolean {
  return PATH_MARKER.test(s);
}

/** Best-effort host of a (possibly scheme-less) git-ish URL. Lowercased; undefined if none. */
function gitHostOf(url: string): string | undefined {
  const scheme = SCHEME.exec(url);
  if (scheme) {
    const authority = url.slice((scheme[0] ?? "").length).split("/")[0] ?? "";
    const hostPort = authority.includes("@") ? (authority.split("@").pop() ?? "") : authority;
    return (hostPort.split(":")[0] ?? "").toLowerCase() || undefined;
  }
  const scp = /^[\w.-]+@([\w.-]+):/.exec(url); // scp-like git@host:path
  if (scp) return (scp[1] ?? "").toLowerCase() || undefined;
  return (url.split("/")[0] ?? "").toLowerCase() || undefined; // bare host/path
}

function isKnownForge(host: string | undefined): boolean {
  if (!host) return false;
  return KNOWN_FORGES.has(host.startsWith("www.") ? host.slice(4) : host);
}

/** Split a trailing "@ref" and a "url//subdir" off a git source string. Order: url // subdir @ ref. */
function parseSuffixes(raw: string): { url: string; ref?: string; subdir?: string } {
  let work = raw;
  let ref: string | undefined;
  let subdir: string | undefined;

  // @ref — only a "@" that is preceded by a "/" is a ref; the scp "git@host:" user "@" is not.
  const at = work.lastIndexOf("@");
  if (at > 0) {
    const firstSlash = work.indexOf("/");
    if (firstSlash !== -1 && firstSlash < at) {
      const candidate = work.slice(at + 1);
      if (candidate.length > 0) {
        ref = candidate;
        work = work.slice(0, at);
      }
    }
  }

  // //subdir — the first "//" AFTER any scheme "://".
  const scheme = SCHEME.exec(work);
  const dbl = work.indexOf("//", scheme ? (scheme[0] ?? "").length : 0);
  if (dbl !== -1) {
    const sd = work.slice(dbl + 2);
    if (sd.length > 0) {
      subdir = sd;
      work = work.slice(0, dbl);
    }
  }

  return { url: work, ref, subdir };
}

function isGitUrl(url: string, hadGitSuffix: boolean): boolean {
  if (/^(?:git|ssh):\/\//.test(url)) return true; // git:// or ssh://
  if (/^[\w.-]+@[\w.-]+:/.test(url)) return true; // scp-like git@host:path
  if (/\.git$/.test(url)) return true; // explicit .git
  if (isKnownForge(gitHostOf(url))) return true; // a known forge host
  if (hadGitSuffix && /^https?:\/\//.test(url)) return true; // //subdir or @ref on an http(s) URL
  return false;
}

export function sniffSource(input: string): SourceRef {
  const raw = input.trim();

  // 1) explicit filesystem-path shape → folder (no fs access, fully deterministic).
  if (looksLikePath(raw)) return { kind: "folder", input: raw };

  // 2) git — parse optional //subdir + @ref, then test the base URL for git markers.
  const { url, ref, subdir } = parseSuffixes(raw);
  if (isGitUrl(url, ref !== undefined || subdir !== undefined)) {
    const out: SourceRef = { kind: "git", input: raw };
    if (ref !== undefined) out.ref = ref;
    if (subdir !== undefined) out.subdir = subdir;
    return out;
  }

  // 3) a plain http(s) resource with no git markers → url.
  if (/^https?:\/\//.test(raw)) return { kind: "url", input: raw };

  // 4) an existing local path (relative to cwd) → folder. The one fs-touching branch.
  let exists = false;
  try {
    exists = fs.existsSync(raw);
  } catch {
    exists = false; // a malformed path string is simply "not a folder" here
  }
  if (exists) return { kind: "folder", input: raw };

  // 5) fallback — a bare registry token ("name" / "scope/name").
  return { kind: "registry", input: raw };
}

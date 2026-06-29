// @skillforge/cli/git-clone — the REAL system-git clone, injected into core's resolveGit (D24, §5).
//
// THIS IS THE EDGE-OF-SYSTEM SPAWN. core (@skillforge/core/source/git) is deliberately
// child_process-free: it never spawns git itself, it takes an injected CloneFn. This file is the ONLY
// place in the CLI that touches node:child_process, and it does so ONLY to perform the shallow clone
// the spec's D24 keeps OUT of core. Everything downstream (walk, normalize, hash, path-safety) runs in
// pure core on the materialized bytes.
//
// Hardening: we use spawn() with an ARRAY argv and NO shell — there is no shell-interpolation surface,
// so a hostile URL/ref string can never inject a second command. The clone URL is ref.input with the
// already-parsed `//subdir` and `@ref` markers stripped (sniffSource put those on ref.subdir/ref.ref);
// `--branch <ref.ref>` is passed as its own argv element when a ref is present.
import { spawn } from "node:child_process";
import { assertHttpsUrl, type CloneFn } from "@skillforge/core";
import type { SourceRef } from "@skillforge/contracts";

/**
 * Reconstruct the bare repository URL from a sniffed git SourceRef by stripping the suffixes
 * sniffSource already parsed off. sniff removes `@ref` first then `//subdir` (raw shape:
 * `url//subdir@ref`), so we strip in the reverse-from-end order: the trailing `@<ref>`, then the
 * trailing `//<subdir>`. Only an exact trailing match is removed, so a `@`/`//` living inside the URL
 * proper is left untouched.
 */
function cloneUrl(ref: SourceRef): string {
  let url = ref.input;
  if (ref.ref !== undefined) {
    const suffix = `@${ref.ref}`;
    if (url.endsWith(suffix)) url = url.slice(0, -suffix.length);
  }
  if (ref.subdir !== undefined) {
    const suffix = `//${ref.subdir}`;
    if (url.endsWith(suffix)) url = url.slice(0, -suffix.length);
  }
  return url;
}

/**
 * The real CloneFn injected into resolveGit: `git clone --depth=1 [--branch <ref>] <url> <dest>`.
 * No shell, array argv only. Rejects on a non-zero exit (or a spawn error) carrying git's stderr tail,
 * so the caller can surface a real failure instead of a silent empty clone.
 */
export const systemGitClone: CloneFn = (ref: SourceRef, dest: string): Promise<void> => {
  const url = cloneUrl(ref);
  // SECURITY (D24 / §5 HTTPS-only): validate the URL SCHEME before spawning git. The `--` separator
  // blocks git OPTION injection, but NOT git's remote-helper transports — `ext::…`, `file://`, `file::`,
  // `git+ssh://` etc. can execute arbitrary helpers/commands. assertHttpsUrl rejects every non-https
  // scheme (and malformed URLs), so ONLY an https remote ever reaches `git clone`. This guard is LOCAL
  // to the spawn: it does not depend on sniffSource's upstream classification being exhaustive.
  assertHttpsUrl(url);
  const args = ["clone", "--depth=1"];
  if (ref.ref !== undefined) args.push("--branch", ref.ref);
  args.push("--", url, dest);

  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      // e.g. git not on PATH — surfaced, never swallowed.
      reject(new Error(`git clone could not start (is git installed?): ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed (exit ${code ?? "null"}) for ${JSON.stringify(url)}: ${stderr.trim()}`));
    });
  });
};

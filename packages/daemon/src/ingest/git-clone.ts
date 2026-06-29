// @skillforge/daemon/ingest/git-clone — the daemon's EDGE-OF-SYSTEM git spawn (D24, §5).
//
// REPLICATED from cli/src/git-clone.ts, never imported: an adapter importing a sibling adapter is
// forbidden (§2 no adapter→adapter). core (@skillforge/core/source/git) is deliberately
// child_process-free and takes an injected CloneFn; this file is the ONLY place in the daemon that
// touches node:child_process, and it does so ONLY for the shallow clone D24 keeps OUT of core. The
// no-child_process lint is CORE-scoped — the daemon, like the CLI, MAY spawn at its edge.
//
// Hardening (identical to the CLI, PLUS the W2 SSRF host-block): spawn() with an ARRAY argv and NO shell
// (no interpolation surface), `safeUrl` BEFORE the spawn — assertHttpsUrl (rejects ext::/file::/git+ssh
// remote-helper transports the `--` separator does NOT block) AND a loopback/link-local/RFC-1918 hostname
// reject, so `addSource("https://169.254.169.254/…")` or a private/loopback host can't make git GET an
// internal resource (SSRF). HUMBLE: this is a STRING check (no DNS resolution) — a public name that
// resolves to a private IP is not caught here; that is the documented limit of the funnel's guard. Reject
// on a non-zero exit carrying git's stderr tail — never a silent empty clone.
import { spawn } from "node:child_process";
import { safeUrl, type CloneFn } from "@skillforge/core";
import type { SourceRef } from "@skillforge/contracts";

/**
 * Reconstruct the bare repo URL from a sniffed git SourceRef by stripping the suffixes sniffSource
 * already parsed off (raw shape `url//subdir@ref`): strip the trailing `@<ref>` first, then `//<subdir>`.
 * Only an exact trailing match is removed, so a `@`/`//` inside the URL proper is left untouched.
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
 * The real CloneFn injected into resolveSource: `git clone --depth=1 [--branch <ref>] -- <url> <dest>`.
 * No shell, array argv only. Validates the URL scheme before spawning (HTTPS-only, D24). Rejects on a
 * non-zero exit or a spawn error with git's stderr tail, so a real failure is surfaced, never swallowed.
 */
export const gitCloneFn: CloneFn = (ref: SourceRef, dest: string): Promise<void> => {
  const url = cloneUrl(ref);
  safeUrl(url); // LOCAL to the spawn: https-only AND SSRF host-blocked before git ever sees the remote.
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
      reject(new Error(`git clone could not start (is git installed?): ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed (exit ${code ?? "null"}) for ${JSON.stringify(url)}: ${stderr.trim()}`));
    });
  });
};

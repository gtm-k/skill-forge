// @skillforge/core/exec/gate — the SINGLE SOURCE OF TRUTH for the pre-spawn exec-gate helpers shared by the
// daemon's POST /skills/:id/run route and the standalone MCP catalog path (Wave C / D3). These are the
// security-relevant bits that were the HIGHEST drift risk: an interpreter resolver and an env allowlist that
// MUST behave identically on both paths, plus the argv-shape check and the refusal-audit SHAPE. They were
// byte-identical copies in daemon/server/routes/index.ts and mcp-server/catalog.ts — a drift here (e.g. one
// path forgetting the absolute-PATH-only filter) would be a real interpreter-shadowing hole on one surface
// only. Promoting them makes "both paths gate the same way" structural, not hopeful.
//
// These are PURE helpers — no node:child_process. The actual spawn stays in run.ts (the one chokepoint); each
// caller still performs its OWN audit IO (the daemon fails-closed via auditExec; the MCP path fails-soft and
// returns a boolean) — only the line SHAPE is shared, via refusalLine.
import fs from "node:fs";
import path from "node:path";
import type { ExecLogLine, TargetId } from "@skillforge/contracts";

/** The conservative env allowlist handed to every skill spawn: ONLY the keys an interpreter needs to start
 *  (PATH/PATHEXT to resolve a non-node interpreter, the Windows system roots, a home + temp dir, locale).
 *  Nothing else from process.env leaks into the child (no secrets, no tokens). core.run copies ONLY the named
 *  keys that are actually present (an absent key is simply not set). */
export const EXEC_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
];

/** Resolve a bundle-derived interpreter NAME to an ABSOLUTE executable path, or undefined when it cannot be
 *  located. A `node` script runs with the host's OWN node (process.execPath — deterministic). EVERY other
 *  interpreter (python/bash/sh/pwsh/…) is resolved here to an absolute path via a PATH lookup that scans ONLY
 *  absolute PATH entries — a "." (or any relative) PATH entry is SKIPPED — and that absolute path is passed as
 *  argv[0]. This closes the interpreter-shadowing class regardless of the operator's PATH (e.g. a PATH
 *  containing "."), mirroring the determinism `node` already gets (defense-in-depth: libuv does not search cwd
 *  for a bare name on Node 22, but we never rely on argv[0] being a bare name). */
export function resolveInterpreterAbsolute(interpreter: string): string | undefined {
  if (interpreter === "node") return process.execPath;
  const isFile = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (path.isAbsolute(interpreter)) return isFile(interpreter) ? interpreter : undefined;
  const dirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => d !== "" && d !== "." && path.isAbsolute(d)); // absolute-only — never a "." / relative entry
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((e) => e.toLowerCase())
      : [""];
  for (const dir of dirs) {
    const bare = path.join(dir, interpreter); // POSIX executable, or a name that already carries an ext
    if (isFile(bare)) return bare;
    if (process.platform === "win32") {
      for (const ext of exts) {
        const withExt = path.join(dir, interpreter + ext);
        if (isFile(withExt)) return withExt;
      }
    }
  }
  return undefined;
}

/** The OWNER MCP RUN-MUTE predicate (C4 / D3): the SINGLE source of truth both run paths consult so they
 *  cannot drift. A human-set, persisted, per-skill `mcpRunMuted` means "do not RUN this skill's scripts via
 *  MCP until I re-enable it". It is NON-ROTATABLE (no client/session input) and fail-closed: a run is refused
 *  ONLY when the target is "mcp" AND the owner muted it. The inject targets (lmstudio/proxy) are never gated
 *  by this, and an ABSENT flag (a pre-field manifest) reads as not-muted (backward-compat). Enforced at the
 *  daemon's live /mcp chokepoint AND the daemon-down stdio read-model path via this one helper. */
export function isMcpRunMuted(mcpRunMuted: boolean | undefined, target: TargetId | undefined): boolean {
  return target === "mcp" && mcpRunMuted === true;
}

/** Reject argv shapes core.run would refuse with a SYNCHRONOUS spawn throw: a non-string element or an
 *  embedded NUL byte. Returns the reason, or undefined when spawn-safe. Validating at the gate lets a
 *  caller-input error surface as an accurate `bad-args` refusal instead of being mislabeled hash-mismatch by
 *  the TOCTOU mapping in run(). */
export function validateArgvShape(argv: readonly unknown[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== "string") return `argv[${i}] is not a string`;
    if (a.includes("\0")) return `argv[${i}] contains a NUL byte`;
  }
  return undefined;
}

/** Build the audit ExecLogLine for a pre-spawn REFUSAL (exit null), in the SAME shape core.run writes for a
 *  real run, so getActivity + the SSE stream treat a refusal identically to a spawn (never-silent). The caller
 *  owns the IO: the daemon appends via auditExec (fail-closed), the MCP path appends fail-soft. Only the SHAPE
 *  is shared here — including the EXEC_ENV_ALLOWLIST snapshot, so a refusal records the same env contract a
 *  real run would have used. */
export function refusalLine(
  slug: string,
  cwd: string,
  reason: string,
  contentHash: string,
  target?: TargetId,
): ExecLogLine {
  return {
    ts: new Date().toISOString(),
    slug,
    ...(target ? { target } : {}),
    argv: [],
    cwd,
    envAllowlist: [...EXEC_ENV_ALLOWLIST],
    exit: null,
    durationMs: 0,
    stdoutTail: "",
    stderrTail: reason,
    contentHash,
  };
}

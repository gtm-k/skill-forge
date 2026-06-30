// @skillforge/core/exec/run — the ONE spawn path (PLAN §7.3, D2/D20). See ./index.ts for the
// module-level rationale. This file holds the gate itself.
//
// ORDER MATTERS and is part of the guarantee: (1) recompute the contentHash from the ACTUAL
// on-disk bytes and refuse on any mismatch / missing file / path escape, (2) resolve the cwd
// under the root, (3) honour dry-run, (4) build the env as a strict allowlist, (5) spawn,
// stream, bound the tails, and audit on close. A refusal NEVER spawns and STILL records.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExecRequest, ExecResult, ExecLogLine } from "@skillforge/contracts";
// Reuse the @skillforge/core primitives (hashing + path containment) rather than reimplement
// them (house rule). Imported via relative paths (not the package barrel) to avoid a
// barrel<->module import cycle once exec is wired into the barrel — matching capability.ts.
import { resolveUnderRoot } from "../safe/index.ts";
import { sha256, bundleContentHash } from "../hash.ts";
import type { ExecSkill, ExecSink, RunOptions } from "./index.ts";

// Bounded tail of EACH stream: keep only the most recent ~4KB so a chatty script cannot blow
// memory or the audit-log size. The live sink still sees every chunk; only the retained tail is
// capped. Measured in UTF-16 code units (≈ bytes for typical ASCII script output).
const MAX_TAIL = 4096;

/** Append `chunk` to a stream tail, keeping only the trailing MAX_TAIL characters. */
function appendTail(prev: string, chunk: string): string {
  const next = prev + chunk;
  return next.length > MAX_TAIL ? next.slice(next.length - MAX_TAIL) : next;
}

/**
 * Reject argv shapes that make Node's spawn() throw SYNCHRONOUSLY — before any 'error'/'close'
 * handler can attach: a non-array/empty argv, a non-string element, a NUL byte, or an empty
 * executable. Returns a refusal reason, or undefined when argv is spawn-safe. Defensive at runtime
 * because the `string[]` contract is TS-only — a malformed argv must REFUSE (and audit), never throw.
 */
function validateArgv(argv: unknown): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0) return "empty argv — nothing to spawn";
  for (let i = 0; i < argv.length; i++) {
    const a: unknown = argv[i];
    if (typeof a !== "string") return `argv[${i}] is not a string`;
    if (a.includes("\0")) return `argv[${i}] contains a NUL byte`;
  }
  if (argv[0] === "") return "empty executable (argv[0])";
  return undefined;
}

/**
 * Emit one audit record. ALWAYS to the in-memory sink (the Activity observer cannot fail
 * silently), AND — when a logPath is given — durably appended as a single JSON line to the
 * exec.log.jsonl (its directory created if missing, the file created on first append). A
 * failure to write the durable line propagates rather than being swallowed (never silent).
 */
function emit(line: ExecLogLine, sink: ExecSink, opts?: RunOptions): void {
  sink.onRecord?.(line);
  if (opts?.logPath) {
    fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
    fs.appendFileSync(opts.logPath, JSON.stringify(line) + "\n", "utf8");
  }
}

/**
 * Build + emit a refusal record and return its ExecResult: exit null, no child output, the
 * `reason` as the stderrTail, and whatever contentHash we were able to recompute (the empty
 * string when the bytes could not be read at all). This is the shape every pre-spawn rejection
 * shares so a refusal is auditable in exactly the same way a real run is.
 */
function refuse(
  skill: ExecSkill,
  req: ExecRequest,
  reason: string,
  contentHash: string,
  startedAt: number,
  sink: ExecSink,
  opts?: RunOptions,
): ExecResult {
  const durationMs = Date.now() - startedAt;
  const line: ExecLogLine = {
    ts: new Date().toISOString(),
    slug: skill.slug,
    argv: req.argv,
    cwd: req.cwd,
    envAllowlist: req.envAllowlist ?? [],
    exit: null,
    durationMs,
    stdoutTail: "",
    stderrTail: reason,
    contentHash,
  };
  emit(line, sink, opts);
  return { exit: null, durationMs, stdoutTail: "", stderrTail: reason, contentHash };
}

/**
 * Run a skill's command through the single execution chokepoint. Returns the ExecResult (exit,
 * bounded tails, duration, and the contentHash recomputed from on-disk bytes). Refuses — without
 * spawning — when the on-disk bundle no longer matches the granted contentHash, when a bundle
 * file is missing or escapes the root, when the requested cwd escapes the root, or on dry-run.
 * Every outcome (spawn or refusal) produces exactly one audit line via the sink and (if given)
 * the logPath.
 */
export async function run(
  skill: ExecSkill,
  req: ExecRequest,
  sink: ExecSink,
  opts?: RunOptions,
): Promise<ExecResult> {
  const startedAt = Date.now();

  // ── 1. RECOMPUTE the content hash from the ACTUAL on-disk bytes (D10/D20). The grant is bound
  //    to a contentHash; we refuse unless the bytes under the root still hash to it. A bundle file
  //    that is missing, unreadable, or escapes the root is itself a refusal, not a silent skip.
  let recomputed: string;
  try {
    const pairs = skill.bundle.map((entry) => {
      const abs = resolveUnderRoot(skill.rootDir, entry.relPath);
      const bytes = fs.readFileSync(abs);
      return { relPath: entry.relPath, hash: sha256(bytes) };
    });
    recomputed = bundleContentHash(pairs);
  } catch (e) {
    return refuse(
      skill,
      req,
      `refusing to spawn: cannot recompute the bundle hash from on-disk bytes — ${(e as Error).message}`,
      "",
      startedAt,
      sink,
      opts,
    );
  }
  if (recomputed !== skill.grantedContentHash) {
    return refuse(
      skill,
      req,
      `refusing to spawn: the on-disk bundle no longer matches the granted contentHash ` +
        `(granted ${skill.grantedContentHash}, on-disk ${recomputed}) — you only run what you reviewed`,
      recomputed,
      startedAt,
      sink,
      opts,
    );
  }

  // ── 2. Resolve the requested cwd UNDER the skill root; a cwd that escapes the root is a refusal.
  let cwd: string;
  try {
    cwd = resolveUnderRoot(skill.rootDir, req.cwd);
  } catch (e) {
    return refuse(
      skill,
      req,
      `refusing to spawn: the requested cwd escapes the skill root — ${(e as Error).message}`,
      recomputed,
      startedAt,
      sink,
      opts,
    );
  }

  // ── 3. dry-run: hash matched, but the caller asked us NOT to spawn. Record the intent + return. This is
  //    the ONLY path that sets ExecResult.dryRun — a STRUCTURED signal consumers read instead of sniffing
  //    stderr. Every spawned path and every refusal below leaves it absent (a real run is never a dry-run,
  //    even if a signal-killed child happens to print "dry-run" to stderr).
  if (req.dryRun) {
    const durationMs = Date.now() - startedAt;
    const stderrTail = "dry-run: bundle hash matched, not spawning";
    const line: ExecLogLine = {
      ts: new Date().toISOString(),
      slug: skill.slug,
      argv: req.argv,
      cwd: req.cwd,
      envAllowlist: req.envAllowlist ?? [],
      exit: null,
      durationMs,
      stdoutTail: "",
      stderrTail,
      contentHash: recomputed,
    };
    emit(line, sink, opts);
    return { exit: null, durationMs, stdoutTail: "", stderrTail, contentHash: recomputed, dryRun: true };
  }

  // ── argv guard: there must be a VALID command to spawn. Node's spawn() throws SYNCHRONOUSLY for a
  //    malformed argv (empty exe, NUL byte, non-string element) — which would reject run() with NO
  //    audit line. Validate FIRST and route every malformed case through the audited refusal path.
  const argvError = validateArgv(req.argv);
  if (argvError) {
    return refuse(skill, req, `refusing to spawn: ${argvError}`, recomputed, startedAt, sink, opts);
  }
  const exe = req.argv[0] as string; // validateArgv guarantees a non-empty string here

  // ── 4. Build the child env as a strict ALLOWLIST: start from {} and copy ONLY the named keys
  //    that are actually present in process.env. Nothing else leaks into the child. (argv[0] is
  //    passed as an absolute path by callers, so the child needs no inherited PATH.)
  const envAllowlist = req.envAllowlist ?? [];
  const env: Record<string, string> = {};
  for (const key of envAllowlist) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }

  // ── 5. spawn under the resolved cwd; stream + bound each stream's tail; audit exactly once
  //    on close (or on a spawn error, which is folded into the stderr tail — never silent).
  return await new Promise<ExecResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, req.argv.slice(1), { cwd, env });
    } catch (e) {
      // Belt-and-suspenders: validateArgv catches the known sync-throw shapes, but if spawn() still
      // throws synchronously, STILL audit a refusal — never reject run() with no ExecLogLine.
      resolve(refuse(skill, req, `refusing to spawn: ${(e as Error).message}`, recomputed, startedAt, sink, opts));
      return;
    }
    let stdoutTail = "";
    let stderrTail = "";
    let settled = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      sink.onStdout?.(chunk);
      stdoutTail = appendTail(stdoutTail, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      sink.onStderr?.(chunk);
      stderrTail = appendTail(stderrTail, chunk);
    });

    const finish = (exit: number | null) => {
      if (settled) return; // 'error' then 'close' (or vice versa) must yield exactly one record
      settled = true;
      const durationMs = Date.now() - startedAt;
      const result: ExecResult = { exit, durationMs, stdoutTail, stderrTail, contentHash: recomputed };
      const line: ExecLogLine = {
        ts: new Date().toISOString(),
        slug: skill.slug,
        argv: req.argv,
        cwd: req.cwd,
        envAllowlist,
        exit,
        durationMs,
        stdoutTail,
        stderrTail,
        contentHash: recomputed,
      };
      try {
        emit(line, sink, opts);
      } catch (e) {
        reject(e); // an audit-write failure must surface, not be swallowed under a returned result
        return;
      }
      resolve(result);
    };

    child.on("error", (err: Error) => {
      // The process could not be spawned (e.g. ENOENT on argv[0]). Fold the reason into the
      // stderr tail so the failure is observable, then settle with a null exit.
      stderrTail = appendTail(stderrTail, `spawn error: ${err.message}`);
      finish(null);
    });
    child.on("close", (code: number | null) => finish(code));
  });
}

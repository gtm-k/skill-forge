// @skillforge/core/exec — the ONE execution chokepoint (PLAN §7.3, D2/D20). This module
// (and ONLY this module) is allowed to import node:child_process. Every untrusted skill
// script that ever runs runs through run() in ./run.ts — nowhere else.
//
// The design is "full execution, trusted-local, but NEVER silent": we do not sandbox the
// child, but we REFUSE to spawn unless the on-disk bytes still hash to the contentHash the
// operator reviewed and granted (D10/D20 — "you only run what you reviewed"), we keep the
// child under the skill root, we stream its output to a sink for the Activity view, and we
// append one audit line per attempt (spawn OR refusal) to exec.log.jsonl.
//
// HUMBLE framing: nothing here asserts a script is "safe"/"trusted"/"verified". The hash
// check only proves the bytes are the SAME ones reviewed — not that they are benign. The
// audit line is what makes an execution observable after the fact; the sink is what makes it
// observable as it happens.
import type { BundleEntry, ExecLogLine } from "@skillforge/contracts";

export { run } from "./run.ts";
// Wave C (D3): the shared pre-spawn gate helpers (env allowlist, interpreter resolver, argv-shape check,
// refusal-line shape) consumed identically by the daemon run route + the standalone MCP catalog path.
export * from "./gate.ts";

/**
 * The minimal skill shape run() needs. `bundle` lists the files whose on-disk bytes are
 * re-hashed and canonicalized into a contentHash that MUST equal `grantedContentHash` before
 * any spawn. `rootDir` is the containment boundary every path (bundle files + cwd) must stay
 * within.
 */
export interface ExecSkill {
  slug: string;
  rootDir: string;
  bundle: BundleEntry[];
  /** the contentHash the operator reviewed + granted exec for; the on-disk recompute must match it (D10) */
  grantedContentHash: string;
}

/**
 * Streaming + audit observers. `onStdout`/`onStderr` receive raw chunks as the child emits
 * them (the live Activity feed); `onRecord` receives the single audit line built on close OR
 * on refusal — so a refused spawn is just as observable as a real one (never silent).
 */
export interface ExecSink {
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
  onRecord?(line: ExecLogLine): void;
}

/**
 * Where to durably append the JSONL audit line. If omitted, the file append is skipped but
 * sink.onRecord is STILL called — the in-memory observer never loses the record.
 */
export interface RunOptions {
  logPath?: string;
}

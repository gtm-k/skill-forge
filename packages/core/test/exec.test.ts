// Execution chokepoint gate (PLAN §7.3, D2/D20). Real spawns over a temp skill tree — no
// network, no LM Studio. We import exec directly: the @skillforge/core barrel does not yet
// re-export it (the orchestrator wires that). argv[0] is process.execPath (the absolute node
// binary) with `-e "..."`, so every case is cross-platform and needs no inherited PATH.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, isMcpRunMuted } from "../src/exec/index.ts";
import type { ExecSkill, ExecSink } from "../src/exec/index.ts";
import type { BundleEntry, ExecRequest, ExecLogLine } from "@skillforge/contracts";
import { classifyBundleEntry, bundleContentHash } from "@skillforge/core";

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "skf-exec-"));
  tmpDirs.push(d);
  return d;
}

/** Build a skill dir with the given files, returning an ExecSkill whose grantedContentHash is
 *  the REAL bundleContentHash of the bytes just written. */
function makeSkill(files: Record<string, string>): ExecSkill {
  const dir = freshDir();
  const bundle: BundleEntry[] = [];
  const pairs: { relPath: string; hash: string }[] = [];
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    const entry = classifyBundleEntry(relPath, content);
    bundle.push(entry);
    pairs.push({ relPath, hash: entry.hash });
  }
  return { slug: "demo", rootDir: dir, bundle, grantedContentHash: bundleContentHash(pairs) };
}

function makeSink() {
  const records: ExecLogLine[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink: ExecSink = {
    onStdout: (c) => stdout.push(c),
    onStderr: (c) => stderr.push(c),
    onRecord: (l) => records.push(l),
  };
  return { sink, records, stdout, stderr };
}

function readLog(logPath: string): ExecLogLine[] {
  const raw = fs.readFileSync(logPath, "utf8").trim();
  if (raw === "") return [];
  return raw.split("\n").map((l) => JSON.parse(l) as ExecLogLine);
}

// ── 0. isMcpRunMuted: the SHARED owner-mute predicate (C4 / D3) — one source of truth both run paths use ──
test("isMcpRunMuted: fires ONLY for target 'mcp' AND mcpRunMuted===true (fail-closed; absent ⇒ not-muted)", () => {
  assert.equal(isMcpRunMuted(true, "mcp"), true, "muted + mcp target ⇒ refuse");
  assert.equal(isMcpRunMuted(true, "lmstudio"), false, "mute does NOT affect the lmstudio inject target");
  assert.equal(isMcpRunMuted(true, "proxy"), false, "mute does NOT affect the proxy inject target");
  assert.equal(isMcpRunMuted(true, undefined), false, "no target ⇒ not an mcp run");
  assert.equal(isMcpRunMuted(false, "mcp"), false, "not muted ⇒ runs");
  assert.equal(isMcpRunMuted(undefined, "mcp"), false, "absent (pre-field manifest) ⇒ not muted (backward-compat)");
});

// ── 1. matching hash → spawns, captures stdout, writes one parseable audit line ──────────────
test("run: matching hash spawns, captures stdout, and writes one audit line", async () => {
  const skill = makeSkill({ "script.js": "// noop skill body\n" });
  const logPath = path.join(skill.rootDir, "exec.log.jsonl");
  const { sink, records, stdout } = makeSink();
  const req: ExecRequest = {
    argv: [process.execPath, "-e", "process.stdout.write('hi')"],
    cwd: ".",
  };

  const res = await run(skill, req, sink, { logPath });

  assert.equal(res.exit, 0);
  assert.match(res.stdoutTail, /hi/);
  assert.equal(res.stderrTail, "");
  assert.equal(res.contentHash, skill.grantedContentHash);
  assert.notEqual(res.dryRun, true, "a real spawn never carries the structured dry-run flag");
  // streamed live to the sink as well as captured in the tail
  assert.ok(stdout.join("").includes("hi"), "stdout chunk must reach the sink");

  const lines = readLog(logPath);
  assert.equal(lines.length, 1, "exactly one audit line");
  const [logged] = lines;
  assert.ok(logged);
  assert.equal(logged.slug, "demo");
  assert.equal(logged.exit, 0);
  assert.equal(logged.contentHash, skill.grantedContentHash);
  assert.deepEqual(logged.argv, req.argv);

  assert.equal(records.length, 1);
  const [rec] = records;
  assert.ok(rec);
  assert.equal(rec.exit, 0);
});

// ── 2a. tampered on-disk bytes → REFUSE (you only run what you reviewed) ──────────────────────
test("run: REFUSES when on-disk bytes no longer match the granted hash", async () => {
  const skill = makeSkill({ "script.js": "// original body\n" });
  // Tamper the bundled file AFTER the grant was computed.
  fs.writeFileSync(path.join(skill.rootDir, "script.js"), "// TAMPERED body — should not run\n");
  const logPath = path.join(skill.rootDir, "exec.log.jsonl");
  const { sink, records, stdout } = makeSink();
  const req: ExecRequest = {
    argv: [process.execPath, "-e", "process.stdout.write('SHOULD-NOT-RUN')"],
    cwd: ".",
  };

  const res = await run(skill, req, sink, { logPath });

  assert.equal(res.exit, null, "refusal exits null");
  assert.equal(res.stdoutTail, "", "no child output on refusal");
  assert.equal(stdout.length, 0, "nothing streamed — the child never spawned");
  assert.notEqual(res.dryRun, true, "a refusal is NOT a dry-run (the structured flag is set only on the dry-run branch)");
  assert.match(res.stderrTail, /granted contentHash|you only run what you reviewed/i);
  assert.notEqual(res.contentHash, skill.grantedContentHash, "recomputed hash differs from the grant");

  const lines = readLog(logPath);
  assert.equal(lines.length, 1, "the refusal is still audited");
  const [logged] = lines;
  assert.ok(logged);
  assert.equal(logged.exit, null);
  assert.equal(records.length, 1);
});

// ── 2b. wrong granted hash (bytes untouched) → REFUSE ─────────────────────────────────────────
test("run: REFUSES when handed a grantedContentHash that does not match the bundle", async () => {
  const skill = makeSkill({ "script.js": "// untouched body\n" });
  const realGrant = skill.grantedContentHash;
  const tampered: ExecSkill = { ...skill, grantedContentHash: "0".repeat(64) };
  const logPath = path.join(skill.rootDir, "exec.log.jsonl");
  const { sink, stdout } = makeSink();
  const req: ExecRequest = {
    argv: [process.execPath, "-e", "process.stdout.write('SHOULD-NOT-RUN')"],
    cwd: ".",
  };

  const res = await run(tampered, req, sink, { logPath });

  assert.equal(res.exit, null);
  assert.equal(stdout.length, 0);
  assert.match(res.stderrTail, /granted contentHash|review/i);
  // the recomputed hash equals the REAL bundle hash (bytes were untouched), not the bogus grant
  assert.equal(res.contentHash, realGrant);
});

// ── 2c. missing bundle file → REFUSE (recompute cannot read the bytes) ────────────────────────
test("run: REFUSES when a bundle file is missing on disk", async () => {
  const skill = makeSkill({ "script.js": "// body\n" });
  fs.rmSync(path.join(skill.rootDir, "script.js"));
  const logPath = path.join(skill.rootDir, "exec.log.jsonl");
  const { sink, stdout } = makeSink();
  const req: ExecRequest = {
    argv: [process.execPath, "-e", "process.stdout.write('SHOULD-NOT-RUN')"],
    cwd: ".",
  };

  const res = await run(skill, req, sink, { logPath });

  assert.equal(res.exit, null);
  assert.equal(stdout.length, 0);
  assert.match(res.stderrTail, /cannot recompute/i);
  assert.equal(res.contentHash, "", "no hash could be recomputed from absent bytes");
  assert.equal(readLog(logPath).length, 1);
});

// ── 3. dry-run → never spawns, logs a dry-run line ───────────────────────────────────────────
test("run: dryRun never spawns and logs a dry-run line", async () => {
  const skill = makeSkill({ "script.js": "// noop\n" });
  const logPath = path.join(skill.rootDir, "exec.log.jsonl");
  const { sink, records, stdout } = makeSink();
  const req: ExecRequest = {
    argv: [process.execPath, "-e", "process.stdout.write('SHOULD-NOT-RUN')"],
    cwd: ".",
    dryRun: true,
  };

  const res = await run(skill, req, sink, { logPath });

  assert.equal(res.exit, null);
  assert.equal(res.stdoutTail, "");
  assert.equal(stdout.length, 0, "no child spawned on dry-run");
  assert.match(res.stderrTail, /dry-run/i);
  assert.equal(res.dryRun, true, "the genuine dry-run carries the STRUCTURED flag (consumers read this, not stderr)");
  assert.equal(res.contentHash, skill.grantedContentHash, "hash matched; we just did not spawn");

  const lines = readLog(logPath);
  assert.equal(lines.length, 1);
  const [logged] = lines;
  assert.ok(logged);
  assert.equal(logged.exit, null);
  assert.match(logged.stderrTail, /dry-run/i);
  assert.equal(records.length, 1);
});

// ── 4. env allowlist filters process.env down to the named keys only ─────────────────────────
test("run: env allowlist passes named keys and blocks everything else", async () => {
  const skill = makeSkill({ "script.js": "// noop\n" });
  const argvFoo: string[] = [process.execPath, "-e", "process.stdout.write(process.env.FOO||'none')"];
  const argvSecret: string[] = [process.execPath, "-e", "process.stdout.write(process.env.SECRET||'none')"];

  process.env.FOO = "bar-value";
  process.env.SECRET = "leak";
  try {
    // FOO is allowlisted and present → its value reaches the child.
    const allowed = await run(skill, { argv: argvFoo, cwd: ".", envAllowlist: ["FOO"] }, makeSink().sink);
    assert.equal(allowed.exit, 0);
    assert.equal(allowed.stdoutTail, "bar-value");

    // Empty allowlist → FOO is filtered out, child sees nothing → prints the "none" fallback.
    const blocked = await run(skill, { argv: argvFoo, cwd: ".", envAllowlist: [] }, makeSink().sink);
    assert.equal(blocked.exit, 0);
    assert.equal(blocked.stdoutTail, "none", "an empty allowlist must filter FOO out");

    // A set-but-NOT-allowlisted key (SECRET) never leaks even when other keys are allowed.
    const noLeak = await run(skill, { argv: argvSecret, cwd: ".", envAllowlist: ["FOO"] }, makeSink().sink);
    assert.equal(noLeak.exit, 0);
    assert.equal(noLeak.stdoutTail, "none", "a non-allowlisted env var must not leak into the child");
  } finally {
    delete process.env.FOO;
    delete process.env.SECRET;
  }
});

// ── 5. req.cwd escaping the skill root → REFUSE with a logged reason ──────────────────────────
test("run: REFUSES when req.cwd escapes the skill root", async () => {
  const skill = makeSkill({ "script.js": "// noop\n" });
  const logPath = path.join(skill.rootDir, "exec.log.jsonl");
  const { sink, records, stdout } = makeSink();
  const req: ExecRequest = {
    argv: [process.execPath, "-e", "process.stdout.write('SHOULD-NOT-RUN')"],
    cwd: path.join("..", "..", ".."), // climbs above the skill root
  };

  const res = await run(skill, req, sink, { logPath });

  assert.equal(res.exit, null);
  assert.equal(res.stdoutTail, "");
  assert.equal(stdout.length, 0, "nothing streamed — refused before spawn");
  assert.match(res.stderrTail, /cwd escapes the skill root/i);
  // the bundle hash matched (only the cwd was bad), so the recomputed hash is the granted one
  assert.equal(res.contentHash, skill.grantedContentHash);

  const lines = readLog(logPath);
  assert.equal(lines.length, 1);
  const [logged] = lines;
  assert.ok(logged);
  assert.equal(logged.exit, null);
  assert.equal(records.length, 1);
});

// ── 6. malformed argv that would make spawn() throw SYNCHRONOUSLY → REFUSE + audit (never silent) ──
test("run: an empty executable argv[0] is an AUDITED refusal, not a silent throw", async () => {
  const skill = makeSkill({ "script.js": "// noop\n" });
  const logPath = path.join(skill.rootDir, "exec.log.jsonl");
  const { sink, records, stdout } = makeSink();
  // grant matches, so we reach the argv guard; "" as argv[0] makes Node's spawn() throw synchronously.
  const res = await run(skill, { argv: ["", "-e", "x"], cwd: "." }, sink, { logPath });

  assert.equal(res.exit, null, "malformed argv refuses with a null exit");
  assert.equal(stdout.length, 0, "nothing streamed — never spawned");
  assert.match(res.stderrTail, /empty executable|refusing to spawn/i);
  const lines = readLog(logPath);
  assert.equal(lines.length, 1, "the malformed-argv refusal is STILL audited (never silent)");
  assert.equal(lines[0]?.exit, null);
  assert.equal(records.length, 1);
});

test("run: a NUL byte in an arg is an AUDITED refusal, not a silent throw", async () => {
  const skill = makeSkill({ "script.js": "// noop\n" });
  const logPath = path.join(skill.rootDir, "exec.log.jsonl");
  const { sink, records, stdout } = makeSink();
  const res = await run(
    skill,
    { argv: [process.execPath, "-e", "process.stdout.write('x')" + String.fromCharCode(0) + "evil"], cwd: "." },
    sink,
    { logPath },
  );

  assert.equal(res.exit, null);
  assert.equal(stdout.length, 0);
  assert.match(res.stderrTail, /NUL byte|refusing to spawn/i);
  assert.equal(readLog(logPath).length, 1, "audited");
  assert.equal(records.length, 1);
});

// ── 7. spawn 'error' (ENOENT on a non-existent executable) is folded into the tail + audited ──
test("run: a spawn error (non-existent executable) settles with null exit and one audit line", async () => {
  const skill = makeSkill({ "script.js": "// noop\n" });
  const logPath = path.join(skill.rootDir, "exec.log.jsonl");
  const { sink, records } = makeSink();
  // a valid (non-empty, NUL-free) string that does not exist on disk → spawn emits an 'error' event.
  const ghost = path.join(skill.rootDir, "no-such-binary-xyz");
  const res = await run(skill, { argv: [ghost], cwd: "." }, sink, { logPath });

  assert.equal(res.exit, null, "spawn error settles with a null exit");
  assert.match(res.stderrTail, /spawn error/i, "the failure reason is observable in the tail");
  assert.equal(readLog(logPath).length, 1, "exactly one audit line");
  assert.equal(records.length, 1);
});

// ── observability: with NO logPath, the sink still receives the record (file append skipped) ──
test("run: omitting logPath still delivers the audit record to the sink", async () => {
  const skill = makeSkill({ "script.js": "// noop\n" });
  const { sink, records } = makeSink();
  const req: ExecRequest = { argv: [process.execPath, "-e", "process.stdout.write('ok')"], cwd: "." };

  const res = await run(skill, req, sink); // no opts

  assert.equal(res.exit, 0);
  assert.equal(records.length, 1, "sink.onRecord fires even without a logPath");
  const [rec] = records;
  assert.ok(rec);
  assert.equal(rec.exit, 0);
});

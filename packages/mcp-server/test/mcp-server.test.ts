// @skillforge/mcp-server/test — host-acceptance: a scripted MCP client against a FIXTURE home.
//
// HERMETIC: each test builds a throwaway temp home (manifest.json + a sources/ tree) and cleans up in
// `after`. NO network, NO bound port, NO daemon. The fixture's contentHash is computed with core's OWN
// classifyBundleEntry + bundleContentHash from the on-disk bytes (NOT hand-faked) so the exec-grant hash
// matches what run_skill_script recomputes on disk. Execution uses a trivial node script (process.execPath
// resolves the "node" interpreter cross-platform, no PATH dependency).
//
// The 6 Phase-4 proof-of-done checks: (1) initialize, (2) tools/list = 3 tools, (3) list_skills returns the
// enabled-for-mcp catalog, (4) load_skill returns full instructions, (5) run_skill_script executes via
// core.run AND writes an exec.log.jsonl line, (6) a refusal path returns a NAMED MCP error (not silent).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { classifyBundleEntry, bundleContentHash } from "@skillforge/core";
import type { BundleEntry } from "@skillforge/contracts";
import { createMcpServer } from "../src/server.ts";
import { createReadModelDeps } from "../src/catalog.ts";
import { runStdioServer } from "../src/stdio.ts";
import { createMcpHttpHandler } from "../src/http.ts";
import { parseMessage, type JsonRpcRequest, type JsonRpcResponse, type JsonRpcSuccess } from "../src/protocol.ts";

const made: string[] = [];
function mkTmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "skf-mcp-home-"));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const SOURCE_ID = "src1";

/** Recursively list POSIX relPaths of every regular file under `root` (mirrors deriveBundle's walk). */
function walkRel(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
    if (d.isDirectory()) out.push(...walkRel(root, childRel));
    else if (d.isFile()) out.push(childRel);
  }
  return out;
}

/** Compute the canonical bundle + contentHash for an on-disk skill dir using core primitives. */
function bundleFor(skillDir: string): { bundle: BundleEntry[]; contentHash: string } {
  const bundle = walkRel(skillDir)
    .map((relPath) => classifyBundleEntry(relPath, fs.readFileSync(path.join(skillDir, relPath))))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const contentHash = bundleContentHash(bundle.map((b) => ({ relPath: b.relPath, hash: b.hash })));
  return { bundle, contentHash };
}

interface BuiltHome {
  home: string;
  echoerHash: string;
  echoerScriptAbs: string;
}

/**
 * Build a fixture home with two mcp-enabled skills:
 *  - "echoer": SKILL.md + scripts/echo.js (runnable) + refs/guide.md (a reference resource); exec GRANTED.
 *  - "greeter": SKILL.md only; exec NOT granted (drives the no-grant refusal path).
 */
function buildHome(opts: { muteEchoer?: boolean } = {}): BuiltHome {
  const home = mkTmpHome();

  // ── echoer ──
  const echoerDir = path.join(home, "sources", SOURCE_ID, "echoer");
  fs.mkdirSync(path.join(echoerDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(echoerDir, "refs"), { recursive: true });
  fs.writeFileSync(
    path.join(echoerDir, "SKILL.md"),
    "---\nname: Echoer\ndescription: Echo a marker line to stdout for smoke-testing skill execution.\n---\n" +
      "Run scripts/echo.js to print a marker. Use this skill to verify the exec chokepoint end to end.\n",
  );
  fs.writeFileSync(
    path.join(echoerDir, "scripts", "echo.js"),
    'console.log("hello from the skill script", process.argv.slice(2).join(" "));\n',
  );
  fs.writeFileSync(path.join(echoerDir, "refs", "guide.md"), "# Echoer guide\n\nThis reference explains the echoer skill.\n");
  const echoer = bundleFor(echoerDir);

  // ── greeter (no script, no grant) ──
  const greeterDir = path.join(home, "sources", SOURCE_ID, "greeter");
  fs.mkdirSync(greeterDir, { recursive: true });
  fs.writeFileSync(
    path.join(greeterDir, "SKILL.md"),
    "---\nname: Greeter\ndescription: Compose a short friendly greeting for a person by name.\n---\n" +
      "Greet the person warmly in one sentence and offer to help.\n",
  );
  const greeter = bundleFor(greeterDir);

  const skills = [
    {
      id: "id-echoer",
      slug: "echoer",
      name: "Echoer",
      description: "Echo a marker line to stdout for smoke-testing skill execution.",
      dir: `${SOURCE_ID}/echoer`,
      contentHash: echoer.contentHash,
      enabledFor: { lmstudio: true, mcp: true, proxy: true },
      execAllowed: true, // GRANTED, bound to the on-disk contentHash above
      capabilities: { scriptCount: 1, interpreters: ["node"], commands: [], flags: [] },
      bundle: echoer.bundle,
      warnings: [],
      bodyLen: 120,
      tokenEstimate: 30,
      provenance: [{ sourceId: SOURCE_ID, kind: "folder", input: "/tmp/src" }],
      // C4: an OWNER MCP run-mute on echoer when the test asks for it (parallels a daemon-published manifest).
      ...(opts.muteEchoer ? { mcpRunMuted: true } : {}),
    },
    {
      id: "id-greeter",
      slug: "greeter",
      name: "Greeter",
      description: "Compose a short friendly greeting for a person by name.",
      dir: `${SOURCE_ID}/greeter`,
      contentHash: greeter.contentHash,
      enabledFor: { lmstudio: true, mcp: true, proxy: true },
      execAllowed: false, // NOT granted
      capabilities: { scriptCount: 0, interpreters: [], commands: [], flags: [] },
      bundle: greeter.bundle,
      warnings: [],
      bodyLen: 80,
      tokenEstimate: 20,
      provenance: [{ sourceId: SOURCE_ID, kind: "folder", input: "/tmp/src" }],
    },
  ];
  const model = {
    schemaVersion: 1,
    seq: 1,
    generatedAt: new Date().toISOString(),
    sourcesDir: "sources",
    skills,
  };
  fs.writeFileSync(path.join(home, "manifest.json"), `${JSON.stringify(model, null, 2)}\n`);
  return { home, echoerHash: echoer.contentHash, echoerScriptAbs: path.join(echoerDir, "scripts", "echo.js") };
}

/**
 * Build a home with ONE exec-GRANTED skill "writer" whose script writes a sentinel file (a visible proof
 * of a REAL spawn). Drives the §7 trust-pin tests: an optional config.json trustLevels and a settable
 * provenance (an EMPTY provenance ⇒ an unresolvable sourceId ⇒ the fail-closed path).
 */
function buildWriterHome(opts: { trustLevels?: Record<string, string>; provenance?: unknown[] } = {}): {
  home: string;
  sentinelPath: string;
} {
  const home = mkTmpHome();
  const dir = path.join(home, "sources", SOURCE_ID, "writer");
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    "---\nname: Writer\ndescription: Write a sentinel file to prove a real spawn occurred.\n---\nRun scripts/write.js.\n",
  );
  fs.writeFileSync(
    path.join(dir, "scripts", "write.js"),
    "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], 'ran'); console.log('did run');\n",
  );
  const b = bundleFor(dir);
  const skills = [
    {
      id: "id-writer",
      slug: "writer",
      name: "Writer",
      description: "Write a sentinel file to prove a real spawn occurred.",
      dir: `${SOURCE_ID}/writer`,
      contentHash: b.contentHash,
      enabledFor: { lmstudio: true, mcp: true, proxy: true },
      execAllowed: true,
      capabilities: { scriptCount: 1, interpreters: ["node"], commands: [], flags: [] },
      bundle: b.bundle,
      warnings: [],
      bodyLen: 50,
      tokenEstimate: 10,
      provenance: opts.provenance ?? [{ sourceId: SOURCE_ID, kind: "folder", input: "/tmp/src" }],
    },
  ];
  const model = { schemaVersion: 1, seq: 1, generatedAt: new Date().toISOString(), sourcesDir: "sources", skills };
  fs.writeFileSync(path.join(home, "manifest.json"), `${JSON.stringify(model, null, 2)}\n`);
  if (opts.trustLevels) {
    const cfg = { schemaVersion: 1, port: 4319, lmStudioBaseUrl: "http://127.0.0.1:1234", trustLevels: opts.trustLevels };
    fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  }
  return { home, sentinelPath: path.join(home, "SENTINEL.txt") };
}

let nextId = 1;
function req(method: string, params?: unknown): JsonRpcRequest {
  const r: JsonRpcRequest = { jsonrpc: "2.0", id: nextId++, method };
  if (params !== undefined) r.params = params;
  return r;
}

/** Call the in-process server and assert a SUCCESS response, returning its result. */
async function call(server: ReturnType<typeof createMcpServer>, method: string, params?: unknown): Promise<any> {
  const res = (await server.handle(req(method, params))) as JsonRpcResponse | null;
  assert.ok(res, `${method} returned null (unexpected notification)`);
  assert.ok(!("error" in res!), `${method} unexpectedly errored: ${JSON.stringify((res as any).error)}`);
  return (res as JsonRpcSuccess).result;
}

function srv(home: string): ReturnType<typeof createMcpServer> {
  return createMcpServer(createReadModelDeps(home, "test-1"));
}

// ── (1) initialize handshake ──────────────────────────────────────────────────────────────────────
test("(1) initialize handshake succeeds and advertises tools + resources", async () => {
  const { home } = buildHome();
  const server = srv(home);
  const result = await call(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(result.protocolVersion, "2025-06-18"); // echoed back (we support it)
  assert.equal(result.serverInfo.name, "skillforge-mcp");
  assert.equal(result.serverInfo.version, "test-1");
  assert.ok(result.capabilities.tools, "tools capability advertised");
  assert.ok(result.capabilities.resources, "resources capability advertised");

  // an unsupported version falls back to our default, not an error
  const r2 = await call(server, "initialize", { protocolVersion: "1999-01-01" });
  assert.equal(r2.protocolVersion, "2025-06-18");

  // the initialized notification (no id) gets NO reply
  const notif = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notif, null);
});

// ── (2) tools/list returns the 3 tools ──────────────────────────────────────────────────────────────
test("(2) tools/list returns the three SkillForge tools with input schemas", async () => {
  const { home } = buildHome();
  const result = await call(srv(home), "tools/list");
  const names = (result.tools as { name: string; inputSchema: unknown }[]).map((t) => t.name).sort();
  assert.deepEqual(names, ["list_skills", "load_skill", "run_skill_script"]);
  for (const t of result.tools) {
    assert.equal((t.inputSchema as { type: string }).type, "object", `${t.name} has an object inputSchema`);
    assert.ok(typeof t.description === "string" && t.description.length > 0);
  }
});

// ── (3) list_skills returns the enabled-for-mcp catalog ──────────────────────────────────────────────
test("(3) list_skills returns the enabled-for-mcp menu (and ranks by query, host still chooses)", async () => {
  const { home } = buildHome();
  const server = srv(home);
  const res = await call(server, "tools/call", { name: "list_skills", arguments: {} });
  assert.notEqual(res.isError, true);
  const text: string = res.content[0].text;
  assert.match(text, /echoer/, "menu lists echoer");
  assert.match(text, /greeter/, "menu lists greeter");

  // a query re-orders the menu (greeter first for a greeting query) without filtering the other out
  const ranked = await call(server, "tools/call", { name: "list_skills", arguments: { query: "friendly greeting for a person" } });
  const rtext: string = ranked.content[0].text;
  assert.match(rtext, /echoer/);
  assert.ok(rtext.indexOf("greeter") < rtext.indexOf("echoer"), "greeter ranks above echoer for a greeting query");
});

// ── (4) load_skill returns full instructions ─────────────────────────────────────────────────────────
test("(4) load_skill returns the full instructions body + a capability/bundle summary", async () => {
  const { home } = buildHome();
  const server = srv(home);
  const res = await call(server, "tools/call", { name: "load_skill", arguments: { idOrSlug: "echoer" } });
  assert.notEqual(res.isError, true);
  const text: string = res.content[0].text;
  assert.match(text, /Run scripts\/echo\.js to print a marker/, "full SKILL.md body is included");
  assert.match(text, /exec granted: yes/, "summary shows the grant state");
  assert.match(text, /scripts\/echo\.js/, "summary lists the runnable script");

  // load_skill by id also works; an unknown id is a NAMED isError (not-found), never a silent empty body
  const byId = await call(server, "tools/call", { name: "load_skill", arguments: { idOrSlug: "id-greeter" } });
  assert.match(byId.content[0].text, /Greet the person warmly/);
  const missing = await call(server, "tools/call", { name: "load_skill", arguments: { idOrSlug: "nope" } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not-found/);
});

// ── (5) run_skill_script executes via core.run AND writes an exec.log.jsonl line ─────────────────────
test("(5) run_skill_script executes a granted script via core.run and appends an exec.log.jsonl line", async () => {
  const { home } = buildHome();
  const server = srv(home);
  const res = await call(server, "tools/call", {
    name: "run_skill_script",
    arguments: { idOrSlug: "echoer", script: "scripts/echo.js", args: ["ARG_OK"] },
  });
  assert.notEqual(res.isError, true, `run unexpectedly errored: ${res.content[0].text}`);
  const text: string = res.content[0].text;
  assert.match(text, /exit: 0/, "the script exited 0");
  assert.match(text, /hello from the skill script ARG_OK/, "stdout tail captured the script output + args");

  // the exec audit line was durably appended (core.run via logPath) — assert the file + a matching line.
  const logPath = path.join(home, "exec.log.jsonl");
  assert.ok(fs.existsSync(logPath), "exec.log.jsonl exists");
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const runLine = lines.find((l) => l.slug === "echoer" && l.exit === 0);
  assert.ok(runLine, "an exec.log line for the echoer run with exit 0 was written");
  assert.equal(runLine.contentHash, bundleFor(path.join(home, "sources", SOURCE_ID, "echoer")).contentHash);
});

// ── (6) refusal paths return a NAMED MCP error (never a silent success) ───────────────────────────────
test("(6a) run_skill_script on an ungranted skill returns a NAMED no-grant error", async () => {
  const { home } = buildHome();
  const server = srv(home);
  // greeter has no script AND no grant — the grant gate fires first (default-deny, D2).
  const res = await call(server, "tools/call", {
    name: "run_skill_script",
    arguments: { idOrSlug: "greeter", script: "scripts/echo.js" },
  });
  assert.equal(res.isError, true, "a refusal MUST be a visible isError result");
  assert.match(res.content[0].text, /no-grant/, "the refusal NAMES the reason");

  // and the refusal was audited (never-silent for the ops actor)
  const logPath = path.join(home, "exec.log.jsonl");
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.slug === "greeter" && l.exit === null && /no-grant|not granted/.test(l.stderrTail)), "no-grant refusal audited");
});

test("(6b) a post-grant on-disk edit makes run_skill_script refuse with a NAMED hash-mismatch", async () => {
  const { home } = buildHome();
  const server = srv(home);
  // tamper the granted script AFTER the manifest pinned its contentHash → on-disk hash now differs.
  fs.writeFileSync(path.join(home, "sources", SOURCE_ID, "echoer", "scripts", "echo.js"), 'console.log("tampered");\n');
  const res = await call(server, "tools/call", {
    name: "run_skill_script",
    arguments: { idOrSlug: "echoer", script: "scripts/echo.js" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /hash-mismatch/, "a content drift is a NAMED hash-mismatch refusal (you only run what you reviewed)");
});

test("(6c) an unknown skill returns a NAMED not-found error", async () => {
  const { home } = buildHome();
  const server = srv(home);
  const res = await call(server, "tools/call", {
    name: "run_skill_script",
    arguments: { idOrSlug: "ghost", script: "scripts/echo.js" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /not-found/);
});

// ── resources: list + read references; containment refuses an escaping uri ───────────────────────────
test("(7) resources/list + resources/read expose skill reference files, with containment", async () => {
  const { home } = buildHome();
  const server = srv(home);
  const list = await call(server, "resources/list");
  const uris = (list.resources as { uri: string }[]).map((r) => r.uri);
  assert.ok(uris.includes("skillforge://echoer/refs/guide.md"), `expected the guide resource, got ${JSON.stringify(uris)}`);

  const read = await call(server, "resources/read", { uri: "skillforge://echoer/refs/guide.md" });
  assert.equal(read.contents[0].uri, "skillforge://echoer/refs/guide.md");
  assert.equal(read.contents[0].mimeType, "text/markdown");
  assert.match(read.contents[0].text, /This reference explains the echoer skill/);

  // a traversal uri is a NAMED protocol error, never bytes from outside the skill tree
  const escaping = (await server.handle(req("resources/read", { uri: "skillforge://echoer/../../../manifest.json" }))) as JsonRpcResponse;
  assert.ok("error" in escaping, "an escaping resource read is a JSON-RPC error");
  assert.match((escaping as any).error.message, /path-escape|failed/);
});

// ── unknown method + tool → protocol errors (visible, not silent) ────────────────────────────────────
test("(8) unknown method is -32601 and an unknown tool name is -32602", async () => {
  const { home } = buildHome();
  const server = srv(home);
  const m = (await server.handle(req("does/not/exist"))) as JsonRpcResponse;
  assert.ok("error" in m && (m as any).error.code === -32601);
  const t = (await server.handle(req("tools/call", { name: "nope", arguments: {} }))) as JsonRpcResponse;
  assert.ok("error" in t && (t as any).error.code === -32602);
});

// ── stdio transport smoke: a real NDJSON round-trip over PassThrough streams ──────────────────────────
test("(9) stdio transport handles a newline-delimited initialize and writes one JSON line to stdout", async () => {
  const { home } = buildHome();
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOut = new PassThrough();
  let out = "";
  output.on("data", (c: Buffer) => (out += c.toString("utf8")));
  let errText = "";
  errorOut.on("data", (c: Buffer) => (errText += c.toString("utf8")));

  const { closed } = runStdioServer(createReadModelDeps(home, "test-1"), { input, output, errorOut });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 42, method: "initialize", params: {} })}\n`);
  // a notification produces NO output line
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.end();
  await closed;

  const outLines = out.trim().split("\n").filter(Boolean);
  assert.equal(outLines.length, 1, "exactly one response line (the notification produced none)");
  const parsed = JSON.parse(outLines[0]!);
  assert.equal(parsed.id, 42);
  assert.equal(parsed.result.serverInfo.name, "skillforge-mcp");
  assert.equal(errText.includes("\n") || errText === "", true); // diagnostics (if any) only on stderr
});

// ── (10) §7 trust gating: a "dry-run" pin FORCES dry-run; pins-present-but-source-unresolvable FAILS CLOSED ──
test("(10a) a source pinned to trust 'dry-run' FORCES dry-run — no spawn, no side effect, visibly marked", async () => {
  const { home, sentinelPath } = buildWriterHome({ trustLevels: { [SOURCE_ID]: "dry-run" } });
  const server = srv(home);
  const res = await call(server, "tools/call", {
    name: "run_skill_script",
    arguments: { idOrSlug: "writer", script: "scripts/write.js", args: [sentinelPath] },
  });
  assert.notEqual(res.isError, true, `dry-run is a (non-error) outcome: ${res.content[0].text}`);
  const text: string = res.content[0].text;
  assert.match(text, /\(dry-run\)/, "the host SEES that the dry-run pin took effect (never silent)");
  assert.match(text, /exit: null/, "no real spawn (exit null)");
  assert.equal(fs.existsSync(sentinelPath), false, "the script did NOT run — the pin suppressed the spawn (no side effect)");
  // the audit line visibly marks dry-run (never-silent for the ops actor)
  const lines = fs.readFileSync(path.join(home, "exec.log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.slug === "writer" && l.exit === null && /dry-run/i.test(l.stderrTail)), "the dry-run was audited");
});

test("(10b) trust pins present but the skill's source is unresolvable ⇒ FAIL-CLOSED to dry-run", async () => {
  // pins exist for some OTHER source; this skill has an EMPTY provenance ⇒ no resolvable sourceId.
  const { home, sentinelPath } = buildWriterHome({ trustLevels: { "some-other-source": "trusted" }, provenance: [] });
  const res = await call(srv(home), "tools/call", {
    name: "run_skill_script",
    arguments: { idOrSlug: "writer", script: "scripts/write.js", args: [sentinelPath] },
  });
  assert.match(res.content[0].text, /\(dry-run\)/, "an un-checkable pin fails closed to dry-run");
  assert.equal(fs.existsSync(sentinelPath), false, "no real spawn past an un-checkable pin");
});

test("(10c) with NO trust pins the SAME granted script runs FOR REAL (control: proves the pin truly suppressed it)", async () => {
  const { home, sentinelPath } = buildWriterHome({});
  const res = await call(srv(home), "tools/call", {
    name: "run_skill_script",
    arguments: { idOrSlug: "writer", script: "scripts/write.js", args: [sentinelPath] },
  });
  assert.match(res.content[0].text, /exit: 0/, "no pin ⇒ a real spawn (exit 0)");
  assert.equal(fs.existsSync(sentinelPath), true, "the real spawn wrote the sentinel — so the dry-run cases truly suppressed it");
});

// ── (11) resources/read is a REFERENCES-ONLY surface (a contained non-reference file is a NAMED refusal) ──
test("(11) resources/read refuses a contained NON-reference file with a NAMED error (references-only)", async () => {
  const { home } = buildHome();
  const server = srv(home);
  // SKILL.md and the script are contained under the skill tree but are NOT references — reading them is refused.
  const r1 = (await server.handle(req("resources/read", { uri: "skillforge://echoer/SKILL.md" }))) as JsonRpcResponse;
  assert.ok("error" in r1, "reading a non-reference is a JSON-RPC error, never a silent read");
  assert.match((r1 as any).error.message, /not-a-reference/);
  const r2 = (await server.handle(req("resources/read", { uri: "skillforge://echoer/scripts/echo.js" }))) as JsonRpcResponse;
  assert.ok("error" in r2);
  assert.match((r2 as any).error.message, /not-a-reference/);
  // the actual reference still reads fine (the allowed surface is unaffected)
  const ok = await call(server, "resources/read", { uri: "skillforge://echoer/refs/guide.md" });
  assert.match(ok.contents[0].text, /This reference explains the echoer skill/);
});

// ── (12) JSON-RPC envelope strictness: wrong/missing jsonrpc + a non-scalar id are INVALID_REQUEST ──
test("(12) parseMessage enforces jsonrpc:'2.0' and a string|number|null id (else -32600; non-JSON is -32700)", () => {
  const codeOf = (o: ReturnType<typeof parseMessage>): number | undefined => ("code" in o ? o.code : undefined);
  assert.equal(codeOf(parseMessage(JSON.stringify({ id: 1, method: "ping" }))), -32600, "missing jsonrpc ⇒ -32600");
  assert.equal(codeOf(parseMessage(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }))), -32600, "wrong jsonrpc ⇒ -32600");
  assert.equal(codeOf(parseMessage(JSON.stringify({ jsonrpc: "2.0", id: { bad: true }, method: "ping" }))), -32600, "object id ⇒ -32600");
  assert.equal(codeOf(parseMessage(JSON.stringify({ jsonrpc: "2.0", id: [1], method: "ping" }))), -32600, "array id ⇒ -32600");
  assert.equal(codeOf(parseMessage("{not json")), -32700, "non-JSON ⇒ -32700");
  const okMsg = parseMessage(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }));
  assert.equal(okMsg.ok, true, "a well-formed request parses");
  const notif = parseMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(notif.ok, true, "an absent id (notification) is valid");
});

// ── (13) HTTP transport: an empty batch is a single -32600; an all-notification batch is 202 ──
test("(13) HTTP empty batch ⇒ one -32600; notification-only batch ⇒ 202; malformed envelope ⇒ visible -32600", async () => {
  const { home } = buildHome();
  const handler = createMcpHttpHandler(createReadModelDeps(home, "test-1"))[0]!.handler;
  const run = (body: unknown) => handler({ body } as any);

  const empty = (await run([])) as any;
  assert.equal(empty.status, 200);
  assert.equal(empty.body.error.code, -32600, "an empty batch array is a single -32600 error (not a 202 no-body)");

  const notifs = (await run([{ jsonrpc: "2.0", method: "notifications/initialized" }])) as any;
  assert.equal(notifs.status, 202, "a batch of only notifications yields no responses ⇒ 202");

  const single = (await run({ jsonrpc: "2.0", id: 5, method: "ping" })) as any;
  assert.equal(single.status, 200);
  assert.equal(single.body.id, 5);

  const bad = (await run({ id: 9, method: "ping" })) as any; // missing jsonrpc
  assert.equal(bad.body.error.code, -32600, "a malformed envelope is a visible -32600, not a silent drop");
});

// ── (14) run_skill_script: a spawn-unsafe argv is a NAMED bad-args refusal (accurate, not hash-mismatch) ──
test("(14) a NUL-byte arg is refused as 'bad-args' (accurate label), never spawned, never mislabeled", async () => {
  const { home } = buildHome();
  const res = await call(srv(home), "tools/call", {
    name: "run_skill_script",
    arguments: { idOrSlug: "echoer", script: "scripts/echo.js", args: ["ok", "ba\u0000d"] },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /bad-args/, "an unsafe argv is named bad-args");
  assert.doesNotMatch(res.content[0].text, /hash-mismatch/, "it is NOT mislabeled hash-mismatch");
});

// ── (16) C4: the forgeable client conversationId scope is GONE from the MCP run tool (non-rotatable) ──────
test("(16) run_skill_script inputSchema has NO conversationId; required is exactly [idOrSlug, script]; deps.runScript arity is 3", async () => {
  const { home } = buildHome();
  const result = await call(srv(home), "tools/list");
  const runTool = (result.tools as { name: string; inputSchema: any }[]).find((t) => t.name === "run_skill_script")!;
  assert.ok(!("conversationId" in (runTool.inputSchema.properties ?? {})), "the forgeable client conversationId scope is GONE from the MCP run schema");
  assert.deepEqual(runTool.inputSchema.required, ["idOrSlug", "script"], "required is exactly idOrSlug + script");
  // the deps seam dropped the conversationId param too: (idOrSlug, script, args).
  const deps = createReadModelDeps(home, "test-1");
  assert.equal(deps.runScript.length, 3, "McpServerDeps.runScript no longer takes a conversationId param");
});

// ── (17) C4: an OWNER MCP run-mute is enforced fail-closed on the daemon-DOWN stdio read-model path too ───
test("(17) a manifest mcpRunMuted:true REFUSES run (suppressed + muted detail) but the skill STAYS listed + loadable (read-model path)", async () => {
  const { home } = buildHome({ muteEchoer: true });
  const server = srv(home);

  // RUN is refused (owner mute, fail-closed on the daemon-down path too) — a NAMED suppressed + muted detail.
  const run = await call(server, "tools/call", { name: "run_skill_script", arguments: { idOrSlug: "echoer", script: "scripts/echo.js" } });
  assert.equal(run.isError, true, "a muted skill's run is a VISIBLE refusal on the read-model path");
  assert.match(run.content[0].text, /suppressed/, "the refusal NAMES suppressed");
  assert.match(run.content[0].text, /muted for MCP runs/i, "the host SEES the owner-mute detail (distinct from conversation-suppression)");

  // but it stays VISIBLE (list_skills) and READABLE (load_skill returns the full body) — only run is refused.
  const list = await call(server, "tools/call", { name: "list_skills", arguments: {} });
  assert.match(list.content[0].text, /echoer/, "a muted skill is still listed");
  const load = await call(server, "tools/call", { name: "load_skill", arguments: { idOrSlug: "echoer" } });
  assert.notEqual(load.isError, true);
  assert.match(load.content[0].text, /Run scripts\/echo\.js to print a marker/, "load_skill still returns the full instructions body");

  // the read-model refusal was audited (never-silent for the ops actor).
  const lines = fs.readFileSync(path.join(home, "exec.log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.slug === "echoer" && l.exit === null && /muted for MCP runs/i.test(l.stderrTail)), "the muted-run refusal was audited");
});

// ── (15) stdio bounds the per-line buffer: an over-long line is rejected, framing recovers ───────────────
// The cap must apply REGARDLESS of whether the over-long line ends in a newline. (15a) covers a newline-FREE
// flood (the guard that fires before any newline arrives); (15b) covers a newline-TERMINATED over-long line
// (the frame the splitter would otherwise enqueue/parse, bypassing the cap). Both are -32700 + drop, and a
// normal line AFTER each still parses (framing recovery). Diagnostics stay on stderr — never on stdout.
test("(15a) an over-long NEWLINE-FREE flood is -32700 and the NEXT line still parses (bounded buffer, self-DoS guard)", async () => {
  const { home } = buildHome();
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOut = new PassThrough();
  let out = "";
  output.on("data", (c: Buffer) => (out += c.toString("utf8")));
  let errText = "";
  errorOut.on("data", (c: Buffer) => (errText += c.toString("utf8")));
  const { closed } = runStdioServer(createReadModelDeps(home, "test-1"), { input, output, errorOut, maxLineUnits: 64 });

  input.write("x".repeat(200)); // a newline-free flood well over the 64-unit cap
  setImmediate(() => {
    input.write("\n"); // terminates the over-long line (its bytes were dropped, not buffered)
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })}\n`);
    input.end();
  });
  await closed;

  const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.error && l.error.code === -32700), "the over-long flood produced a -32700");
  assert.ok(lines.some((l) => l.id === 99 && l.result), "framing recovered — the next well-formed line was handled");
  assert.equal(out.includes("dropped an over-long line"), false, "the over-long diagnostic NEVER touches stdout (the protocol channel)");
  assert.match(errText, /dropped an over-long line/, "the over-long diagnostic goes to stderr only");
});

test("(15b) an over-long NEWLINE-TERMINATED line is -32700 and the NEXT line still parses (cap applies with or without a trailing newline)", async () => {
  const { home } = buildHome();
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOut = new PassThrough();
  let out = "";
  output.on("data", (c: Buffer) => (out += c.toString("utf8")));
  let errText = "";
  errorOut.on("data", (c: Buffer) => (errText += c.toString("utf8")));
  const { closed } = runStdioServer(createReadModelDeps(home, "test-1"), { input, output, errorOut, maxLineUnits: 64 });

  // A SINGLE line over the cap that DOES end in a newline. Without the frame-level cap this would be split
  // into a complete frame and enqueued/parsed, bypassing the bound (the gap Codex found). It must be
  // rejected instead, and the next well-formed line must still parse (framing recovery).
  input.write(`${"x".repeat(200)}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "ping" })}\n`);
  input.end();
  await closed;

  const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.error && l.error.code === -32700), "the over-long newline-terminated line produced a -32700");
  assert.ok(lines.some((l) => l.id === 77 && l.result), "framing recovered — the next well-formed line was handled");
  assert.equal(out.includes("dropped an over-long line"), false, "the over-long diagnostic NEVER touches stdout (the protocol channel)");
  assert.match(errText, /dropped an over-long line/, "the over-long diagnostic goes to stderr only");
});

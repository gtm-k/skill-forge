// @skillforge/daemon/test/adapters-mount — Wave B end-to-end: the MCP-over-HTTP (/mcp) and OpenAI-compat
// proxy (/v1/chat/completions, /v1/embeddings) adapters MOUNTED into the daemon, plus the shared admission
// gate covering them and the 413-delivery fix. This is the Phase-4/5 proof the full MVP works across all
// three targets from a SINGLE daemon process.
//
// HERMETIC: an injected fake CloneFn materializes skill trees (no git/network), a node:http MOCK UPSTREAM
// stands in for Ollama/llama.cpp/LM Studio for the proxy, ephemeral ports, throwaway temp homes. The DB is
// populated via the real addSource pipeline (which ALSO publishes manifest.json), so the MCP deps (live
// store) and the proxy (read-model) both see the same corpus from one ingest.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { CloneFn } from "@skillforge/core";
import { createDaemon } from "../src/index.ts";
import { EXEC_LOG_FILE } from "../src/server/activity.ts";
import { mapMcpRunResponse } from "../src/server/routes/index.ts";
import type { JsonResponse } from "../src/server/http.ts";
import { mkTmp, cleanup } from "./helpers.ts";
import { fakeClone, httpJson, openSse, type FixtureSkill } from "./server-helpers.ts";
import type { AddSourceResult, DaemonEvent, MutationResult } from "@skillforge/contracts/api";
import type { ExecLogLine, ManifestSkillEntry } from "@skillforge/contracts";

after(cleanup);

const GIT_INPUT = "https://github.com/owner/repo";

// ── mock OpenAI-compat upstream (records requests; canned JSON / SSE / embeddings) ──────────────────────
const CANNED_JSON = {
  id: "chatcmpl-mock",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "mock reply" }, finish_reason: "stop" }],
};
const CANNED_SSE = [
  `data: ${JSON.stringify({ id: "m", choices: [{ index: 0, delta: { content: "mock" } }] })}\n\n`,
  `data: [DONE]\n\n`,
].join("");
const CANNED_EMBEDDING = { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }] };

interface RecordedRequest {
  path: string;
  body: { messages?: { role?: string; content?: unknown }[]; stream?: boolean; [k: string]: unknown } | null;
}
interface MockUpstream {
  url: string;
  requests: RecordedRequest[];
  last(): RecordedRequest | undefined;
  close(): Promise<void>;
}
function startMockUpstream(): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: RecordedRequest["body"] = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = null;
      }
      requests.push({ path: req.url ?? "", body });
      if ((req.url ?? "").includes("/embeddings")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(CANNED_EMBEDDING));
        return;
      }
      if (body && body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        res.end(CANNED_SSE);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CANNED_JSON));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        last: () => requests[requests.length - 1],
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** Raw HTTP request (fetch forbids overriding the Host header, which the admission-gate tests need). */
function rawRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers: opts.headers ?? {} },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let nextRpcId = 1;
/** One JSON-RPC request to the mounted /mcp endpoint → { status, body } (body is the parsed reply, if any). */
async function mcp(url: string, method: string, params?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
/** Call an MCP tool over /mcp; returns the tool result ({ content:[{text}], isError? }). */
async function callTool(url: string, name: string, args: Record<string, unknown>): Promise<any> {
  const { body } = await mcp(url, "tools/call", { name, arguments: args });
  assert.ok(body && !body.error, `tools/call ${name} JSON-RPC errored: ${JSON.stringify(body?.error)}`);
  return body.result;
}

async function withDaemon(
  opts: Parameters<typeof createDaemon>[0],
  fn: (url: string, daemon: ReturnType<typeof createDaemon>) => Promise<void>,
): Promise<void> {
  const daemon = createDaemon({ port: 0, reachable: async () => false, ...opts });
  const { url } = await daemon.start();
  try {
    await fn(url, daemon);
  } finally {
    await daemon.stop();
  }
}

function readExecLog(home: string): ExecLogLine[] {
  const p = path.join(home, EXEC_LOG_FILE);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8").trim();
  return raw === "" ? [] : raw.split("\n").map((l) => JSON.parse(l) as ExecLogLine);
}

async function addAndGet(url: string): Promise<ManifestSkillEntry[]> {
  const add = await httpJson<AddSourceResult>(url, "POST", "/sources", { input: GIT_INPUT });
  assert.equal(add.status, 201, "addSource succeeded (DB populated + manifest published)");
  return (await httpJson<ManifestSkillEntry[]>(url, "GET", "/skills")).body;
}

async function grant(url: string, entry: ManifestSkillEntry): Promise<void> {
  const res = await httpJson<MutationResult>(url, "POST", `/skills/${entry.id}/exec-allowed`, {
    contentHash: entry.contentHash,
    on: true,
  });
  assert.equal(res.status, 200, "exec grant accepted");
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
const RUNNER: FixtureSkill[] = [
  { slug: "runner", name: "Runner", description: "runs a tiny script", script: { relPath: "runme.js", content: "process.stdout.write('EXEC-OK')\n" } },
];
const TWO: FixtureSkill[] = [
  { slug: "runner", name: "Runner", description: "runs a tiny script", script: { relPath: "runme.js", content: "process.stdout.write('EXEC-OK')\n" } },
  { slug: "notes", name: "Notes", description: "take and organize notes" },
];
/** A corpus of skills with DISJOINT vocabularies so the PDF terms are rare (high IDF) and the lexical
 *  cascade fires genuinely on a PDF query (BM25 ≥ the 4.0 fire threshold) — no force, no embeddings. */
const PROXY_SKILLS: FixtureSkill[] = [
  { slug: "pdf", name: "PDF Extractor", description: "extract text tables pages from pdf document files" },
  { slug: "git", name: "Git Helper", description: "stage commit branch rebase push repository version control" },
  { slug: "email", name: "Email Composer", description: "compose draft polite professional email message reply" },
  { slug: "image", name: "Image Resizer", description: "resize crop rotate scale jpeg png photo picture" },
  { slug: "csv", name: "CSV Wrangler", description: "parse filter sort join spreadsheet rows columns" },
  { slug: "sql", name: "SQL Builder", description: "query database select where group aggregate index" },
  { slug: "calendar", name: "Calendar Scheduler", description: "schedule meeting event reminder appointment timezone" },
];

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// MCP over HTTP via /mcp
// ════════════════════════════════════════════════════════════════════════════════════════════════════

test("MCP /mcp: initialize handshake + tools/list returns the three SkillForge tools", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-init-"), clone: fakeClone(() => RUNNER) }, async (url) => {
    await addAndGet(url);
    const init = await mcp(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, "skillforge-mcp");
    assert.ok(typeof init.body.result.serverInfo.version === "string", "the daemon reports a server version");
    assert.ok(init.body.result.capabilities.tools && init.body.result.capabilities.resources);

    const list = await mcp(url, "tools/list");
    const names = (list.body.result.tools as { name: string }[]).map((t) => t.name).sort();
    assert.deepEqual(names, ["list_skills", "load_skill", "run_skill_script"]);
  });
});

test("MCP /mcp: list_skills returns ONLY mcp-enabled skills (live store, host-driven)", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-list-"), clone: fakeClone(() => TWO) }, async (url) => {
    const skills = await addAndGet(url);
    const notes = skills.find((s) => s.slug === "notes")!;
    // disable "notes" for the mcp target — list_skills must drop it (the §6 hard pre-filter) while the
    // proxy/lmstudio targets still see it.
    await httpJson(url, "POST", `/skills/${notes.id}/enabled`, { target: "mcp", on: false });

    const res = await callTool(url, "list_skills", {});
    assert.notEqual(res.isError, true);
    const text: string = res.content[0].text;
    assert.match(text, /runner/, "the mcp-enabled skill is listed");
    assert.doesNotMatch(text, /\bnotes\b/, "a skill disabled for mcp is NOT exposed on the MCP menu");
  });
});

test("MCP /mcp: load_skill returns the full instructions body + capability/bundle summary", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-load-"), clone: fakeClone(() => RUNNER) }, async (url) => {
    await addAndGet(url);
    const res = await callTool(url, "load_skill", { idOrSlug: "runner" });
    assert.notEqual(res.isError, true);
    const text: string = res.content[0].text;
    assert.match(text, /runs a tiny script/, "the skill description is included");
    assert.match(text, /runme\.js/, "the runnable script is listed in the bundle summary");

    const missing = await callTool(url, "load_skill", { idOrSlug: "ghost" });
    assert.equal(missing.isError, true, "an unknown skill is a NAMED error, never a silent empty body");
    assert.match(missing.content[0].text, /not-found/);
  });
});

test("MCP /mcp: run_skill_script executes via the daemon gate — exec.log line + `exec` SSE event on /events", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-run-"), clone: fakeClone(() => RUNNER) }, async (url, daemon) => {
    const [runner] = await addAndGet(url);
    await grant(url, runner!);

    const sse = openSse(url);
    await sse.connected;
    try {
      const res = await callTool(url, "run_skill_script", { idOrSlug: "runner", script: "runme.js" });
      assert.notEqual(res.isError, true, `run unexpectedly errored: ${res.content[0].text}`);
      assert.match(res.content[0].text, /exit: 0/, "the script spawned and exited 0 via core.run");
      assert.match(res.content[0].text, /EXEC-OK/, "stdout tail captured");

      // the SAME daemon gate emits the `exec` SSE event MCP runs share with plugin/proxy runs.
      const ev = (await sse.waitFor((e) => e.type === "exec")) as Extract<DaemonEvent, { type: "exec" }>;
      assert.equal(ev.data.slug, "runner");
      assert.equal(ev.data.exit, 0);
      assert.equal((ev.data as ExecLogLine).target, "mcp", "the audit line is stamped with the mcp target");

      const log = readExecLog(daemon.home);
      assert.ok(log.some((l) => l.slug === "runner" && l.exit === 0), "the durable exec.log.jsonl line was written");
    } finally {
      sse.close();
    }
  });
});

test("MCP /mcp: a source pinned to trust 'dry-run' FORCES dry-run — no real spawn, visibly marked", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-dry-"), clone: fakeClone(() => RUNNER) }, async (url, daemon) => {
    const [runner] = await addAndGet(url);
    const sourceId = runner!.provenance[0]!.sourceId;
    await httpJson(url, "PATCH", "/config", { trustLevels: { [sourceId]: "dry-run" } });
    await grant(url, runner!);

    const res = await callTool(url, "run_skill_script", { idOrSlug: "runner", script: "runme.js" });
    assert.notEqual(res.isError, true, "dry-run is a (non-error) outcome");
    assert.match(res.content[0].text, /\(dry-run\)/, "the host SEES the pin took effect (never silent)");
    assert.match(res.content[0].text, /exit: null/, "no real spawn (exit null)");

    const log = readExecLog(daemon.home);
    assert.ok(log.some((l) => l.slug === "runner" && l.exit === null && /dry-run/i.test(l.stderrTail)), "the dry-run was audited");
  });
});

// C4 — a per-skill OWNER MCP run-mute is NON-ROTATABLE: there is no client/session input the host can
// rotate (the MCP run tool no longer even HAS a conversationId), and it is enforced fail-closed at the
// daemon chokepoint. (This REPLACES the old conversationId-scoped suppression test over MCP — the forgeable
// client scope is gone; conversation suppression now lives only on the trusted inject path, see exec.test.ts.)
test("MCP /mcp: a per-skill OWNER run-mute is NON-ROTATABLE — every fresh init+run is REFUSED (named 'suppressed' + muted detail), while list/load still work", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-mute-"), clone: fakeClone(() => RUNNER) }, async (url, daemon) => {
    const [runner] = await addAndGet(url);
    await grant(url, runner!);

    // the owner mutes MCP runs for this skill (persisted, human-set, no client/session input).
    const mute = await httpJson<MutationResult>(url, "POST", `/skills/${runner!.id}/mcp-mute`, { on: true });
    assert.equal(mute.status, 200, "the mute control-plane route accepted the request");

    // N fresh `initialize` + run_skill_script — EVERY attempt is refused. Proves there is no re-init /
    // session-rotation bypass (the core non-rotatable guarantee — the field is persisted + re-read each call).
    for (let i = 0; i < 5; i++) {
      await mcp(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      const res = await callTool(url, "run_skill_script", { idOrSlug: "runner", script: "runme.js" });
      assert.equal(res.isError, true, `attempt ${i}: a muted skill is a VISIBLE refusal, never a silent run`);
      assert.match(res.content[0].text, /suppressed/, `attempt ${i}: the refusal NAMES the suppressed reason`);
      assert.match(res.content[0].text, /muted for MCP runs/i, `attempt ${i}: the host SEES it is an owner-mute (distinct from conversation-suppression)`);
    }

    // a muted skill stays VISIBLE (list_skills) and READABLE (load_skill) — only RUN is refused.
    const list = await callTool(url, "list_skills", {});
    assert.match(list.content[0].text, /runner/, "a muted skill is still listed (visible)");
    const load = await callTool(url, "load_skill", { idOrSlug: "runner" });
    assert.notEqual(load.isError, true, "a muted skill is still loadable (readable)");

    // every refusal was audited (never silent for the ops actor).
    assert.ok(
      readExecLog(daemon.home).filter((l) => l.slug === "runner" && /muted for MCP runs/i.test(l.stderrTail)).length >= 5,
      "each muted-run attempt wrote a durable exec.log.jsonl line",
    );
  });
});

// C4 — un-mute round-trip: a returned 200 from the mute route implies the manifest already reflects the
// state (publishManifest is synchronous after the DB write), and un-mute DROPS the field (minimal manifest).
test("MCP /mcp: un-mute round-trip — refused while muted, runs for real after {on:false}; manifest carries then drops the field", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-unmute-"), clone: fakeClone(() => RUNNER) }, async (url, daemon) => {
    const [runner] = await addAndGet(url);
    await grant(url, runner!);

    await httpJson<MutationResult>(url, "POST", `/skills/${runner!.id}/mcp-mute`, { on: true });
    const muted = JSON.parse(fs.readFileSync(path.join(daemon.home, "manifest.json"), "utf8"));
    assert.equal(muted.skills.find((s: ManifestSkillEntry) => s.id === runner!.id).mcpRunMuted, true, "the published manifest carries the mute (synchronous publish)");

    const blocked = await callTool(url, "run_skill_script", { idOrSlug: "runner", script: "runme.js" });
    assert.equal(blocked.isError, true, "muted → refused");
    assert.match(blocked.content[0].text, /suppressed/);

    // un-mute → the field is dropped from the manifest and the run executes for real (reaches exec).
    await httpJson<MutationResult>(url, "POST", `/skills/${runner!.id}/mcp-mute`, { on: false });
    const unmuted = JSON.parse(fs.readFileSync(path.join(daemon.home, "manifest.json"), "utf8"));
    assert.equal("mcpRunMuted" in unmuted.skills.find((s: ManifestSkillEntry) => s.id === runner!.id), false, "un-mute drops the field");

    const okRun = await callTool(url, "run_skill_script", { idOrSlug: "runner", script: "runme.js" });
    assert.notEqual(okRun.isError, true, `un-muted run unexpectedly errored: ${okRun.content[0].text}`);
    assert.match(okRun.content[0].text, /exit: 0/, "the un-muted skill runs for real");
    assert.match(okRun.content[0].text, /EXEC-OK/, "stdout tail captured");
  });
});

// C4 — observability: a muted-run attempt is an `exec` SSE event AND a durable exec.log.jsonl line, exactly
// like every other refusal (never silent for the ops actor).
test("MCP /mcp: a muted run emits an `exec` SSE event (target mcp, exit null, muted detail) AND a durable exec.log line", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-mute-obs-"), clone: fakeClone(() => RUNNER) }, async (url, daemon) => {
    const [runner] = await addAndGet(url);
    await grant(url, runner!);
    await httpJson<MutationResult>(url, "POST", `/skills/${runner!.id}/mcp-mute`, { on: true });

    const sse = openSse(url);
    await sse.connected;
    try {
      const res = await callTool(url, "run_skill_script", { idOrSlug: "runner", script: "runme.js" });
      assert.equal(res.isError, true);

      const ev = (await sse.waitFor(
        (e) => e.type === "exec" && /muted for MCP runs/i.test((e as Extract<DaemonEvent, { type: "exec" }>).data.stderrTail),
      )) as Extract<DaemonEvent, { type: "exec" }>;
      assert.equal(ev.data.slug, "runner");
      assert.equal(ev.data.exit, null, "a muted refusal exits null (never spawned)");
      assert.equal((ev.data as ExecLogLine).target, "mcp", "the audit line is stamped with the mcp target");

      assert.ok(
        readExecLog(daemon.home).some((l) => l.slug === "runner" && l.exit === null && /muted for MCP runs/i.test(l.stderrTail)),
        "the muted-run attempt wrote a durable exec.log.jsonl line",
      );
    } finally {
      sse.close();
    }
  });
});

test("MCP /mcp: an ungranted skill run is REFUSED with a NAMED no-grant error (default-deny)", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-nogrant-"), clone: fakeClone(() => RUNNER) }, async (url) => {
    await addAndGet(url); // NO grant
    const res = await callTool(url, "run_skill_script", { idOrSlug: "runner", script: "runme.js" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no-grant/, "the refusal NAMES the gate that fired");
  });
});

// Finding 2 — a NUL-byte caller arg is a CALLER-input error (bad-args), not content drift (hash-mismatch).
test("MCP /mcp: a NUL-byte arg is refused as 'bad-args', NOT mislabeled 'hash-mismatch'", async () => {
  await withDaemon({ home: mkTmp("skf-wb-mcp-badargs-"), clone: fakeClone(() => RUNNER) }, async (url, daemon) => {
    const [runner] = await addAndGet(url);
    await grant(url, runner!); // granted + hash matches → the ONLY problem is the spawn-unsafe argv
    // a JSON string carrying a real NUL byte survives JSON.stringify→parse, so the daemon gate sees it in argv.
    const res = await callTool(url, "run_skill_script", { idOrSlug: "runner", script: "runme.js", args: ["ok", `ev${String.fromCharCode(0)}il`] });
    assert.equal(res.isError, true, "a non-spawn-safe argv is a VISIBLE refusal, never a silent run");
    assert.match(res.content[0].text, /bad-args/, "the refusal NAMES bad-args (the caller-input error)");
    assert.doesNotMatch(res.content[0].text, /hash-mismatch/, "a granted, hash-matching skill is NOT mislabeled as content drift");
    assert.ok(
      readExecLog(daemon.home).some((l) => l.slug === "runner" && /not spawn-safe|NUL byte/i.test(l.stderrTail)),
      "the bad-args refusal was audited (never silent)",
    );
  });
});

// Finding 1 — mapMcpRunResponse must read the STRUCTURED dryRun flag, NOT sniff exit/stderr. This is the exact
// gap the reviewer flagged: a real (side-effecting) run that dies from a signal (exit:null), writes no stdout,
// and prints child-controlled "dry-run…" to stderr would be FALSELY reported as a harmless dry-run by a sniff.
// (Hermetic + cross-platform: the daemon-backed mapping is exercised directly with crafted gate responses,
// because a true exit:null real run is not reproducible from a self-killing script on every OS.)
test("Finding 1: a signal-killed REAL run (stderr starts with 'dry-run', no structured flag) is reported as a REAL run", () => {
  const entry = { id: "id-x", slug: "x" } as unknown as ManifestSkillEntry;

  const signalKilled: JsonResponse = {
    status: 200,
    body: { exit: null, durationMs: 12, stdoutTail: "", stderrTail: "dry-run: I actually executed then got SIGKILLed", contentHash: "h" },
  };
  const real = mapMcpRunResponse(signalKilled, entry);
  assert.equal(real.ok, true);
  assert.equal(
    (real as Extract<typeof real, { ok: true }>).dryRun,
    false,
    "side-effect-occurred ⇒ NOT reported as a dry-run (the old stderr sniff would have falsely said true)",
  );

  const genuine: JsonResponse = {
    status: 200,
    body: { exit: null, durationMs: 3, stdoutTail: "", stderrTail: "dry-run: bundle hash matched, not spawning", contentHash: "h", dryRun: true },
  };
  const dry = mapMcpRunResponse(genuine, entry);
  assert.equal(dry.ok, true);
  assert.equal(
    (dry as Extract<typeof dry, { ok: true }>).dryRun,
    true,
    "a genuine trust-pinned/dry-run is reported dryRun true via the STRUCTURED flag",
  );
});

test("MCP /mcp: resources/list + resources/read expose references with containment + references-only", async () => {
  const cloneWithRef: CloneFn = async (_ref, dest) => {
    const dir = path.join(dest, "refskill");
    fs.mkdirSync(path.join(dir, "refs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: RefSkill\ndescription: a skill that ships a reference\n---\nBody text.\n");
    fs.writeFileSync(path.join(dir, "refs", "guide.md"), "# Guide\n\nReference content lives here.\n");
  };
  await withDaemon({ home: mkTmp("skf-wb-mcp-res-"), clone: cloneWithRef }, async (url) => {
    await addAndGet(url);
    const list = await mcp(url, "resources/list");
    const uris = (list.body.result.resources as { uri: string }[]).map((r) => r.uri);
    assert.ok(uris.includes("skillforge://refskill/refs/guide.md"), `expected the guide resource, got ${JSON.stringify(uris)}`);

    const read = await mcp(url, "resources/read", { uri: "skillforge://refskill/refs/guide.md" });
    assert.equal(read.body.result.contents[0].mimeType, "text/markdown");
    assert.match(read.body.result.contents[0].text, /Reference content lives here/);

    // SKILL.md is contained but is NOT a reference → a NAMED protocol error (references-only surface).
    const refused = await mcp(url, "resources/read", { uri: "skillforge://refskill/SKILL.md" });
    assert.ok(refused.body.error, "reading a non-reference is a JSON-RPC error, never a silent read");
    assert.match(refused.body.error.message, /not-a-reference/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// OpenAI-compat proxy via the daemon
// ════════════════════════════════════════════════════════════════════════════════════════════════════

test("proxy /v1/chat/completions: a firing message injects an ephemeral system message and forwards [system,user]", async () => {
  const mock = await startMockUpstream();
  try {
    await withDaemon(
      { home: mkTmp("skf-wb-proxy-fire-"), clone: fakeClone(() => PROXY_SKILLS), config: { upstreams: { proxy: { chatBaseUrl: mock.url } } } },
      async (url) => {
        await addAndGet(url);
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "extract the text and tables from this PDF document" }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-skill-injected"), "pdf", "the matched skill was injected");

        const fwd = mock.last()!;
        assert.equal(fwd.body?.messages?.length, 2, "the upstream received the injected system message + the user turn");
        assert.equal(fwd.body?.messages?.[0]?.role, "system");
        assert.match(String(fwd.body?.messages?.[0]?.content), /pdf/i, "the injected block is the pdf skill");
        assert.equal(fwd.body?.messages?.[1]?.role, "user");
      },
    );
  } finally {
    await mock.close();
  }
});

test("proxy /v1/chat/completions: a non-firing message passes through untouched ([user])", async () => {
  const mock = await startMockUpstream();
  try {
    await withDaemon(
      { home: mkTmp("skf-wb-proxy-pass-"), clone: fakeClone(() => PROXY_SKILLS), config: { upstreams: { proxy: { chatBaseUrl: mock.url } } } },
      async (url) => {
        await addAndGet(url);
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "what is the weather in Tokyo today" }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-skill-injected"), "none", "a no-match injects nothing");
        const fwd = mock.last()!;
        assert.equal(fwd.body?.messages?.length, 1, "the upstream received the ORIGINAL single user message");
        assert.equal(fwd.body?.messages?.[0]?.role, "user");
      },
    );
  } finally {
    await mock.close();
  }
});

test("proxy /v1/chat/completions: stream:true pipes the upstream SSE bytes through untouched (request still mutated)", async () => {
  const mock = await startMockUpstream();
  try {
    await withDaemon(
      { home: mkTmp("skf-wb-proxy-stream-"), clone: fakeClone(() => PROXY_SKILLS), config: { upstreams: { proxy: { chatBaseUrl: mock.url } } } },
      async (url) => {
        await addAndGet(url);
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "extract the text and tables from this PDF document" }] }),
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "the upstream SSE content-type is mirrored");
        assert.equal(await res.text(), CANNED_SSE, "the SSE body is the upstream's bytes, untouched");
        const fwd = mock.last()!;
        assert.equal(fwd.body?.stream, true, "the stream flag was forwarded");
        assert.equal(fwd.body?.messages?.[0]?.role, "system", "the request WAS mutated (injection) even when streaming");
      },
    );
  } finally {
    await mock.close();
  }
});

test("proxy /v1/embeddings: passes through to the configured embeddings provider", async () => {
  const mock = await startMockUpstream();
  try {
    await withDaemon(
      { home: mkTmp("skf-wb-proxy-embed-"), config: { embeddings: { baseUrl: mock.url, model: "fake", dim: 3 } } },
      async (url) => {
        const res = await fetch(`${url}/v1/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fake", input: ["hello"] }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-skill-passthrough"), "embeddings");
        const body = JSON.parse(await res.text());
        assert.deepEqual(body, CANNED_EMBEDDING, "the configured provider's embedding response reached the client");
        assert.ok(mock.last()!.path.includes("/embeddings"), "the request was forwarded to the embeddings endpoint");
      },
    );
  } finally {
    await mock.close();
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// admission gate covers the mounted surfaces + 413 delivery
// ════════════════════════════════════════════════════════════════════════════════════════════════════

test("admission gate covers the mounted /mcp and /v1/chat/completions surfaces (non-local Host/Origin → 403)", async () => {
  const mock = await startMockUpstream();
  try {
    await withDaemon(
      { home: mkTmp("skf-wb-admit-"), clone: fakeClone(() => PROXY_SKILLS), config: { upstreams: { proxy: { chatBaseUrl: mock.url } } } },
      async (url, daemon) => {
        await addAndGet(url);
        const port = daemon.port!;
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

        // non-local Host (DNS-rebinding) on the MCP surface.
        const mcpHost = await rawRequest(port, { method: "POST", path: "/mcp", headers: { host: "evil.example.com", "content-type": "application/json" }, body });
        assert.equal(mcpHost.status, 403, "a non-local Host to /mcp is refused before the handler runs");
        assert.match(mcpHost.body, /forbidden/);

        // cross-origin (CSRF) on the proxy chat surface — local Host, hostile Origin.
        const chatOrigin = await rawRequest(port, {
          method: "POST",
          path: "/v1/chat/completions",
          headers: { origin: "http://evil.example.com", "content-type": "application/json" },
          body: JSON.stringify({ model: "m", messages: [] }),
        });
        assert.equal(chatOrigin.status, 403, "a cross-origin POST to the proxy is refused (CSRF) — mounted = behind the gate");
        assert.match(chatOrigin.body, /forbidden/);

        // the gate runs BEFORE routing → the proxy never forwarded anything to the upstream.
        assert.equal(mock.requests.length, 0, "no mounted handler ran behind a refused admission");
      },
    );
  } finally {
    await mock.close();
  }
});

test("413 delivery: an over-cap body to a bounded daemon control route returns a 413 the client can READ (not a reset)", async () => {
  await withDaemon({ home: mkTmp("skf-wb-413-") }, async (url, daemon) => {
    const big = "x".repeat(1_050_000); // > the daemon's 1MB control-API cap (route body is bounded BEFORE parse)
    const res = await rawRequest(daemon.port!, {
      method: "POST",
      path: "/route-test",
      headers: { "content-type": "application/json" },
      body: big,
    });
    assert.equal(res.status, 413, "the client RECEIVES the 413 (the over-cap path no longer resets the socket first)");
    assert.match(res.body, /payload-too-large/, "and can read the typed body");
    void url;
  });
});

/** Raw POST capturing status + headers + body, and whether a PRE-response socket reset occurred. The over-cap
 *  path used to PAUSE the request then close, which RST-raced a large in-flight upload (the client could see
 *  ECONNRESET before reading the 413). Wave C replaced that with a bounded lingering-close (core/net
 *  respondPayloadTooLarge) that resumes-and-discards the rest of the upload so the peer flushes and reads the
 *  413 even at 10MB. This helper still distinguishes a pre-response reset (resolves { reset: true }) from a
 *  fully-read response ({ reset: false } + real status/headers/body) so the test can assert reset === false. */
function rawPostCapture(
  port: number,
  p: string,
  body: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; reset: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data, reset: false });
        });
      },
    );
    req.on("error", () => {
      if (settled) return; // a pre-response reset is the inherent close-during-upload race (see doc above)
      settled = true;
      resolve({ status: 0, headers: {}, body: "", reset: true });
    });
    req.write(body);
    req.end();
  });
}

// Finding 3 — the proxy's OWN 10MB cap (mounted, raw route ⇒ NOT the daemon's 1MB control cap). Two distinct
// properties, BOTH now asserted deterministically:
//   (1) mounted-specific security guard: the bounded read rejects the over-cap body BEFORE any forward, so an
//       over-cap body is NEVER relayed upstream (the integration property unique to mounting).
//   (2) actor-observability: the client RELIABLY reads a 413 + `connection: close`. Wave C replaced the old
//       pause-then-close (which RST-raced a ~10MB in-flight upload, so the client SOMETIMES saw ECONNRESET
//       before the 413) with a BOUNDED LINGERING-CLOSE in core/net (respondPayloadTooLarge): after writing the
//       413 it resumes-and-discards the rest of the upload for a bounded window, so the peer flushes and reads
//       the status even at 10MB. The race is closed → this test now gates on the readable 413 unconditionally.
test("Finding 3 — an over-cap POST to the MOUNTED /v1/chat/completions (and /v1/embeddings) is NEVER forwarded upstream AND returns a reliably-readable 413 (bounded lingering-close)", async () => {
  const mock = await startMockUpstream();
  try {
    await withDaemon(
      {
        home: mkTmp("skf-wb-proxy-413-"),
        clone: fakeClone(() => PROXY_SKILLS),
        config: { upstreams: { proxy: { chatBaseUrl: mock.url } }, embeddings: { baseUrl: mock.url, model: "fake", dim: 3 } },
      },
      async (url, daemon) => {
        await addAndGet(url);
        // ingest already embedded the corpus against the configured embeddings provider (the same mock), so
        // snapshot the forward count: the over-cap POSTs must add ZERO further forwards (rejected pre-forward).
        const baseline = mock.requests.length;
        const over = "x".repeat(10_500_000); // > the proxy's OWN 10MB chat cap

        // (2) DETERMINISTIC actor-observability: the bounded lingering-close makes the 413 reliably readable
        // even at a 10MB in-flight upload — no close-during-upload reset. Gate on it unconditionally now.
        const chat = await rawPostCapture(daemon.port!, "/v1/chat/completions", over);
        assert.equal(chat.reset, false, "no ECONNRESET — the lingering-close lets the client read the 413 at 10MB");
        assert.equal(chat.status, 413, "the client RECEIVES the proxy's 413 (bounded read + reliable delivery)");
        assert.match(chat.body, /payload-too-large/, "and can read the typed body");
        assert.equal(chat.headers["connection"], "close", "the undrained socket is closed (no keep-alive reuse — slowloris/desync bound)");

        const embed = await rawPostCapture(daemon.port!, "/v1/embeddings", over);
        assert.equal(embed.reset, false, "no ECONNRESET on the embeddings endpoint either");
        assert.equal(embed.status, 413, "the embeddings endpoint mirrors the readable-413 fix");
        assert.match(embed.body, /payload-too-large/, "and can read the typed body");
        assert.equal(embed.headers["connection"], "close");

        // (1) DETERMINISTIC: independent of the readable-413 TCP race, the over-cap body is rejected by the
        // bounded read BEFORE any forward — so neither POST ever reached the upstream (the mounted-specific
        // property, and the assertion that actually fails if a regression let an unbounded body through).
        assert.equal(mock.requests.length, baseline, "neither over-cap body was forwarded upstream (rejected before any forward)");
        void url;
      },
    );
  } finally {
    await mock.close();
  }
});

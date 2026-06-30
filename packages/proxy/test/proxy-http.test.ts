// Proxy HTTP behavior (PLAN §8 groups 2/3/5 + the Tier-2-ENABLED inverse of group 4).
//
// Streaming-transparent passthrough, the X-Skill control header (force / off), per-request ephemerality
// (no stickiness, no cross-request state), and the semantic path firing with NO disabled signal when an
// embeddings provider is configured. All hermetic: a node:http mock upstream + (for Tier-2) a fake embed
// FetchLike. No real Ollama / LM Studio, ephemeral ports (0).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { DaemonConfig } from "@skillforge/contracts/api";
import { createProxyHandler, placeSystemEphemeral } from "../src/index.ts";
import { startProxyServer, type ProxyServer } from "../src/server.ts";
import {
  buildGoldenHome,
  buildEmbeddedHome,
  startMockUpstream,
  fakeEmbedFetch,
  postChat,
  readSelectLog,
  cleanupHomes,
  CANNED_SSE,
  type MockUpstream,
} from "./helpers.ts";

after(cleanupHomes);

interface Harness {
  proxy: ProxyServer;
  mock: MockUpstream;
  close(): Promise<void>;
}
async function harness(home: string, config: Partial<DaemonConfig> = {}, embedFetch?: ReturnType<typeof fakeEmbedFetch>): Promise<Harness> {
  const mock = await startMockUpstream();
  const cfg: DaemonConfig = {
    schemaVersion: 1,
    port: 0,
    lmStudioBaseUrl: "http://127.0.0.1:1234",
    upstreams: { proxy: { chatBaseUrl: mock.url } },
    ...config,
  };
  const handlers = createProxyHandler({ home, config: () => cfg, ...(embedFetch ? { embedFetch } : {}) });
  const proxy = await startProxyServer(handlers, 0);
  return {
    proxy,
    mock,
    close: async () => {
      await proxy.close();
      await mock.close();
    },
  };
}

function systemHead(mock: MockUpstream): { role?: string; content?: unknown } | undefined {
  return mock.last()?.body?.messages?.[0];
}

// ── group 2: streaming passthrough ────────────────────────────────────────────────────────────────────
test("group 2 — streaming: a stream:true request returns the upstream SSE bytes UNTOUCHED, and the upstream RECEIVED the injected system message", async () => {
  const home = buildGoldenHome();
  const h = await harness(home);
  try {
    const q = "design a distinctive, polished landing page UI"; // a clear lexical hit
    const res = await postChat(h.proxy.url, { model: "m", stream: true, messages: [{ role: "user", content: q }] });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "the upstream SSE content-type is mirrored");
    assert.equal(res.text, CANNED_SSE, "the SSE body is the upstream's bytes, untouched (only the request was mutated)");

    // the REQUEST forwarded upstream carried the ephemeral system injection (the request WAS mutated)...
    const head = systemHead(h.mock);
    assert.equal(head?.role, "system", "the upstream received the injected ephemeral system message");
    assert.match(String(head?.content), /frontend|design/i, "the injected block is the matched skill");
    // ...and the stream flag was preserved (transparent on the response).
    assert.equal(h.mock.last()?.body?.stream, true, "the stream flag was forwarded unchanged");
    assert.equal(res.headers.get("x-skill-injected"), "frontend-design");
  } finally {
    await h.close();
  }
});

// ── group 3: the X-Skill control header ────────────────────────────────────────────────────────────────
test("group 3 — X-Skill:<slug> forces a Tier-0 explicit selection (even when the user text would not match)", async () => {
  const home = buildGoldenHome();
  const h = await harness(home);
  try {
    // user text is a no-match negative; the X-Skill header forces 'frontend-design' via the Tier-0 $slug mechanism.
    const res = await postChat(
      h.proxy.url,
      { model: "m", messages: [{ role: "user", content: "what is the weather in Tokyo today" }] },
      { "X-Skill": "frontend-design" },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-skill-injected"), "frontend-design", "the forced skill was injected");
    assert.equal(res.headers.get("x-skill-tier"), "explicit", "a forced selection is Tier-0 explicit");
    const head = systemHead(h.mock);
    assert.equal(head?.role, "system");
    assert.match(String(head?.content), /frontend|design/i);

    const line = readSelectLog(home).at(-1)!;
    assert.equal(line.forced, "frontend-design", "the force directive is recorded in select.log");
    assert.equal(line.tier, "explicit");
  } finally {
    await h.close();
  }
});

test("group 3 — X-Skill:off is a pure passthrough (no selection, no injection)", async () => {
  const home = buildGoldenHome();
  const h = await harness(home);
  try {
    const q = "design a distinctive, polished landing page UI"; // WOULD match — but off disables injection
    const res = await postChat(h.proxy.url, { model: "m", messages: [{ role: "user", content: q }] }, { "X-Skill": "off" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-skill-injected"), "none", "X-Skill:off injects nothing");
    assert.equal(res.headers.get("x-skill-disclosure"), "none");
    assert.equal(h.mock.last()?.body?.messages?.length, 1, "the upstream received the ORIGINAL single user message");
    assert.equal(systemHead(h.mock)?.role, "user", "no system message was prepended");

    const line = readSelectLog(home).at(-1)!;
    assert.equal(line.forced, "off");
    assert.equal(line.slug, null);
  } finally {
    await h.close();
  }
});

// ── group 5: ephemerality (no stickiness, no cross-request state) ──────────────────────────────────────
test("group 5 — ephemerality: a match injects this request only; a later no-match request injects NOTHING (no stickiness)", async () => {
  const home = buildGoldenHome();
  const h = await harness(home);
  try {
    // request 1 — a clear match → injected.
    const r1 = await postChat(h.proxy.url, { model: "m", messages: [{ role: "user", content: "design a distinctive, polished landing page UI" }] });
    assert.equal(r1.headers.get("x-skill-injected"), "frontend-design");
    assert.equal(systemHead(h.mock)?.role, "system");

    // request 2 — a no-match negative → NOTHING injected (no sticky carry-over from request 1).
    const r2 = await postChat(h.proxy.url, { model: "m", messages: [{ role: "user", content: "what is the capital of Australia" }] });
    assert.equal(r2.headers.get("x-skill-injected"), "none", "the second (no-match) request must inject nothing");
    assert.equal(h.mock.last()?.body?.messages?.length, 1, "the no-match request reached the upstream untouched");
    assert.equal(systemHead(h.mock)?.role, "user");

    // two requests ⇒ two durable select-log lines; nothing persisted BETWEEN them.
    const lines = readSelectLog(home);
    assert.ok(lines.length >= 2, "each request is independently audited");
    assert.equal(lines.at(-1)!.slug, null, "the last (no-match) line injected nothing");
  } finally {
    await h.close();
  }
});

test("group 5 — placeSystemEphemeral never mutates the caller's messages array (per-request, nothing persisted)", () => {
  const original = [{ role: "user", content: "hi" }];
  const snapshot = JSON.stringify(original);
  const out = placeSystemEphemeral(original, "# Skill\n\nbody");
  assert.equal(JSON.stringify(original), snapshot, "the input array is untouched");
  assert.equal(out.length, 2);
  assert.equal((out[0] as { role: string }).role, "system");
  assert.notEqual(out, original as unknown, "a NEW array is returned");
});

// ── Tier-2 ENABLED (the inverse of group 4): semantic fires, NO disabled signal ─────────────────────────
test("Tier-2 enabled: a configured embeddings provider routes SEMANTICALLY with NO X-Skill-Tier2 disabled signal", async () => {
  const home = buildEmbeddedHome(
    [
      { slug: "git-helper", name: "Git Helper", description: "git stage commit branch rebase push", body: "Use git to manage history.", embedding: [1, 0, 0] },
      { slug: "pdf-extract", name: "PDF Extractor", description: "extract tables paragraphs from pdf pages", body: "Open the PDF and extract.", embedding: [0, 1, 0] },
      { slug: "email-writer", name: "Email Composer", description: "compose draft professional email", body: "Draft a concise email.", embedding: [0, 0, 1] },
    ],
    3,
  );
  const embedFetch = fakeEmbedFetch(() => [1, 0, 0]); // any query embeds to the git-helper vector
  const h = await harness(home, { embeddings: { baseUrl: "http://127.0.0.1:1234", model: "fake", dim: 3 } }, embedFetch);
  try {
    const res = await postChat(h.proxy.url, { model: "m", messages: [{ role: "user", content: "help me with this task" }] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-skill-tier"), "semantic", "semantic Tier-2 fired");
    assert.equal(res.headers.get("x-skill-injected"), "git-helper");
    assert.equal(res.headers.get("x-skill-tier2"), null, "NO disabled signal when the provider is configured + reachable");

    const line = readSelectLog(home).at(-1)!;
    assert.equal(line.tier, "semantic");
    assert.equal(line.tier2Disabled, undefined, "select.log records no Tier-2 degradation");
  } finally {
    await h.close();
  }
});

// ── upstream / config error surfaces (never silent) ─────────────────────────────────────────────────────
test("no chat upstream configured ⇒ a visible 502 (never a silent passthrough)", async () => {
  const home = buildGoldenHome();
  const mock = await startMockUpstream(); // configured but NOT wired into upstreams.proxy
  const handlers = createProxyHandler({ home, config: () => ({ schemaVersion: 1, port: 0, lmStudioBaseUrl: "http://127.0.0.1:1234" }) });
  const proxy = await startProxyServer(handlers, 0);
  try {
    const res = await postChat(proxy.url, { model: "m", messages: [{ role: "user", content: "extract text from PDF" }] });
    assert.equal(res.status, 502);
    assert.match(res.text, /no-upstream|no proxy upstream/);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

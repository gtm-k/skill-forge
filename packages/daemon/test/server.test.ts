// @skillforge/daemon/test/server — the HTTP control surface end-to-end (every route to its RouteIO type).
// Hermetic: an injected fake CloneFn (no git/network), an injected fake embeddings fetch (no LM Studio),
// an injected reachability probe (no real hosts), ephemeral ports, throwaway temp homes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {
  buildLexicalIndex,
  createEmbeddingIndex,
  createEmbedProvider,
  selectWithEscalation,
  buildInjection,
  parseFrontmatter,
} from "@skillforge/core";
import { SCHEMA_VERSION } from "@skillforge/contracts";
import type { ManifestSkillEntry, SkillManifest } from "@skillforge/contracts";
import {
  MAX_SOURCE_INPUT_LEN,
  type AddSourceResult,
  type DaemonEvent,
  type EmbeddingsProvider,
  type HealthStatus,
  type RouteTestResult,
  type SkillDetail,
  type SourceRecord,
  type DaemonConfig,
  type MutationResult,
} from "@skillforge/contracts/api";
import { createDaemon } from "../src/index.ts";
import { manifestPath } from "../src/home.ts";
import { mkTmp, cleanup } from "./helpers.ts";
import { fakeClone, fakeEmbedFetch, httpJson, openSse, type FixtureSkill } from "./server-helpers.ts";

after(cleanup);

const GIT_INPUT = "https://github.com/owner/repo";
const TWO_SKILLS: FixtureSkill[] = [
  { slug: "alpha", name: "Alpha", description: "resize and crop images" },
  { slug: "beta", name: "Beta", description: "parse and query csv files" },
];
const PROVIDER: EmbeddingsProvider = { baseUrl: "http://127.0.0.1:1234", model: "nomic", dim: 3 };

/** Deterministic 3-d embedding by keyword (no model): image-space vs csv-space vs neutral. */
function vecFor(text: string): number[] {
  const t = text.toLowerCase();
  if (/resiz|image|crop/.test(t)) return [1, 0, 0];
  if (/csv|parse|quer/.test(t)) return [0, 1, 0];
  return [0, 0, 1];
}

/** Raw HTTP request (fetch forbids overriding the Host header, which the admission-gate tests need). */
function rawRequest(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
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

async function withDaemon(opts: Parameters<typeof createDaemon>[0], fn: (url: string, daemon: ReturnType<typeof createDaemon>) => Promise<void>): Promise<void> {
  const daemon = createDaemon({ port: 0, reachable: async () => false, ...opts });
  const { url } = await daemon.start();
  try {
    await fn(url, daemon);
  } finally {
    await daemon.stop();
  }
}

test("addSource (HTTP) → skills appear in listSkills, the manifest is published, and a `source` SSE event fires", async () => {
  await withDaemon({ home: mkTmp("skf-srv-add-"), clone: fakeClone(() => TWO_SKILLS) }, async (url, daemon) => {
    const sse = openSse(url);
    await sse.connected;
    try {
      const add = await httpJson<AddSourceResult>(url, "POST", "/sources", { input: GIT_INPUT });
      assert.equal(add.status, 201);
      assert.equal(add.body.added, 2);

      const sourceEvent = (await sse.waitFor((ev) => ev.type === "source")) as Extract<DaemonEvent, { type: "source" }>;
      assert.equal(sourceEvent.data.sourceId, add.body.sourceId);
      assert.equal(sourceEvent.data.changed, 2);

      const skills = await httpJson<ManifestSkillEntry[]>(url, "GET", "/skills");
      assert.equal(skills.status, 200);
      assert.deepEqual(skills.body.map((s) => s.slug).sort(), ["alpha", "beta"]);

      assert.ok(fs.existsSync(manifestPath(daemon.home)), "the read-model manifest was published");

      const sources = await httpJson<SourceRecord[]>(url, "GET", "/sources");
      assert.equal(sources.body.length, 1);
      assert.equal(sources.body[0]!.skillCount, 2);
    } finally {
      sse.close();
    }
  });
});

test("GET /events smoke: a connected client receives a live event", async () => {
  await withDaemon({ home: mkTmp("skf-srv-sse-"), clone: fakeClone(() => TWO_SKILLS) }, async (url) => {
    const sse = openSse(url);
    await sse.connected;
    try {
      await httpJson(url, "POST", "/sources", { input: GIT_INPUT });
      const ev = await sse.waitFor(() => true);
      assert.ok(ev.type, "received at least one SSE event over the live stream");
    } finally {
      sse.close();
    }
  });
});

test("GET /activity backfills the published source event from the JSONL log", async () => {
  await withDaemon({ home: mkTmp("skf-srv-act-"), clone: fakeClone(() => TWO_SKILLS) }, async (url) => {
    await httpJson(url, "POST", "/sources", { input: GIT_INPUT });
    const activity = await httpJson<DaemonEvent[]>(url, "GET", "/activity");
    assert.equal(activity.status, 200);
    assert.ok(
      activity.body.some((e) => e.type === "source"),
      "the source event is rehydrated from activity.log.jsonl on backfill",
    );
  });
});

test("setEnabled flips the per-target toggle (and is reflected in the read-path)", async () => {
  await withDaemon({ home: mkTmp("skf-srv-en-"), clone: fakeClone(() => TWO_SKILLS) }, async (url) => {
    const add = await httpJson<AddSourceResult>(url, "POST", "/sources", { input: GIT_INPUT });
    const skills = await httpJson<ManifestSkillEntry[]>(url, "GET", "/skills");
    const alpha = skills.body.find((s) => s.slug === "alpha")!;
    assert.equal(alpha.enabledFor.mcp, true, "freshly added → enabled for all targets");

    const flip = await httpJson<MutationResult>(url, "POST", `/skills/${alpha.id}/enabled`, { target: "mcp", on: false });
    assert.equal(flip.status, 200);
    assert.ok(flip.body.seq > add.body.seq, "the toggle bumps the read-model seq");

    const detail = await httpJson<SkillDetail>(url, "GET", `/skills/${alpha.id}`);
    assert.equal(detail.body.entry.enabledFor.mcp, false, "mcp toggled OFF; the read-path reflects it");
    assert.equal(detail.body.entry.enabledFor.lmstudio, true, "other targets untouched");
  });
});

test("health reports targets + reachability + the writer pid", async () => {
  await withDaemon(
    {
      home: mkTmp("skf-srv-health-"),
      clone: fakeClone(() => TWO_SKILLS),
      // LM Studio reachable, embeddings not configured.
      reachable: async (u: string) => u.includes("/v1/models"),
    },
    async (url) => {
      const h = await httpJson<HealthStatus>(url, "GET", "/health");
      assert.equal(h.status, 200);
      assert.equal(h.body.ok, true);
      assert.equal(h.body.writerPid, process.pid);
      assert.equal(h.body.lmStudioReachable, true);
      assert.equal(h.body.embeddingsReachable, false, "no provider configured → Tier-2 banner off");
      assert.equal(h.body.targets?.lmstudio?.live, true);
      assert.equal(h.body.targets?.mcp?.live, true, "MCP endpoint is always exposed (host-driven)");
      assert.equal(h.body.targets?.proxy?.live, false, "no proxy upstream configured");
    },
  );
});

test("PATCH /config deep-merges over HTTP: set embeddings, then a port patch PRESERVES it, then null CLEARS it", async () => {
  await withDaemon({ home: mkTmp("skf-srv-cfg-") }, async (url) => {
    const set = await httpJson<DaemonConfig>(url, "PATCH", "/config", { embeddings: PROVIDER });
    assert.deepEqual(set.body.embeddings, PROVIDER);

    const portPatch = await httpJson<DaemonConfig>(url, "PATCH", "/config", { port: 7777 });
    assert.equal(portPatch.body.port, 7777);
    assert.deepEqual(portPatch.body.embeddings, PROVIDER, "an omitted embeddings key PRESERVES Tier-2 (M-embed)");

    const clear = await httpJson<DaemonConfig>(url, "PATCH", "/config", { embeddings: null });
    assert.equal(clear.body.embeddings, undefined, "embeddings:null disables Tier-2");
  });
});

test("input over MAX_SOURCE_INPUT_LEN is rejected at the trust boundary (400, not a filesystem touch)", async () => {
  await withDaemon({ home: mkTmp("skf-srv-cap-"), clone: fakeClone(() => TWO_SKILLS) }, async (url) => {
    const res = await httpJson<{ error: string }>(url, "POST", "/sources", { input: "x".repeat(MAX_SOURCE_INPUT_LEN + 1) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid-input");
  });
});

// ── admission gate: CSRF / DNS-rebinding defence (CRITICAL) ───────────────────────────────────────────

test("admission gate: a NON-LOCAL Host header is refused (DNS-rebinding) → 403, no side effect", async () => {
  await withDaemon({ home: mkTmp("skf-srv-host-"), clone: fakeClone(() => TWO_SKILLS) }, async (url, daemon) => {
    const res = await rawRequest(daemon.port!, { path: "/health", headers: { host: "evil.example.com" } });
    assert.equal(res.status, 403, "a non-local Host (rebinding) is refused before routing");
    assert.match(res.body, /forbidden/);
  });
});

test("admission gate: a CROSS-ORIGIN simple POST is refused (CSRF) → 403 and addSource NEVER runs", async () => {
  await withDaemon({ home: mkTmp("skf-srv-csrf-"), clone: fakeClone(() => TWO_SKILLS) }, async (url, daemon) => {
    // a CORS-safelisted simple POST from a hostile page: local Host (default), cross-origin Origin.
    const res = await rawRequest(daemon.port!, {
      method: "POST",
      path: "/sources",
      headers: { origin: "http://evil.example.com", "content-type": "text/plain" },
      body: JSON.stringify({ input: "https://github.com/attacker/evil-skills" }),
    });
    assert.equal(res.status, 403, "a cross-origin POST is refused — CORS would NOT have stopped the side effect");
    // prove the side effect did NOT happen: no source was added.
    const sources = await httpJson<SourceRecord[]>(url, "GET", "/sources");
    assert.equal(sources.body.length, 0, "the hostile addSource never executed (no git clone, no default-enabled skills)");
  });
});

test("admission gate: a LOCAL request with NO Origin (the CLI) is admitted", async () => {
  await withDaemon({ home: mkTmp("skf-srv-cli-"), clone: fakeClone(() => TWO_SKILLS) }, async (url, daemon) => {
    const res = await rawRequest(daemon.port!, { path: "/health" }); // default Host 127.0.0.1:<port>, no Origin
    assert.equal(res.status, 200, "a local non-browser client (no Origin) is allowed");
  });
});

// ── route-test parity: the SAME selectWithEscalation the runtime uses (§6) ────────────────────────────

test("routeTest Tier-0 explicit ($slug): fires deterministically, no tierDisabled, injects the full body", async () => {
  await withDaemon({ home: mkTmp("skf-srv-rt0-"), clone: fakeClone(() => TWO_SKILLS) }, async (url) => {
    await httpJson(url, "POST", "/sources", { input: GIT_INPUT });
    const rt = await httpJson<RouteTestResult>(url, "POST", "/route-test", {
      target: "lmstudio",
      messages: [{ role: "user", content: "do the thing" }],
      explicit: "alpha",
    });
    assert.equal(rt.status, 200);
    assert.equal(rt.body.selection.mode, "explicit");
    assert.equal(rt.body.selection.chosen?.slug, "alpha");
    assert.equal(rt.body.tierDisabled, undefined, "explicit short-circuits BEFORE the Tier-2 degradation check");
    assert.equal(rt.body.injection.disclosure, "full", "a confident single match injects the body");
    assert.equal(rt.body.threshold.tier, "explicit");
  });
});

test("routeTest Tier-1 with NO provider: tierDisabled is VISIBLE (never a silent downgrade — M-embed)", async () => {
  await withDaemon({ home: mkTmp("skf-srv-rt1-"), clone: fakeClone(() => TWO_SKILLS) }, async (url) => {
    await httpJson(url, "POST", "/sources", { input: GIT_INPUT });
    const rt = await httpJson<RouteTestResult>(url, "POST", "/route-test", {
      target: "lmstudio",
      messages: [{ role: "user", content: "I want to resize an image" }],
    });
    assert.equal(rt.status, 200);
    assert.ok(rt.body.tierDisabled, "no embeddings provider ⇒ a visible tierDisabled signal");
    assert.equal(rt.body.tierDisabled?.tier, "semantic");
    assert.equal(rt.body.threshold.tier, rt.body.selection.mode, "threshold tier mirrors the firing tier");
  });
});

test("routeTest Tier-2 with an injected embedFetch: fires SEMANTIC and matches core.selectWithEscalation exactly (parity)", async () => {
  const embedFetch = fakeEmbedFetch(vecFor);
  await withDaemon(
    { home: mkTmp("skf-srv-rt2-"), clone: fakeClone(() => TWO_SKILLS), config: { embeddings: PROVIDER }, embedFetch },
    async (url, daemon) => {
      await httpJson(url, "POST", "/sources", { input: GIT_INPUT });
      const query = "I want to resize an image";
      const rt = await httpJson<RouteTestResult>(url, "POST", "/route-test", {
        target: "lmstudio",
        messages: [{ role: "user", content: query }],
      });
      assert.equal(rt.status, 200);
      assert.equal(rt.body.selection.mode, "semantic", "Tier-2 fired");
      assert.equal(rt.body.selection.chosen?.slug, "alpha", "the image-space query matched alpha semantically");
      assert.equal(rt.body.tierDisabled, undefined, "a configured + reachable provider ⇒ no degradation");
      assert.equal(rt.body.threshold.tier, "semantic");

      // PARITY: reproduce the EXACT runtime path (buildLexicalIndex → embeddingIndex →
      // selectWithEscalation → buildInjection) over the same enabled pool, WITH the SKILL.md bodies loaded
      // (so the injected `full` block matches byte-for-byte), and assert the daemon's selection AND
      // injection are byte-identical to a direct core call — "what you see in Test is what fires" (§6).
      const entries = daemon.persistence.store.list({ target: "lmstudio", enabledOnly: true });
      const pool: SkillManifest[] = entries.map((e) => ({
        schemaVersion: SCHEMA_VERSION,
        slug: e.slug,
        name: e.name,
        description: e.description,
        // strip frontmatter — IDENTICAL to the daemon's readInstructions + the plugin's loadInstructions,
        // so the reproduced `full` injection matches byte-for-byte (the frontmatter is metadata, not body).
        instructions: parseFrontmatter(fs.readFileSync(path.join(daemon.home, "sources", e.dir, "SKILL.md"), "utf8")).body,
        bodyLen: e.bodyLen,
        tokenEstimate: e.tokenEstimate,
        warnings: e.warnings,
        id: e.id,
        contentHash: e.contentHash,
        ...(e.embedding ? { embedding: e.embedding } : {}),
      }));
      const lexIndex = buildLexicalIndex(pool);
      const embeddingIndex = createEmbeddingIndex({ dim: PROVIDER.dim });
      await embeddingIndex.ensure(entries);
      const embedFn = createEmbedProvider(PROVIDER, embedFetch);
      const expected = await selectWithEscalation(query, { skills: pool, lexIndex, embeddingIndex, embedFn });
      const expectedInjection = buildInjection(expected.selection, pool, {
        maxTokens: 2000, // DEFAULT_ROUTE_TEST_MAX_TOKENS
        menuOnAmbiguous: true,
        maxMenuItems: 5, // DEFAULT_ROUTE_TEST_MAX_SKILLS
      });

      assert.equal(
        JSON.stringify({ selection: rt.body.selection, injection: rt.body.injection }),
        JSON.stringify({ selection: expected.selection, injection: expectedInjection }),
        "routeTest {selection, injection} == core.selectWithEscalation + buildInjection (byte-identical)",
      );
    },
  );
});

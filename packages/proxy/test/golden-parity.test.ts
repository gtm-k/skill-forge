// Golden PROXY-PATH parity (PLAN §8 / D5) — THE key deliverable: the proxy's HTTP /v1/chat/completions
// path is parity-IDENTICAL to core.select / selectWithEscalation over the SAME golden corpus. This is the
// THIRD inject-based parity path (path "c"), after the LM Studio plugin (a) and the daemon route-test (b).
//
// For each golden query we (1) reproduce core directly over the proxy's exact enabled pool (loadCatalog +
// loadInstructions — the SAME read-model round-trip the proxy uses internally), then (2) POST the message
// through the proxy to a MOCK UPSTREAM (X-Skill unset), and assert the EPHEMERAL system message the upstream
// received is BYTE-IDENTICAL to buildInjection's text for the skill core chose — and that NOTHING is injected
// (pure passthrough) exactly when core injects nothing. "What you would route is what the proxy forwards."
//
// Tier-2 is DISABLED here (no embeddings configured) — so every request also carries the VISIBLE degradation
// signal (X-Skill-Tier2: disabled + a select.log line), proving the proxy keeps routing on Tier 0/1 and never
// downgrades silently (M-embed). The Tier 0/1 A0 operating point itself is LOCKED by the daemon's golden test
// over this SAME corpus (packages/daemon/test/golden-parity.test.ts: the FROZEN per-positive A0_DECISIONS table
// + pinned A0_POSITIVE_CORRECT/A0_NEGATIVE_FALSE_FIRES). So this test's ONLY gating assertions are the
// byte-identity parity ones; the precision/false-fire numbers here are a non-gating console sanity line.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  loadCatalog,
  loadInstructions,
  buildLexicalIndex,
  tieredSelect,
  buildInjection,
} from "@skillforge/core";
import type { InjectionPolicy, SkillManifest } from "@skillforge/contracts";
import golden from "@skillforge/contracts/golden" with { type: "json" };
import { createProxyHandler } from "../src/index.ts";
import { startProxyServer } from "../src/server.ts";
import {
  buildGoldenHome,
  startMockUpstream,
  postChat,
  readSelectLog,
  cleanupHomes,
  type MockUpstream,
} from "./helpers.ts";

after(cleanupHomes);

const pos = golden.positives as { q: string; skill: string }[];
const neg = golden.negatives as string[];

// the proxy's select defaults == DEFAULT_ROUTE_TEST_* == DEFAULT_MAX_* (2000 / 5), so buildInjection is
// byte-comparable to the proxy's own injection.
const POLICY: InjectionPolicy = { maxTokens: 2000, menuOnAmbiguous: true, maxMenuItems: 5 };

/** Reproduce core (selection + injection) over the proxy's EXACT enabled pool, loading ONLY the chosen body
 *  the SAME way selectForProxy does — so the injection text is byte-for-byte what the proxy injects. */
function reproduceCore(home: string, q: string): { chosenSlug: string | null; injectedSlug: string | null; text: string; disclosure: string } {
  const catalog = loadCatalog(home, "proxy");
  const lexIndex = buildLexicalIndex(catalog.skills);
  const csel = tieredSelect(q, { skills: catalog.skills, lexIndex });
  const poolWithBody: SkillManifest[] = catalog.skills.map((s) => {
    if (!csel.chosen || s.slug !== csel.chosen.slug) return s;
    const dir = catalog.dirBySlug.get(s.slug);
    let instructions = "";
    try {
      instructions = dir ? loadInstructions(home, dir) : "";
    } catch {
      /* degraded body — matches the proxy's guarded load */
    }
    return { ...s, instructions, bodyLen: instructions.length, tokenEstimate: Math.ceil(instructions.length / 4) };
  });
  const cinj = buildInjection(csel, poolWithBody, POLICY);
  return {
    chosenSlug: csel.chosen?.slug ?? null,
    injectedSlug: cinj.disclosure === "none" ? null : cinj.injectedSlugs[0] ?? null,
    text: cinj.text,
    disclosure: cinj.disclosure,
  };
}

async function withProxy(
  home: string,
  fn: (proxyUrl: string, mock: MockUpstream) => Promise<void>,
): Promise<void> {
  const mock = await startMockUpstream();
  const handlers = createProxyHandler({ home, config: () => ({ schemaVersion: 1, port: 0, lmStudioBaseUrl: "http://127.0.0.1:1234", upstreams: { proxy: { chatBaseUrl: mock.url } } }) });
  const proxy = await startProxyServer(handlers, 0);
  try {
    await fn(proxy.url, mock);
  } finally {
    await proxy.close();
    await mock.close();
  }
}

/** The leading system message the upstream received, or null when none was prepended. */
function injectedSystem(mock: MockUpstream): { content: string } | null {
  const msgs = mock.last()?.body?.messages ?? [];
  const head = msgs[0];
  return head && head.role === "system" && typeof head.content === "string" ? { content: head.content } : null;
}

test("§8 PROXY parity path (c): the injected ephemeral system message == core.buildInjection over EVERY golden query", async () => {
  const home = buildGoldenHome();
  await withProxy(home, async (proxyUrl, mock) => {
    let positiveCorrect = 0;
    let falseFires = 0;

    const all: { q: string; expect?: string }[] = [
      ...pos.map((p) => ({ q: p.q, expect: p.skill })),
      ...neg.map((q) => ({ q })),
    ];

    for (const { q, expect } of all) {
      const core = reproduceCore(home, q);
      const res = await postChat(proxyUrl, { model: "m", messages: [{ role: "user", content: q }] });
      assert.equal(res.status, 200, `proxy HTTP 200 for ${JSON.stringify(q)}`);

      const header = res.headers.get("x-skill-injected");
      const sys = injectedSystem(mock);

      if (core.disclosure !== "none") {
        // PROXY INJECTED — byte-identity with core's injection, on the HTTP path.
        assert.equal(header, core.injectedSlug, `X-Skill-Injected != core injected slug for ${JSON.stringify(q)}`);
        assert.ok(sys, `expected an ephemeral system message at the upstream for ${JSON.stringify(q)}`);
        assert.equal(sys.content, core.text, `injected system content != core.buildInjection text for ${JSON.stringify(q)}`);
        assert.equal(mock.last()?.body?.messages?.length, 2, `expected [system, user] for ${JSON.stringify(q)}`);
        assert.equal(res.headers.get("x-skill-tier"), "lexical", "Tier 0/1 corpus routes on lexical (or explicit)");
      } else {
        // PROXY PASSED THROUGH — nothing injected, the user turn reaches the upstream untouched.
        assert.equal(header, "none", `expected no injection for ${JSON.stringify(q)}`);
        assert.equal(sys, null, `expected NO system message for a non-firing query ${JSON.stringify(q)}`);
        assert.equal(mock.last()?.body?.messages?.length, 1, `expected [user] only for ${JSON.stringify(q)}`);
      }

      if (expect !== undefined) {
        if (core.chosenSlug === expect) positiveCorrect++;
      } else if (core.disclosure !== "none") {
        falseFires++;
      }
    }

    // NON-GATING sanity line only (NOT an assertion): the authoritative routing-accuracy gate — the FROZEN
    // per-positive A0 decision table + the pinned precision/false-fire counts — lives in the daemon's golden
    // test (packages/daemon/test/golden-parity.test.ts) over THIS SAME corpus. This proxy test asserts ONE
    // thing: HTTP-path byte-identity with core.buildInjection. A precision/false-fire floor here would only
    // re-measure CORE's label accuracy (not proxy parity) and read as a weak gate — so it is logged, not asserted.
    const precision = positiveCorrect / pos.length;
    console.log(`  [sanity, non-gating] proxy precision@1 = ${positiveCorrect}/${pos.length} = ${(precision * 100).toFixed(0)}%; false-fires = ${falseFires}/${neg.length} (A0 routing accuracy is gated by the daemon golden test)`);
  });
});

test("§8 group 4 — Tier-2-DISABLED visibility: no embeddings ⇒ X-Skill-Tier2:disabled + a select.log line, still routes on Tier 0/1 (M-embed)", async () => {
  const home = buildGoldenHome(); // NO embeddings configured
  await withProxy(home, async (proxyUrl, mock) => {
    // a query that DOES fire on lexical Tier-1 — proving the proxy keeps routing while Tier-2 is disabled.
    const q = "design a distinctive, polished landing page UI";
    const res = await postChat(proxyUrl, { model: "m", messages: [{ role: "user", content: q }] });
    assert.equal(res.status, 200);

    // VISIBLE degradation signal on the response (never a silent downgrade).
    assert.equal(res.headers.get("x-skill-tier2"), "disabled", "X-Skill-Tier2 must signal the disabled semantic tier");
    assert.equal(res.headers.get("x-skill-injected"), "frontend-design", "still routed on Tier 0/1 (lexical) despite Tier-2 off");
    assert.equal(res.headers.get("x-skill-tier"), "lexical");
    assert.ok(injectedSystem(mock), "the lexical match was still injected as an ephemeral system message");

    // AND the same degradation is durable in the select log (the second observable place — actor-observability).
    const lines = readSelectLog(home);
    const line = lines[lines.length - 1]!;
    assert.equal(line.slug, "frontend-design");
    assert.equal(line.tier, "lexical");
    assert.equal(line.channel, "system-ephemeral");
    assert.ok(typeof line.tier2Disabled === "string" && (line.tier2Disabled as string).length > 0, "select.log records the Tier-2 disabled reason");
    assert.equal(line.injectedBytes, Buffer.byteLength(injectedSystem(mock)!.content, "utf8"), "logged injectedBytes == the measured injected bytes (D11)");
  });
});

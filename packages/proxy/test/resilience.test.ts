// Proxy RESILIENCE behavior (review self-repair W5): the outbound passthrough must never leak upstream work or
// hang the client, and non-fatal injection degradations must be observable (never silently swallowed).
//
//   • finding #1 — client abort mid-stream DESTROYS the upstream stream (no further upstream generation).
//   • finding #2 — a dead upstream (accepts the socket, never responds) fails with a VISIBLE, BOUNDED 504.
//   • finding #3 — a degraded chosen body surfaces a warning on BOTH the X-Skill-Warnings header AND select.log.
//
// All hermetic: node:http mocks (a slow SSE upstream + the real canned mock) and an injected hanging fetch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createProxyHandler, startProxyServer, type ChatFetch } from "../src/index.ts";
import { buildGoldenHome, startMockUpstream, postChat, readSelectLog, cleanupHomes } from "./helpers.ts";

after(cleanupHomes);

// ── a SLOW SSE upstream: emits frames on a timer and records whether the connection was closed EARLY ────────
interface SlowStreamUpstream {
  url: string;
  framesWritten(): number;
  closedEarly(): boolean;
  close(): Promise<void>;
}

function startSlowStreamUpstream(total = 40, intervalMs = 25): Promise<SlowStreamUpstream> {
  let written = 0;
  let closedEarly = false;
  let finishedAll = false;
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      let timer: ReturnType<typeof setInterval> | undefined;
      res.on("close", () => {
        if (!finishedAll) closedEarly = true; // the downstream (proxy) cancelled before we finished
        if (timer) clearInterval(timer);
      });
      // first frame immediately so the client can read EXACTLY one frame before it aborts.
      res.write(`data: ${JSON.stringify({ i: written })}\n\n`);
      written++;
      timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer);
          return;
        }
        if (written >= total) {
          finishedAll = true;
          clearInterval(timer);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ i: written })}\n\n`);
        written++;
      }, intervalMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        framesWritten: () => written,
        closedEarly: () => closedEarly,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// ── finding #1: client abort mid-stream destroys the upstream stream ────────────────────────────────────────
test("finding #1 — client abort mid-stream DESTROYS the upstream stream (the upstream stops generating)", async () => {
  const home = buildGoldenHome();
  const upstream = await startSlowStreamUpstream(40, 25); // ~1s full stream — plenty of room to abort after 1 frame
  const handlers = createProxyHandler({
    home,
    config: () => ({
      schemaVersion: 1,
      port: 0,
      lmStudioBaseUrl: "http://127.0.0.1:1234",
      upstreams: { proxy: { chatBaseUrl: upstream.url } },
    }),
  });
  const proxy = await startProxyServer(handlers, 0);
  try {
    const ac = new AbortController();
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "extract the text and tables from this PDF" }] }),
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.ok(res.body, "the proxy streamed the upstream body back");

    const reader = res.body.getReader();
    await reader.read(); // read EXACTLY one SSE frame, then disconnect.
    ac.abort();
    await reader.cancel().catch(() => {});

    // bounded wait for the upstream to OBSERVE the cancelled connection (never a fixed sleep).
    const deadline = Date.now() + 3000;
    while (!upstream.closedEarly() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.ok(upstream.closedEarly(), "the upstream connection was closed on client abort (the upstream stream was destroyed)");
    assert.ok(
      upstream.framesWritten() < 40,
      `the upstream STOPPED generating after the client aborted (wrote ${upstream.framesWritten()}/40) — no leak`,
    );
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ── finding #2: a dead upstream fails VISIBLY and is bounded by the deadline ─────────────────────────────────
test("finding #2 — a dead upstream (no response) surfaces a VISIBLE, BOUNDED 504 (never a hung socket)", async () => {
  const home = buildGoldenHome();
  // a fetch that NEVER resolves until its AbortSignal fires — the deadline must convert this into a 504.
  const hangingFetch: ChatFetch = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

  const handlers = createProxyHandler({
    home,
    config: () => ({
      schemaVersion: 1,
      port: 0,
      lmStudioBaseUrl: "http://127.0.0.1:1234",
      upstreams: { proxy: { chatBaseUrl: "http://127.0.0.1:9/v1" } }, // never actually contacted (fetch is faked)
    }),
    fetchImpl: hangingFetch,
    timeoutMs: 80, // a tiny deadline so the test is fast; proves the path, not the duration
  });
  const proxy = await startProxyServer(handlers, 0);
  try {
    const started = Date.now();
    const res = await postChat(proxy.url, { model: "m", messages: [{ role: "user", content: "extract text from PDF" }] });
    const elapsed = Date.now() - started;

    assert.equal(res.status, 504, "a timed-out upstream surfaces a visible 504 (never a silent hang)");
    assert.match(res.text, /upstream-timeout|timed out/, "the 504 body names the timeout reason");
    assert.ok(elapsed < 5000, `the request was BOUNDED by the deadline (took ${elapsed}ms), not left hanging`);
  } finally {
    await proxy.close();
  }
});

// ── finding #3: a degraded chosen body surfaces a warning in BOTH observable places ──────────────────────────
test("finding #3 — a degraded chosen body surfaces a warning on the X-Skill-Warnings header AND in select.log", async () => {
  const home = buildGoldenHome();
  // remove the body the query will route to → loadInstructions throws → the proxy degrades to a header-only
  // injection WITH a warning (rather than failing the request). The warning must be observable, not swallowed.
  fs.rmSync(path.join(home, "sources", "golden", "frontend-design", "SKILL.md"));

  const mock = await startMockUpstream();
  const handlers = createProxyHandler({
    home,
    config: () => ({
      schemaVersion: 1,
      port: 0,
      lmStudioBaseUrl: "http://127.0.0.1:1234",
      upstreams: { proxy: { chatBaseUrl: mock.url } },
    }),
  });
  const proxy = await startProxyServer(handlers, 0);
  try {
    const res = await postChat(proxy.url, { model: "m", messages: [{ role: "user", content: "design a distinctive, polished landing page UI" }] });
    assert.equal(res.status, 200, "a degraded body still completes the request (never a hard failure)");

    // place 1 — the bounded response header.
    const header = res.headers.get("x-skill-warnings");
    assert.ok(header && /degraded/i.test(header), `X-Skill-Warnings must surface the degradation (got ${JSON.stringify(header)})`);
    assert.match(header, /frontend-design/, "the warning names the affected skill");

    // place 2 — the durable select.log line.
    const line = readSelectLog(home).at(-1)!;
    assert.ok(Array.isArray(line.warnings) && (line.warnings as string[]).length > 0, "select.log records the warnings array");
    assert.match((line.warnings as string[]).join(" | "), /degraded/i, "the same degradation is durable in select.log");
  } finally {
    await proxy.close();
    await mock.close();
  }
});

// ── body cap (DETERMINISTIC 413 regression guard) ────────────────────────────────────────────────────────────
/** Raw HTTP POST → {status, headers, body}; rejects ONLY on a pre-response socket error. With a tiny over-cap
 *  body the upload completes before the 413 + close, so there is no close-during-upload TCP race and this
 *  resolves deterministically (fetch can't be used — it forbids reading a raw `connection` response header). */
function rawPost(
  port: number,
  p: string,
  body: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
        });
      },
    );
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

// This is the DETERMINISTIC proof that the proxy's over-cap path is req.pause() + a written 413 (NOT the old
// req.destroy() reset bug): with a SMALL cap the over-cap upload finishes immediately, so closing the socket
// after the 413 never races with a large in-flight upload (the inherent TCP race that makes the daemon
// adapters-mount 10MB integration assertion best-effort). A tolerate-reset test would NOT catch a regression
// to req.destroy() — under destroy the client would ALWAYS reset and a tolerate-reset test would still pass —
// so this guard asserts the readable 413 UNCONDITIONALLY, at a cap small enough that the race cannot occur.
test("body cap — an over-cap POST to /v1/chat/completions AND /v1/embeddings returns a READABLE 413 with connection:close (req.pause + 413, never req.destroy)", async () => {
  const SMALL_CAP = 256; // tiny cap ⇒ the over-cap upload finishes in one segment ⇒ no close-during-upload race
  const home = buildGoldenHome();
  const handlers = createProxyHandler({
    home,
    // a syntactically valid config so BOTH handlers reach the bounded body read: the chat handler needs an
    // upstream and the embeddings handler needs a provider, else each returns 502 BEFORE reading the body.
    // The over-cap body is rejected with 413 before any forward, so neither URL is ever contacted.
    config: () => ({
      schemaVersion: 1,
      port: 0,
      lmStudioBaseUrl: "http://127.0.0.1:1234",
      upstreams: { proxy: { chatBaseUrl: "http://127.0.0.1:1/v1" } },
      embeddings: { baseUrl: "http://127.0.0.1:1/v1", model: "fake", dim: 3 },
    }),
    maxBodyBytes: SMALL_CAP,
  });
  const proxy = await startProxyServer(handlers, 0);
  try {
    const over = "x".repeat(SMALL_CAP + 64); // just over the cap — delivered in one write, no in-flight backlog
    for (const path of ["/v1/chat/completions", "/v1/embeddings"]) {
      const res = await rawPost(proxy.port, path, over);
      assert.equal(res.status, 413, `${path}: the client RECEIVES the 413 (req.pause + write, never req.destroy)`);
      assert.match(res.body, /payload-too-large/, `${path}: and can read the typed body`);
      assert.equal(
        res.headers["connection"],
        "close",
        `${path}: the undrained socket is closed (no keep-alive reuse — slowloris/desync bound)`,
      );
    }
  } finally {
    await proxy.close();
  }
});

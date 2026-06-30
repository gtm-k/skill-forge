// @skillforge/daemon/test/static — the daemon serves the @skillforge/ui visual-manager console
// SINGLE-ORIGIN (PLAN §9, W5). Hermetic: an ephemeral loopback port + a throwaway home; no network, no
// LM Studio, no git. We assert the console is reachable from the daemon's own origin AND that the static
// serve is contained to web/ (a traversal escaping web/ is a 404, never a read outside the served tree).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createDaemon } from "../src/index.ts";
import { mkTmp, cleanup } from "./helpers.ts";

after(cleanup);

/** Raw HTTP GET (fetch normalizes `..` out of a path before sending; a raw request preserves it so we can
 *  prove the literal-traversal path is refused by routing, not silently normalized to something served). */
function rawGet(port: number, path: string): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, contentType: res.headers["content-type"] ?? "" }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withDaemon(fn: (port: number) => Promise<void>): Promise<void> {
  const daemon = createDaemon({ home: mkTmp("skf-static-"), port: 0, reachable: async () => false });
  const { port } = await daemon.start();
  try {
    await fn(port);
  } finally {
    await daemon.stop();
  }
}

test("daemon serves the console index.html at `/` (single-origin, text/html)", async () => {
  await withDaemon(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /SkillForge/, "the index shell renders the SkillForge console");
    assert.match(html, /\/web\/app\.js/, "the index references the SPA module");
  });
});

test("daemon serves the web/ assets (app.js as JS, styles.css as CSS)", async () => {
  await withDaemon(async (port) => {
    const js = await fetch(`http://127.0.0.1:${port}/web/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.ok((await js.text()).length > 0, "app.js is non-empty");

    const css = await fetch(`http://127.0.0.1:${port}/web/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const nosniff = js.headers.get("x-content-type-options");
    assert.equal(nosniff, "nosniff", "served assets carry X-Content-Type-Options: nosniff");
  });
});

test("static serve is contained to web/: a traversal escaping web/ is a 404 (never a read outside the tree)", async () => {
  await withDaemon(async (port) => {
    // (a) a LITERAL `..` traversal (raw request, not normalized by fetch) → no route / escape → 404.
    const literal = await rawGet(port, "/web/../../etc/passwd");
    assert.equal(literal.status, 404, "a literal ../.. traversal is refused, not served");

    // (b) an ENCODED traversal survives URL parsing as one segment, decodes to `../..`, and is refused by
    //     resolveUnderRoot under web/ — the SAME containment the ui precursor relies on.
    const encoded = await fetch(`http://127.0.0.1:${port}/web/%2e%2e%2f%2e%2e%2fpackage.json`);
    assert.equal(encoded.status, 404, "an encoded ../.. traversal escapes web/ → 404, never an outside read");

    // (c) a missing asset under web/ is an honest 404, not a silent empty 200.
    const missing = await fetch(`http://127.0.0.1:${port}/web/does-not-exist.js`);
    assert.equal(missing.status, 404);

    // (d) a MALFORMED percent-escape must be a CONTROLLED 404 — never an uncaught URIError out of the
    //     router (which would reject the handle() promise instead of replying). Raw request so the bad
    //     `%zz` reaches the server verbatim.
    const malformed = await rawGet(port, "/web/%zz");
    assert.equal(malformed.status, 404, "a malformed %-escape decodes to no-match → controlled 404, never a throw");
    const malformedParam = await rawGet(port, "/skills/%zz");
    assert.equal(malformedParam.status, 404, "a malformed `:param` escape is also a controlled 404, never a throw");
  });
});

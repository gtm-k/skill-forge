// @skillforge/daemon/test/url-source — the url front door's DEFERRED-LOUD `.zip` contract (W6).
//
// `.zip` ingest is intentionally NOT implemented this wave (a zero-dep ZIP reader is out of scope), but it
// must NEVER degrade to a silent empty tree: with no injected UnzipFn, core.resolveUrl throws a typed
// SourceResolveError, and the daemon surfaces that as a rejected addSource. Hermetic via an injected
// no-network url fetch (createDaemon's urlFetch) — no real HTTP.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { SourceResolveError } from "@skillforge/core";
import { createDaemon } from "../src/index.ts";
import { mkTmp, cleanup } from "./helpers.ts";

after(cleanup);

test("a url `.zip` source with NO injected UnzipFn fails LOUD (typed SourceResolveError), never a silent skip", async () => {
  const home = mkTmp("skf-url-zip-");
  // a no-network url fetch returning a `.zip` payload; createDaemon is given NO unzip injector.
  const urlFetch = async (_u: string): Promise<Response> =>
    new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200, headers: { "content-type": "application/zip" } });
  const daemon = createDaemon({ home, urlFetch });
  try {
    await assert.rejects(
      async () => daemon.ingest.addSource("https://example.com/skills.zip"),
      (err: unknown) => {
        // assert the TYPE (a typed, classifiable failure at the trust boundary), not just the message.
        assert.ok(err instanceof SourceResolveError, `expected a SourceResolveError, got ${err instanceof Error ? err.constructor.name : typeof err}`);
        assert.match(err.message, /UnzipFn|\.zip/i, "the error names the missing UnzipFn / the .zip payload");
        return true;
      },
    );
    assert.equal(daemon.persistence.store.skillCount(), 0, "nothing was ingested from the refused .zip source");
  } finally {
    await daemon.stop();
  }
});

test("a url `.md` source still ingests through the injected url fetch (the front door works for a supported payload)", async () => {
  const home = mkTmp("skf-url-md-");
  const urlFetch = async (_u: string): Promise<Response> =>
    new Response(`---\nname: Url Skill\ndescription: a single-file skill fetched over https for the funnel\n---\n# Url Skill\n\nA body comfortably past the placeholder threshold so routing is clean.\n`, {
      status: 200,
      headers: { "content-type": "text/markdown" },
    });
  const daemon = createDaemon({ home, urlFetch });
  try {
    const add = await daemon.ingest.addSource("https://example.com/url-skill.md");
    assert.equal(add.added, 1, "the .md url payload materialized one skill through the injected fetch (no network)");
    assert.equal(daemon.persistence.store.list()[0]!.slug, "url-skill", "slug derives from the url basename");
  } finally {
    await daemon.stop();
  }
});

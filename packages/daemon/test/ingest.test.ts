// @skillforge/daemon/test/ingest — the sourcing pipeline: preview (no commit), resync diff + grant
// revoke (D10), and the DB-from-sources crash rebuild. All hermetic via an injected fake CloneFn.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createDaemon } from "../src/index.ts";
import { gitCloneFn } from "../src/ingest/git-clone.ts";
import { manifestPath, dbPath } from "../src/home.ts";
import { mkTmp, cleanup } from "./helpers.ts";
import { fakeClone, type FixtureSkill } from "./server-helpers.ts";

after(cleanup);

const GIT_INPUT = "https://github.com/owner/repo";

test("gitCloneFn REFUSES an SSRF-prone remote (loopback / link-local / RFC-1918) BEFORE spawning git", async () => {
  for (const input of [
    "https://169.254.169.254/latest/meta-data.git", // cloud metadata IP
    "https://127.0.0.1/repo.git", // loopback
    "https://10.0.0.5/repo.git", // RFC-1918 private
    "https://[::1]/repo.git", // IPv6 loopback
  ]) {
    await assert.rejects(
      async () => gitCloneFn({ kind: "git", input }, mkTmp("skf-ssrf-")),
      /SSRF|refusing/i,
      `must refuse ${input}`,
    );
  }
});

test("folder ingestion REJECTS a UNC / network path (SMB auth / share exfiltration) — addSource + previewSource", async () => {
  const home = mkTmp("skf-unc-");
  const daemon = createDaemon({ home });
  try {
    for (const p of ["\\\\attacker.example.com\\share", "//attacker.example.com/share"]) {
      await assert.rejects(() => daemon.ingest.previewSource(p), /UNC|local filesystem/i, `preview must reject ${p}`);
      await assert.rejects(() => daemon.ingest.addSource(p), /UNC|local filesystem/i, `add must reject ${p}`);
    }
    assert.equal(daemon.persistence.store.skillCount(), 0, "nothing was ingested from a UNC path");
  } finally {
    await daemon.stop();
  }
});

test("addSource surfaces embeddingsSkipped when the provider is down (never-silent Tier-2 degradation, M-embed)", async () => {
  const home = mkTmp("skf-embskip-");
  // a provider that always returns a non-2xx → createEmbedProvider throws EmbeddingsUnavailable.
  const downEmbed = async (_url: string, _init: { body: string }): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => ({
    ok: false,
    status: 503,
    json: async (): Promise<unknown> => ({}),
  });
  const daemon = createDaemon({
    home,
    clone: fakeClone(() => [
      { slug: "alpha", name: "Alpha", description: "resize images" },
      { slug: "beta", name: "Beta", description: "parse csv" },
    ]),
    config: { embeddings: { baseUrl: "http://127.0.0.1:1234", model: "nomic", dim: 3 } },
    embedFetch: downEmbed,
  });
  try {
    const add = await daemon.ingest.addSource(GIT_INPUT);
    assert.equal(add.added, 2);
    assert.equal(add.embeddingsSkipped, 2, "the whole batch went lexical-only and the API consumer is told (never silent)");
    assert.ok(
      daemon.persistence.store.list().every((s) => !s.embedding),
      "no vectors were persisted when the provider was down (corpus stays single-model-consistent)",
    );
  } finally {
    await daemon.stop();
  }
});

test("previewSource commits NOTHING: returns the humble inventory, leaves DB + manifest untouched", async () => {
  const home = mkTmp("skf-ing-preview-");
  const daemon = createDaemon({
    home,
    clone: fakeClone(() => [
      { slug: "alpha", name: "Alpha", description: "resize images" },
      { slug: "beta", name: "Beta", description: "parse csv" },
    ]),
  });
  try {
    const preview = await daemon.ingest.previewSource(GIT_INPUT);
    assert.equal(preview.skillCount, 2, "preview reports the skills the source WOULD add");
    assert.equal(daemon.persistence.store.skillCount(), 0, "preview writes NOTHING to the DB");
    assert.equal(fs.existsSync(manifestPath(home)), false, "preview publishes NO manifest");
  } finally {
    await daemon.stop();
  }
});

test("addSource → resyncSource: reports capabilityChanges and AUTO-REVOKES a grant on a contentHash change (D10)", async () => {
  const home = mkTmp("skf-ing-resync-");
  let version: FixtureSkill[] = [{ slug: "alpha", name: "Alpha", description: "resize images" }];
  const daemon = createDaemon({ home, clone: fakeClone(() => version) });
  try {
    const add = await daemon.ingest.addSource(GIT_INPUT);
    const skills = daemon.persistence.store.list();
    const alpha = skills.find((s) => s.slug === "alpha")!;
    assert.equal(add.added, 1);
    assert.equal(alpha.capabilities.scriptCount, 0, "v1 carries no script");

    // grant exec on alpha (the W4 path would gate this; here we seed it directly to test the resync revoke).
    daemon.persistence.store.setExecAllowed(alpha.id, alpha.contentHash, true);
    assert.equal(daemon.persistence.store.get(alpha.id)!.execAllowed, true, "grant is active before the resync");

    // upstream drift: alpha gains a network-flagged script AND a changed body → new contentHash.
    version = [
      {
        slug: "alpha",
        name: "Alpha",
        description: "resize images",
        body: "Now fetches assets first.",
        script: { relPath: "run.sh", content: "#!/bin/sh\ncurl https://example.com/asset\n" },
      },
    ];
    const resync = await daemon.ingest.resyncSource(add.sourceId);

    assert.equal(resync.changed, 1, "alpha changed");
    assert.ok(resync.capabilityChanges && resync.capabilityChanges.length === 1, "resync reports the capability delta, not just a count");
    const change = resync.capabilityChanges![0]!;
    assert.equal(change.id, alpha.id);
    assert.equal(change.contentHashChanged, true);
    assert.equal(change.before.scriptCount, 0);
    assert.equal(change.after.scriptCount, 1, "the new script is reflected in the after-capabilities");

    assert.deepEqual(resync.revokedGrants, [alpha.id], "the contentHash change auto-revoked the exec grant (D10)");
    assert.equal(daemon.persistence.store.get(alpha.id)!.execAllowed, false, "the grant is OFF after the resync (re-review required)");
  } finally {
    await daemon.stop();
  }
});

test("rebuildFromSources: re-derives the DB from the materialized sources/ with STABLE skill ids (crash recovery)", async () => {
  const home = mkTmp("skf-ing-rebuild-");
  const clone = fakeClone(() => [
    { slug: "alpha", name: "Alpha", description: "resize images" },
    { slug: "beta", name: "Beta", description: "parse csv" },
  ]);

  const d1 = createDaemon({ home, clone });
  const add = await d1.ingest.addSource(GIT_INPUT);
  const idsBefore = d1.persistence.store
    .list()
    .map((s) => s.id)
    .sort();
  await d1.stop(); // closes the DB so it can be removed

  // simulate DB loss (the sources/ trees survive — they are self-contained and re-derivable, §5).
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(dbPath(home) + ext, { force: true });

  const d2 = createDaemon({ home, clone });
  try {
    assert.equal(d2.persistence.store.skillCount(), 0, "the rebuilt DB starts empty");
    const out = await d2.ingest.rebuildFromSources();
    assert.equal(out.rebuilt, 1, "one source tree was re-walked");
    assert.equal(out.skills, 2, "both skills re-ingested");
    const idsAfter = d2.persistence.store
      .list()
      .map((s) => s.id)
      .sort();
    assert.deepEqual(idsAfter, idsBefore, "rebuilt skill ids are IDENTICAL (sourceId dir name reproduces shortId)");
    // the re-derived source dir name IS the original sourceId.
    assert.ok(fs.existsSync(path.join(home, "sources", add.sourceId)), "the materialized tree was preserved across the rebuild");
  } finally {
    await d2.stop();
  }
});

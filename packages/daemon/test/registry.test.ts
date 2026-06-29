// @skillforge/daemon/test/registry — the W6 registry front door: the edge-spawn SAFETY guard + the
// end-to-end WIRING into ingest. Hermetic: the integration test injects a no-network fake resolver, and
// the default-resolver test refuses an unsafe token BEFORE any process is spawned (so npx never runs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createDaemon } from "../src/index.ts";
import {
  assertSafeRegistryToken,
  registryArgv,
  registryResolveFn,
  isPinnedPackageSpec,
  DEFAULT_REGISTRY_PACKAGE,
} from "../src/ingest/registry-resolve.ts";
import { mkTmp, cleanup } from "./helpers.ts";
import type { RegistryResolveFn } from "@skillforge/core";

after(cleanup);

test("assertSafeRegistryToken: accepts real registry identifiers", () => {
  for (const ok of ["cool-skill", "acme/cool-skill", "@acme/cool-skill", "name@1.2.3", "scope/name@2.0.0-beta.1", "a.b_c"]) {
    assert.doesNotThrow(() => assertSafeRegistryToken(ok), `should accept ${JSON.stringify(ok)}`);
  }
});

test("assertSafeRegistryToken: REFUSES injection / traversal / option tokens (the spawn never sees them)", () => {
  for (const bad of [
    "evil; rm -rf /", // command separator
    "name && curl evil", // shell chaining
    "$(whoami)", // command substitution
    "`id`", // backtick substitution
    "../../etc/passwd", // path traversal
    "name/../../escape",
    "-rf", // leading dash (option injection)
    "--registry=http://evil", // option injection
    "name with spaces",
    "name|tee", // pipe
    "a".repeat(215), // absurd length
    "", // empty
  ]) {
    assert.throws(() => assertSafeRegistryToken(bad), /unsafe registry token/i, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("registryArgv: array argv with the validated token as the FINAL positional (no shell, no interpolation)", () => {
  const { command, args } = registryArgv("acme/cool-skill");
  assert.match(command, /^npx(\.cmd)?$/, "spawns the npx shim");
  assert.deepEqual(args, ["--yes", DEFAULT_REGISTRY_PACKAGE, "add", "acme/cool-skill"], "the token is a single trailing argv element");
  assert.equal(args[args.length - 1], "acme/cool-skill", "token is last — never positioned where it could be read as an option");
});

test("registryArgv: VALIDATES the token itself (a direct caller can't build argv from an unsafe token)", () => {
  assert.throws(() => registryArgv("evil; rm -rf /"), /unsafe registry token/i);
  assert.throws(() => registryArgv("--registry=http://evil"), /unsafe registry token/i);
});

test("registryArgv: a PINNED package spec rides into the argv (supply-chain configurable, #7)", () => {
  const { args } = registryArgv("cool-skill", "@acme/skills-cli@1.4.2");
  assert.deepEqual(args, ["--yes", "@acme/skills-cli@1.4.2", "add", "cool-skill"], "the pinned scope@version is the npx package run");
});

test("isPinnedPackageSpec: a trailing @version is PINNED; a bare/scoped name with no version is NOT", () => {
  assert.equal(isPinnedPackageSpec("skills"), false, "bare name → @latest (unpinned)");
  assert.equal(isPinnedPackageSpec("@acme/skills"), false, "scoped, no version → @latest (unpinned)");
  assert.equal(isPinnedPackageSpec(DEFAULT_REGISTRY_PACKAGE), false, "the default spec is UNPINNED (warns at runtime)");
  assert.equal(isPinnedPackageSpec("skills@1.4.2"), true, "name@version → pinned");
  assert.equal(isPinnedPackageSpec("@acme/skills@1.0.0"), true, "scope/name@version → pinned");
});

test("the DEFAULT registry resolver refuses an unsafe token BEFORE spawning (the guard fires pre-process)", async () => {
  // assertSafeRegistryToken throws at the edge (mirroring gitCloneFn's safeUrl), so the resolver never
  // spawns npx for a hostile token. The async wrapper turns that edge throw into the rejection callers see
  // (resolveRegistry awaits the resolver, so a sync throw surfaces as a rejected addSource — never silent).
  await assert.rejects(
    async () => registryResolveFn({ kind: "registry", input: "evil; rm -rf /" }, mkTmp("skf-reg-guard-")),
    /unsafe registry token/i,
  );
});

test("WIRING: a bare token sniffs to a registry source and ingests through the INJECTED resolver (end to end)", async () => {
  const home = mkTmp("skf-reg-wire-");
  const fakeRegistry: RegistryResolveFn = async (ref, dest) => {
    // materialize a SKILL.md tree INTO dest (no network) — exactly what `npx skills add` would do.
    const dir = path.join(dest, ref.input.replace(/[^a-z0-9._-]/gi, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: Registry Skill\ndescription: a skill resolved from the registry front door for the funnel test\n---\n# Registry Skill\n\nA body long enough to clear the placeholder threshold comfortably.\n`,
    );
    return { version: "1.2.3" };
  };
  const daemon = createDaemon({ home, registry: fakeRegistry });
  try {
    const add = await daemon.ingest.addSource("acme/cool-skill"); // bare token → sniffs to kind "registry"
    assert.equal(add.added, 1, "the registry skill was materialized + ingested through the injected resolver");

    const skills = daemon.persistence.store.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.slug, "acme-cool-skill", "slug derives from the materialized dir name");

    const sources = daemon.ingest.listSources();
    assert.equal(sources[0]!.kind, "registry", "the source is recorded as a registry source (provenance)");
    // the materialized tree is committed under sources/<sourceId> (re-derivable on a crash rebuild).
    assert.ok(fs.existsSync(path.join(home, "sources", add.sourceId, "acme-cool-skill", "SKILL.md")), "tree committed under sources/");
  } finally {
    await daemon.stop();
  }
});

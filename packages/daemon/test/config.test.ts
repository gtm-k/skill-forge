// @skillforge/daemon/test/config — config.json load/save + the PATCH deep-merge contract (M-embed).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadConfig, saveConfig, applyPatch, defaultConfig, configPath } from "../src/config/config.ts";
import { mkTmp, cleanup } from "./helpers.ts";
import type { EmbeddingsProvider } from "@skillforge/contracts/api";

after(cleanup);

const PROVIDER: EmbeddingsProvider = { baseUrl: "http://127.0.0.1:1234", model: "nomic-embed", dim: 768 };

test("load/save round-trips and a missing config.json falls back to defaults", () => {
  const home = mkTmp("skf-cfg-");
  const fresh = loadConfig(home);
  assert.deepEqual(fresh, defaultConfig(), "absent config.json → defaults (never throws)");
  saveConfig(home, { ...fresh, port: 5005, embeddings: PROVIDER });
  const reloaded = loadConfig(home);
  assert.equal(reloaded.port, 5005);
  assert.deepEqual(reloaded.embeddings, PROVIDER);
});

test("a corrupt config.json reads as defaults (tolerant), never throws", () => {
  const home = mkTmp("skf-cfg-corrupt-");
  fs.writeFileSync(configPath(home), "{ not json");
  assert.deepEqual(loadConfig(home), defaultConfig());
});

test("PATCH deep-merge: embeddings:null CLEARS, omitted PRESERVES (M-embed — no silent Tier-2 downgrade)", () => {
  const withProvider = { ...defaultConfig(), embeddings: PROVIDER };

  // omitting `embeddings` must PRESERVE it (a missing key never disables Tier-2).
  const portOnly = applyPatch(withProvider, { port: 9000 });
  assert.equal(portOnly.port, 9000);
  assert.deepEqual(portOnly.embeddings, PROVIDER, "omitted embeddings is preserved");

  // explicit null CLEARS it.
  const cleared = applyPatch(withProvider, { embeddings: null });
  assert.equal(cleared.embeddings, undefined, "embeddings:null disables Tier-2");

  // an object REPLACES it.
  const replaced = applyPatch(withProvider, { embeddings: { ...PROVIDER, dim: 384 } });
  assert.equal(replaced.embeddings?.dim, 384);

  // the input is never mutated.
  assert.deepEqual(withProvider.embeddings, PROVIDER, "applyPatch returns a new config, never mutates input");
});

test("PATCH deep-merge: upstreams / defaults.enabledFor / trustLevels merge per-key", () => {
  const base = { ...defaultConfig(), upstreams: { proxy: { chatBaseUrl: "http://a" } }, defaults: { enabledFor: { mcp: false } } };
  const merged = applyPatch(base, {
    upstreams: { lmstudio: { chatBaseUrl: "http://b" } },
    defaults: { enabledFor: { proxy: false } },
    trustLevels: { src1: "confirm" },
  });
  assert.equal(merged.upstreams?.proxy?.chatBaseUrl, "http://a", "existing upstream key preserved");
  assert.equal(merged.upstreams?.lmstudio?.chatBaseUrl, "http://b", "new upstream key merged");
  assert.equal(merged.defaults?.enabledFor?.mcp, false, "existing enabledFor preserved");
  assert.equal(merged.defaults?.enabledFor?.proxy, false, "new enabledFor merged");
  assert.equal(merged.trustLevels?.src1, "confirm");
});

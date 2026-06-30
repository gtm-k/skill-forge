// Query-embedding provider (M-embed) — dim-checked /v1/embeddings call with an INJECTED fetch.
// Hermetic: no network. Verifies success, dim-mismatch, unreachable, non-200, and URL resolution.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbedProvider, resolveEmbeddingsUrl, EmbeddingsUnavailable, type FetchLike } from "@skillforge/core";

const provider = { baseUrl: "http://127.0.0.1:1234", model: "nomic-embed", dim: 4 };

function okFetch(embedding: number[]) {
  const calls: { url: string; body: { model: string; input: string[] } }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding }] }) };
  };
  return { fetchImpl, calls };
}

test("provider success: returns a dim-correct Float32Array + matches the /v1/embeddings request shape", async () => {
  const { fetchImpl, calls } = okFetch([0.1, 0.2, 0.3, 0.4]);
  const embed = createEmbedProvider(provider, fetchImpl, 1000);
  const vec = await embed("how do I parse a docx");

  assert.ok(vec instanceof Float32Array, "returns Float32Array");
  assert.equal(vec.length, 4, "dim 4");
  const v0 = vec[0];
  assert.ok(v0 !== undefined && Math.abs(v0 - 0.1) < 1e-6);
  assert.equal(calls.length, 1);
  const call0 = calls[0];
  assert.ok(call0, "captured the single embeddings call");
  assert.equal(call0.url, "http://127.0.0.1:1234/v1/embeddings", "posts to /v1/embeddings");
  assert.deepEqual(call0.body, { model: "nomic-embed", input: ["how do I parse a docx"] }, "request shape matches cli/embed.ts");
});

test("provider dim-mismatch: throws EmbeddingsUnavailable (never silently use a wrong-dim vector)", async () => {
  const { fetchImpl } = okFetch([0.1, 0.2, 0.3]); // dim 3 ≠ configured 4
  const embed = createEmbedProvider(provider, fetchImpl, 1000);
  await assert.rejects(() => embed("q"), (e) => e instanceof EmbeddingsUnavailable && /dim 3.*expected 4/.test(e.reason));
});

test("provider non-finite: a NaN/Infinity element → EmbeddingsUnavailable (would defeat the fire-gate)", async () => {
  for (const bad of [[0.1, NaN, 0.3, 0.4], [0.1, 0.2, Infinity, 0.4], [0.1, 0.2, 0.3, -Infinity]]) {
    const { fetchImpl } = okFetch(bad); // dim 4 (passes the dim check), but non-finite
    const embed = createEmbedProvider(provider, fetchImpl, 1000);
    await assert.rejects(() => embed("q"), (e) => e instanceof EmbeddingsUnavailable && /non-finite/.test(e.reason));
  }
});

test("provider unreachable: a thrown fetch becomes EmbeddingsUnavailable (visible, never swallowed)", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const embed = createEmbedProvider(provider, fetchImpl, 1000);
  await assert.rejects(() => embed("q"), (e) => e instanceof EmbeddingsUnavailable && /unreachable/.test(e.reason));
});

test("provider non-200: throws EmbeddingsUnavailable", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const embed = createEmbedProvider(provider, fetchImpl, 1000);
  await assert.rejects(() => embed("q"), (e) => e instanceof EmbeddingsUnavailable && /HTTP 503/.test(e.reason));
});

test("provider missing-data: throws EmbeddingsUnavailable", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  const embed = createEmbedProvider(provider, fetchImpl, 1000);
  await assert.rejects(() => embed("q"), EmbeddingsUnavailable);
});

test("resolveEmbeddingsUrl: tolerates base / /v1 / full-path / trailing slash", () => {
  assert.equal(resolveEmbeddingsUrl("http://h:1"), "http://h:1/v1/embeddings");
  assert.equal(resolveEmbeddingsUrl("http://h:1/"), "http://h:1/v1/embeddings");
  assert.equal(resolveEmbeddingsUrl("http://h:1/v1"), "http://h:1/v1/embeddings");
  assert.equal(resolveEmbeddingsUrl("http://h:1/v1/embeddings"), "http://h:1/v1/embeddings");
});

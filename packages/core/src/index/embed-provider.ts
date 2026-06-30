// @skillforge/core/index/embed-provider — the query-embedding call for Tier-2 (M-embed).
//
// One responsibility: turn a query string into a dim-checked Float32Array by POSTing to a configured
// OpenAI-compatible `/v1/embeddings` provider (nomic-embed). The provider is configured INDEPENDENTLY
// of any chat upstream (M-embed) — a chat model that can't serve embeddings must NOT silently disable
// Tier-2. On unreachable / timeout / non-200 / malformed / wrong-dim → throw a typed
// `EmbeddingsUnavailable`; the caller (escalate) turns that into a VISIBLE `tierDisabled` signal and
// NEVER swallows it. `fetch` is injected so the suite is hermetic (no network).

import type { EmbeddingsProvider } from "@skillforge/contracts/api";

/** Tier-2 could not produce a query vector. Carries a human `reason` the route-tester/Activity surface
 *  renders as the visible degradation (never a silent downgrade — M-embed). */
export class EmbeddingsUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "EmbeddingsUnavailable";
    this.reason = reason;
  }
}

/** Maps a query string to its embedding vector (Tier-2 input). Throws `EmbeddingsUnavailable`. */
export type EmbedFn = (query: string) => Promise<Float32Array>;

/** Minimal `fetch` shape we depend on — lets tests inject a fake without DOM lib types. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Resolve the provider base URL to the concrete `/v1/embeddings` endpoint, tolerating a baseUrl that
 *  already points at `/v1` or the full `/v1/embeddings` path. */
export function resolveEmbeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/v1\/embeddings$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/embeddings`;
  return `${trimmed}/v1/embeddings`;
}

interface EmbeddingsResponse {
  data?: { embedding?: number[] }[];
}

/**
 * Build an `EmbedFn` for a configured provider. Request shape matches cli/src/embed.ts
 * (`{ model, input: [text] }` → `{ data: [{ embedding }] }`). `timeoutMs` aborts a hung endpoint
 * (default 10s) → surfaced as `EmbeddingsUnavailable`. `fetchImpl` is injectable for tests.
 */
export function createEmbedProvider(
  provider: EmbeddingsProvider,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 10_000,
): EmbedFn {
  const url = resolveEmbeddingsUrl(provider.baseUrl);
  return async (query: string): Promise<Float32Array> => {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: provider.model, input: [query] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // Connection refused, DNS failure, or the abort timeout firing — all unreachable for Tier-2.
      throw new EmbeddingsUnavailable(
        `embeddings provider ${url} unreachable: ${(cause as Error)?.message ?? cause}`,
        { cause },
      );
    }
    if (!res.ok) {
      throw new EmbeddingsUnavailable(`embeddings provider ${url} returned HTTP ${res.status}`);
    }
    let json: EmbeddingsResponse;
    try {
      json = (await res.json()) as EmbeddingsResponse;
    } catch (cause) {
      throw new EmbeddingsUnavailable(`embeddings provider ${url} returned non-JSON`, { cause });
    }
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new EmbeddingsUnavailable(`embeddings provider ${url} returned no embedding`);
    }
    if (embedding.length !== provider.dim) {
      // Wrong-dim vectors would silently corrupt every cosine — refuse, surface visibly.
      throw new EmbeddingsUnavailable(
        `embeddings provider ${url} returned dim ${embedding.length}, expected ${provider.dim}`,
      );
    }
    // A NaN/Infinity element survives Float32Array and defeats the fire-gate (`NaN < θ` is false → a
    // wrong skill fires as a confident semantic match). Refuse non-finite embeddings at the boundary.
    if (!embedding.every((x) => Number.isFinite(x))) {
      throw new EmbeddingsUnavailable(`embeddings provider ${url} returned a non-finite embedding`);
    }
    return Float32Array.from(embedding);
  };
}

// @skillforge/lmstudio/embed — the query-embed MICRO-GATE for the semantic re-rank (A0-A).
//
// At ingest the CLI already embedded each skill (vectors live in the read-model). At runtime the plugin
// only needs to embed the CURRENT query, then cosine-rank it against those stored vectors. This is the
// one network touch in the selection path — and it is STRICTLY best-effort: if LM Studio's embeddings
// endpoint is down / busy / returns garbage, the embedder returns `undefined` and selection falls back
// to lexical + explicit (A0-A). It MUST NEVER throw — a degraded route is shown, never a crashed chat.
//
// Injected into selectAndInject so the test suite stays hermetic (a fake embedder, zero network).

/** Map a single query string to its embedding, or `undefined` on ANY failure (never throws). */
export type QueryEmbedder = (text: string) => Promise<number[] | undefined>;

/** Defaults match the CLI's ingest embedder so query + skill vectors share one model/space (A0-A). */
export const DEFAULT_EMBED_ENDPOINT = "http://127.0.0.1:1234/v1/embeddings";
export const DEFAULT_EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5";

/**
 * The real query embedder: POST {model, input:[text]} to an OpenAI-compatible /v1/embeddings endpoint
 * and return data[0].embedding. Uses the global fetch (Node 22 — no new dependency). EVERY failure path
 * (fetch throws / non-2xx / blocked / missing data) collapses to `undefined`: the micro-gate then falls
 * back to lexical+explicit selection rather than failing the turn. The fallback is OBSERVABLE downstream
 * — selectAndInject records the firing tier in inject.log.jsonl, so "embeddings were down" is visible.
 */
export function lmStudioQueryEmbedder(
  endpoint: string = DEFAULT_EMBED_ENDPOINT,
  model: string = DEFAULT_EMBED_MODEL,
): QueryEmbedder {
  return async (text: string): Promise<number[] | undefined> => {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: [text] }),
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: { embedding?: number[] }[] };
      const vec = json?.data?.[0]?.embedding;
      return Array.isArray(vec) ? vec : undefined;
    } catch {
      return undefined; // unreachable / blocked / malformed — degrade to lexical, never throw
    }
  };
}

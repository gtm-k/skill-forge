// @skillforge/cli/embed — ingest-time embeddings (A0-A), with the embedder INJECTABLE for tests.
//
// At `add` time we embed each skill's `${name}. ${description||slug}` text (the SAME formula the routing
// tests + Spike A0 use) and store the vectors in the read-model so the plugin can do a query-embed
// semantic re-rank with no model load of its own. The real embedder POSTs to a local LM Studio
// OpenAI-compatible endpoint; tests inject a deterministic fake so the suite is hermetic — NO network,
// NO LM Studio dependency.
//
// A0-A FALLBACK (never silent): an unreachable endpoint must NOT crash `add`. addSource catches the
// throw, records a warning, and writes the manifest WITHOUT vectors (routing then falls back to
// lexical + explicit selection). lmStudioEmbedder only throws here; the catch + warn lives in add.ts.

/** Maps a batch of texts to a batch of embedding vectors (one row per input, same order). */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** The model + dimensionality we stamp into the read-model when vectors were computed (A0-A). */
export const EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5";
export const EMBED_DIM = 768;

/** Default LM Studio embeddings endpoint (OpenAI-compatible). Surfaced so the fallback warning can name it. */
export const DEFAULT_EMBED_ENDPOINT = "http://127.0.0.1:1234/v1/embeddings";

/**
 * The real embedder: POST {model, input: texts} to an OpenAI-compatible `/v1/embeddings` endpoint and
 * return data.map(d => d.embedding). Uses the global fetch (Node 22, no new dependency). Throws on a
 * non-2xx response or a connection failure — addSource turns that throw into the A0-A warn-and-proceed.
 */
export function lmStudioEmbedder(endpoint = DEFAULT_EMBED_ENDPOINT, model = EMBED_MODEL): Embedder {
  return async (texts: string[]): Promise<number[][]> => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings endpoint ${endpoint} returned HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    if (!json.data) throw new Error(`embeddings endpoint ${endpoint} returned no data array`);
    return json.data.map((d) => d.embedding);
  };
}

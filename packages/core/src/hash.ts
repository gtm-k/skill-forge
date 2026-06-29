// @skillforge/core/hash — the one hashing primitive. contentHash is the GRANT key (D10):
// "you only run what you reviewed" is structural only if the hash is computed from on-disk
// bytes, canonicalized so re-ordering files can't change identity.
import { createHash } from "node:crypto";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable short identity, e.g. sha256(sourceId + relPath).slice(0,12). NUL-joined to avoid collisions. */
export function shortId(...parts: string[]): string {
  return sha256(parts.join("\0")).slice(0, 12);
}

/**
 * Canonical content hash over a bundle's per-file byte hashes. Sorted by relPath so the same
 * file set always yields the same hash regardless of walk order — this is the exec-grant key.
 *
 * The per-entry encoding MUST be injective: because this hash is the exec-grant key ("you only
 * run what you reviewed", D10/D20), two distinct bundle sets must never canonicalize to the same
 * string. A naive `relPath + ":" + hash` joined by "\n" is ambiguous when a relPath contains ":"
 * or a newline (e.g. {relPath:"a:b",hash:"c"} and {relPath:"a",hash:"b:c"} both yield "a:b:c").
 * We encode each entry as JSON.stringify([relPath, hash]) instead: JSON escapes quotes and control
 * chars (incl. newline) so neither field can forge the "," tuple boundary, and the join separator
 * "\n" can never appear literally inside a JSON-encoded entry — making the encoding collision-free
 * for arbitrary relPath/hash strings.
 */
export function bundleContentHash(entries: { relPath: string; hash: string }[]): string {
  const canon = [...entries]
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    .map((e) => JSON.stringify([e.relPath, e.hash]))
    .join("\n");
  return sha256(canon);
}

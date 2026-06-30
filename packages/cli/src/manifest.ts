// @skillforge/cli/manifest — read / merge / write the manifest.json read-model (§5, D7/D19).
//
// The read-model shape is OWNED by @skillforge/contracts (ManifestReadModel); we never deviate from it.
// All disk IO routes through core's Windows-safe primitives: atomicWriteFile (temp → fsync → atomic
// rename, never a half-written manifest) and readJsonTolerant (last-good fallback + prototype-pollution
// key stripping at the trust boundary). We do NOT re-implement either.
import { atomicWriteFile, readJsonTolerant } from "@skillforge/core";
import {
  SCHEMA_VERSION,
  type ManifestReadModel,
  type ManifestSkillEntry,
  type SkillManifest,
  type SourceKind,
  type SourceRef,
} from "@skillforge/contracts";
import { SOURCES_DIR_NAME } from "./home.ts";

/**
 * Build a ManifestSkillEntry from an enriched SkillManifest (the output of core.normalizeTree).
 *
 * `dir` is POSIX `<sourceId>/<sourceRelPath>` — i.e. RELATIVE TO sourcesDir ("sources"), the invariant
 * the contract documents. The materialized tree lives at home/sources/<sourceId>/, so a consumer that
 * resolves home/<sourcesDir>/<entry.dir> lands exactly on the skill dir. (A bare sourceRelPath would
 * point at home/sources/<sourceRelPath>, which does not exist once sources are nested per sourceId — a
 * silent "file not found" for the plugin/UI. See newDecisions.)
 *
 * enabledFor defaults ON for all three targets so a freshly-added skill fires out-of-the-box (the magic
 * moment); the UI toggles these later. execAllowed is always false (D2 — exec is gated behind an
 * explicit review that binds the grant to contentHash, D10).
 */
export function buildEntry(
  m: SkillManifest,
  ref: SourceRef,
  sourceId: string,
  embedding: number[] | undefined,
): ManifestSkillEntry {
  if (!m.id || !m.contentHash || !m.capabilities || m.sourceRelPath === undefined) {
    // normalizeTree always populates these; a gap means an upstream contract break — surface it.
    throw new Error(`incomplete normalized skill ${JSON.stringify(m.slug)}: missing id/contentHash/capabilities/sourceRelPath`);
  }
  const dir = m.sourceRelPath === "." ? sourceId : `${sourceId}/${m.sourceRelPath}`;

  const prov: { sourceId: string; kind: SourceKind; input: string; ref?: string } = {
    sourceId,
    kind: ref.kind,
    input: ref.input,
  };
  if (ref.ref !== undefined) prov.ref = ref.ref;

  const entry: ManifestSkillEntry = {
    id: m.id,
    slug: m.slug,
    name: m.name,
    description: m.description,
    dir,
    contentHash: m.contentHash,
    enabledFor: { lmstudio: true, mcp: true, proxy: true },
    execAllowed: false,
    capabilities: m.capabilities,
    bundle: m.bundle ?? [], // carry the per-file bundle for the UI Scripts/capability inspect (§9)
    warnings: m.warnings,
    bodyLen: m.bodyLen,
    tokenEstimate: m.tokenEstimate,
    provenance: [prov],
  };
  if (embedding !== undefined) entry.embedding = embedding;
  return entry;
}

export interface UpsertOptions {
  /** vectors computed this write → stamp the model/dim; absent → preserve whatever existed. */
  embeddingModel?: string;
  embeddingDim?: number;
  /** override generatedAt (tests pass a fixed value); defaults to now. */
  now?: string;
}

/**
 * Merge `entries` into `existing` BY id (same-id replaces, others retained), bump seq monotonically,
 * and stamp the read-model metadata. Defensive against a corrupt/partial prior manifest: a non-array
 * `skills` or non-numeric `seq` is treated as empty/zero rather than throwing.
 */
export function upsertManifest(
  existing: ManifestReadModel | undefined,
  entries: ManifestSkillEntry[],
  opts: UpsertOptions = {},
): ManifestReadModel {
  const priorSkills = Array.isArray(existing?.skills) ? existing.skills : [];
  const priorSeq = typeof existing?.seq === "number" ? existing.seq : 0;

  // Keyed by a Map (insertion-ordered): existing entries keep their slot but take the new value on a
  // same-id collision; genuinely-new skills append. id is a hex hash, but a Map also keeps us off the
  // Object.prototype-pollution surface as a matter of house style.
  const byId = new Map<string, ManifestSkillEntry>();
  for (const e of priorSkills) byId.set(e.id, e);
  for (const e of entries) byId.set(e.id, e);

  const model: ManifestReadModel = {
    schemaVersion: SCHEMA_VERSION,
    seq: priorSeq + 1,
    generatedAt: opts.now ?? new Date().toISOString(),
    sourcesDir: SOURCES_DIR_NAME,
    skills: [...byId.values()],
  };

  const embeddingModel = opts.embeddingModel ?? existing?.embeddingModel;
  const embeddingDim = opts.embeddingDim ?? existing?.embeddingDim;
  if (embeddingModel !== undefined) model.embeddingModel = embeddingModel;
  if (embeddingDim !== undefined) model.embeddingDim = embeddingDim;
  return model;
}

/** Last-good tolerant read of the read-model (undefined when absent/empty/corrupt). */
export function readManifest(manifestPath: string): ManifestReadModel | undefined {
  return readJsonTolerant<ManifestReadModel>(manifestPath);
}

/** Atomically publish the read-model (pretty-printed, trailing newline). */
export function writeManifest(manifestPath: string, model: ManifestReadModel): void {
  atomicWriteFile(manifestPath, `${JSON.stringify(model, null, 2)}\n`);
}

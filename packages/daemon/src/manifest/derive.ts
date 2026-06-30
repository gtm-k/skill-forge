// @skillforge/daemon/manifest/derive — derive the CQRS read-model (manifest.json) from the DB (§5/D19).
//
// The DB is the source of truth; manifest.json is a DERIVED, native-dep-free read-model (D9). This module
// is the CQRS read side: it reads the store and assembles a ManifestReadModel. Row → ManifestSkillEntry
// mapping (incl. the EXACT `dir` composition, enabledFor/execAllowed, capabilities/warnings/bundle,
// provenance, embedding, qualityScore) lives in the store's single `entryFromRow`/`list` mapper, so the
// read path is one implementation. derive only adds manifest-level metadata + the seq/dbRevision stamp.
//
// SEQ-HANDOFF INVARIANT (api.ts, load-bearing): seed `seq` from
//   max(existingManifest.seq ?? 0, store.seq) BEFORE stamping — a freshly-built DB (seq starting at 0)
// must never write a seq below the CLI's last manifest. We seed the STORE's floor (persisted) rather
// than just Math.max-ing the output, so the next mutation also stays above the CLI's last seq.
import { SCHEMA_VERSION, type ManifestReadModel } from "@skillforge/contracts";
import { SOURCES_DIR_NAME } from "../home.ts";
import type { SqliteSkillStore } from "../store/store.ts";

export interface DeriveOptions {
  /** the last published manifest (read tolerantly): its `seq` seeds the store's seq floor (SEQ-HANDOFF). */
  existingManifest?: ManifestReadModel | undefined;
  /** override the generatedAt stamp (tests pass a fixed value); defaults to now. */
  now?: string;
  /** relative location of the materialized trees written verbatim as `sourcesDir`; defaults to "sources". */
  sourcesDir?: string;
}

/** Derive a ManifestReadModel from the store. Seeds the seq floor from the existing manifest first. */
export function deriveReadModel(store: SqliteSkillStore, opts: DeriveOptions = {}): ManifestReadModel {
  if (opts.existingManifest && typeof opts.existingManifest.seq === "number") {
    store.seedSeqFloor(opts.existingManifest.seq);
  }
  const model: ManifestReadModel = {
    schemaVersion: SCHEMA_VERSION,
    seq: store.revision(),
    dbRevision: store.dbRevision(),
    generatedAt: opts.now ?? new Date().toISOString(),
    sourcesDir: opts.sourcesDir ?? SOURCES_DIR_NAME,
    skills: store.list(),
  };
  const meta = store.embeddingMeta();
  if (meta) {
    model.embeddingModel = meta.model;
    model.embeddingDim = meta.dim;
  }
  return model;
}

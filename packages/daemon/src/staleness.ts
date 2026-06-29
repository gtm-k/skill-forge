// @skillforge/daemon/staleness — surface a read-model that is out of date vs the DB (M-cqrs/D19).
//
// ACTOR-OBSERVABILITY: a daemon crash BETWEEN the DB write and the manifest rewrite leaves a stale
// enabled-pool on disk. BM25 IDF depends on that pool, so a stale pool diverges routing in ways the
// fixed-pool fixture harness cannot catch — therefore staleness must be OBSERVABLE at runtime, never
// silently served. This computes that signal; the server (later wave) emits it as the `staleness` SSE
// event { manifestSeq, daemonSeq, dbRevision }. The cardinal rule: NEVER report fresh when the DB does
// not actually back the manifest.
import type { ManifestReadModel } from "@skillforge/contracts";
import { manifestSkillFingerprint, type SqliteSkillStore } from "./store/store.ts";

export interface StalenessReport {
  /** true ⇒ the on-disk manifest does NOT reflect the current DB; a reader must not trust it blindly. */
  stale: boolean;
  manifestSeq: number;
  daemonSeq: number;
  dbRevision: number;
  /** human-readable cause (present when stale) — the observable signal, never a silent downgrade. */
  reason?: string;
}

/**
 * Compare the published manifest against the DB's read-model revision. Stale when:
 *  - no manifest published                  → nothing to serve yet.
 *  - manifestSeq > daemonSeq                → manifest is AHEAD of the DB (the DB regressed / lost a
 *                                             committed txn, e.g. a non-durable crash) — the read-model
 *                                             claims state the DB no longer has.
 *  - manifestSeq < daemonSeq                → the DB advanced; the read-model is not yet republished.
 *  - seq equal, dbRevision stamped + skew   → a crash BETWEEN the DB write and the manifest rewrite.
 *  - seq equal, dbRevision ABSENT (the CLI→daemon handoff) AND the DB's skill set does not match the
 *    manifest's → an UNVERIFIED handoff: the seq was seeded to the CLI's value but the DB does not yet
 *    back those skills. A seq match alone must NOT be reported fresh here.
 */
export function staleness(manifest: ManifestReadModel | undefined, store: SqliteSkillStore): StalenessReport {
  const daemonSeq = store.revision();
  const dbRevision = store.dbRevision();

  if (!manifest) {
    return {
      stale: true,
      manifestSeq: 0,
      daemonSeq,
      dbRevision,
      reason: "no manifest published yet — the DB has not been republished to the read-model",
    };
  }

  const manifestSeq = typeof manifest.seq === "number" ? manifest.seq : 0;
  if (manifestSeq > daemonSeq) {
    return {
      stale: true,
      manifestSeq,
      daemonSeq,
      dbRevision,
      reason: `manifest seq ${manifestSeq} is AHEAD of daemon seq ${daemonSeq} — the DB regressed/lost a committed txn; the read-model claims state the DB no longer holds`,
    };
  }
  if (manifestSeq < daemonSeq) {
    return {
      stale: true,
      manifestSeq,
      daemonSeq,
      dbRevision,
      reason: `manifest seq ${manifestSeq} is BEHIND daemon seq ${daemonSeq} — the DB advanced; the read-model is not yet republished`,
    };
  }

  // seq agrees — decide whether the DB actually backs this manifest.
  if (typeof manifest.dbRevision === "number") {
    if (manifest.dbRevision !== dbRevision) {
      return {
        stale: true,
        manifestSeq,
        daemonSeq,
        dbRevision,
        reason: `manifest dbRevision ${manifest.dbRevision} != daemon dbRevision ${dbRevision} — a crash between the DB write and the manifest rewrite`,
      };
    }
    return { stale: false, manifestSeq, daemonSeq, dbRevision };
  }

  // No dbRevision stamp ⇒ a CLI-written manifest (Phase 1) handed to the daemon. seq was seeded to its
  // value, but a matching seq does NOT prove the DB holds the same skills. Verify by fingerprint; report
  // an UNVERIFIED handoff when the sets diverge rather than trusting the seq alone (D19/M-cqrs, finding #4).
  const manifestFp = manifestSkillFingerprint(manifest.skills ?? []);
  if (manifestFp !== store.skillFingerprint()) {
    return {
      stale: true,
      manifestSeq,
      daemonSeq,
      dbRevision,
      reason: `unverified CLI→daemon handoff — manifest carries no dbRevision and the DB (${store.skillCount()} skills) does not back the manifest's ${(manifest.skills ?? []).length} skills; republish from the DB before serving`,
    };
  }
  return { stale: false, manifestSeq, daemonSeq, dbRevision };
}

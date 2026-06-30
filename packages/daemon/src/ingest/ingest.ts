// @skillforge/daemon/ingest — the sourcing pipeline the daemon owns (§5, D10/D14/D24, M-embed).
//
// Orchestration only — every load-bearing step is core's, injected at the edge:
//   sniffSource → resolveSource(ref, sources/<sourceId>, {clone:gitCloneFn, registry?, unzip?})
//   → normalizeTree → (embed each skill at ingest if a provider is configured) → store.upsert
//   → publishManifest → emit a `source` SSE event.
// The daemon adds exactly the edge capabilities core refuses to hold: the git spawn (ingest/git-clone)
// and the network embed (createEmbedProvider). Both are injectable so the suite runs offline/hermetic.
//
// FOLDER sources are read IN PLACE by resolveSource (a W2 decision), so the daemon copies the tree into
// sources/<sourceId> itself (mirroring the CLI's materializeFolder). git/registry/url materialize into a
// staging dir that is atomically renamed to sources/<sourceId>. W6 wires the REGISTRY injector (the real
// `npx skills` edge spawn — ingest/registry-resolve.ts); the url `.zip` UnzipFn stays DEFERRED-LOUD (no
// injector ⇒ resolveUrl throws a typed SourceResolveError, never a silent empty tree). Every injector is
// still overridable per call so the suite runs offline/hermetic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  sniffSource,
  resolveSource,
  normalizeTree,
  buildSourcePreview,
  walkSkillDirs,
  createEmbedProvider,
  EmbeddingsUnavailable,
  resolveUnderRoot,
  assertNoSymlinkEscape,
  readJsonTolerant,
  type CloneFn,
  type RegistryResolveFn,
  type UnzipFn,
  type SourceInjectors,
} from "@skillforge/core";
import type {
  CapabilityChange,
  AddSourceResult,
  ResyncResult,
  SourcePreview,
  SourceRecord,
  DaemonConfig,
} from "@skillforge/contracts/api";
import type { FetchedTree, ManifestSkillEntry, ManifestReadModel, SkillCapabilities, SkillManifest, SourceRef } from "@skillforge/contracts";
import { SqliteSkillStore, TARGETS } from "../store/store.ts";
import { sourcesPath, manifestPath } from "../home.ts";
import type { EventBus } from "../server/events.ts";

/** Injected url fetch shape (the SourceInjectors.fetchImpl — distinct from the embeddings FetchLike). */
type UrlFetch = NonNullable<SourceInjectors["fetchImpl"]>;

/** Injected fetch shape for the embeddings provider — derived from createEmbedProvider's signature (the
 *  source of truth; equals core's exported FetchLike now that the url/embed fetch types are disambiguated). */
type EmbedFetch = NonNullable<Parameters<typeof createEmbedProvider>[1]>;

export interface IngestDeps {
  home: string;
  store: SqliteSkillStore;
  /** derive + atomically publish manifest.json from the DB (createPersistence.publishManifest). */
  publishManifest: (now?: string) => ManifestReadModel;
  events: EventBus;
  /** live config accessor — embeddings provider + enable defaults are read fresh on each ingest. */
  config: () => DaemonConfig;
  /** the edge git clone (defaults to the real system git spawn). */
  clone?: CloneFn;
  /** registry resolver (optional; W6 — absent ⇒ resolveSource throws on a registry source). */
  registry?: RegistryResolveFn;
  /** unzip for `.zip` url payloads (optional; W6 — absent ⇒ resolveUrl throws on a `.zip`, never silent). */
  unzip?: UnzipFn;
  /** injected url fetch for `url` sources (tests pass a no-network fixture; defaults to the global fetch). */
  urlFetch?: UrlFetch;
  /** injected fetch for the embeddings provider (tests pass a hermetic fake). */
  embedFetch?: EmbedFetch;
  /** clock override (tests pin timestamps). */
  now?: () => string;
}

export interface Ingest {
  addSource(input: string, ref?: SourceRef): Promise<AddSourceResult>;
  previewSource(input: string, ref?: SourceRef): Promise<SourcePreview>;
  resyncSource(sourceId: string): Promise<ResyncResult>;
  removeSource(sourceId: string): { seq: number };
  listSources(): SourceRecord[];
  rebuildFromSources(): Promise<{ rebuilt: number; skills: number }>;
}

/** Embed text formula — the SAME `${name}. ${description||slug}` the CLI ingest + Spike A0 use (A0-A). */
function embedText(m: SkillManifest): string {
  return `${m.name}. ${m.description || m.slug}`;
}

/** Deep-equal two capability inventories (small, fixed-shape — JSON compare is exact + cheap). */
function capsEqual(a: SkillCapabilities, b: SkillCapabilities): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Refuse a UNC / network path as a FOLDER source (leading `\\` or `//`). On Windows a UNC path
 * `\\attacker.com\share` triggers SMB authentication (NTLMv2 hash leak), and any external share path lets
 * a malicious page exfiltrate a directory tree via previewSource alone. Folder sources are kept to LOCAL
 * filesystem paths; a remote tree must come through the git/url front doors (which are HTTPS+SSRF-guarded).
 */
function assertNotUncFolder(input: string): void {
  if (/^[\\/]{2}/.test(input.trim())) {
    throw new Error(
      `refusing a UNC / network path as a folder source: ${JSON.stringify(input)} — folder sources must be a LOCAL filesystem path ` +
        `(a UNC path can trigger SMB auth / an NTLM hash leak, or exfiltrate an external share)`,
    );
  }
}

export function createIngest(deps: IngestDeps): Ingest {
  const now = deps.now ?? (() => new Date().toISOString());

  /** The injector bundle handed to resolveSource for every kind. */
  function injectors(): SourceInjectors {
    const inj: SourceInjectors = {};
    if (deps.clone) inj.clone = deps.clone;
    if (deps.registry) inj.registry = deps.registry;
    if (deps.unzip) inj.unzip = deps.unzip;
    if (deps.urlFetch) inj.fetchImpl = deps.urlFetch;
    return inj;
  }

  /** Resolve the realpath'd sources/ root under home, creating it (containment-checked). */
  function ensureSourcesRoot(): { realHome: string; srcDir: string } {
    fs.mkdirSync(deps.home, { recursive: true });
    const realHome = fs.realpathSync(deps.home);
    const srcDir = resolveUnderRoot(realHome, "sources");
    fs.mkdirSync(srcDir, { recursive: true });
    assertNoSymlinkEscape(realHome, "sources");
    return { realHome, srcDir };
  }

  /**
   * Materialize `ref` into home/sources/<sourceId> and return the tree re-rooted at the committed copy.
   * folder: resolveSource reads in place → copy the tree in (dereference:false so a link cannot smuggle
   * external bytes; normalizeTree skips symlinks anyway). git/registry/url: resolve into a staging dir,
   * then atomically rename staging → sources/<sourceId> (same volume → atomic), re-rooting at whatever
   * subdir resolveSource selected. Every write target is containment-checked against the sources root.
   */
  async function materialize(ref: SourceRef): Promise<FetchedTree> {
    const { srcDir } = ensureSourcesRoot();

    if (ref.kind === "folder") {
      assertNotUncFolder(ref.input); // no UNC / network share as a folder source (covers add + resync)
      const probe = await resolveSource(ref, "", injectors());
      const dest = resolveUnderRoot(srcDir, probe.sourceId);
      assertNoSymlinkEscape(srcDir, probe.sourceId);
      fs.rmSync(dest, { recursive: true, force: true }); // re-add replaces a prior materialization
      fs.cpSync(probe.root, dest, { recursive: true, dereference: false });
      return { sourceId: probe.sourceId, root: dest, skillDirs: probe.skillDirs, ref };
    }

    const staging = resolveUnderRoot(srcDir, `.staging-${randomUUID()}`);
    try {
      const probe = await resolveSource(ref, staging, injectors());
      const dest = resolveUnderRoot(srcDir, probe.sourceId);
      assertNoSymlinkEscape(srcDir, probe.sourceId);
      // record where the resolver re-rooted (e.g. a git subdir) RELATIVE to staging, before the rename.
      const rel = path.relative(staging, probe.root);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(staging, dest);
      const root = rel && rel !== "" ? resolveUnderRoot(dest, rel) : dest;
      return { sourceId: probe.sourceId, root, skillDirs: probe.skillDirs, ref };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true }); // best-effort: gone after a successful rename
    }
  }

  /**
   * Embed every manifest in place (set `.embedding`) when a provider is configured. NEVER fatal (A0-A /
   * M-embed): an unreachable/misconfigured provider is caught and ingest proceeds WITHOUT vectors
   * (routing falls back to lexical+explicit). Returns the model tag (when vectors were computed) AND the
   * count of skills whose embedding was SKIPPED, so addSource can surface the degradation (never-silent).
   */
  async function embedAtIngest(manifests: SkillManifest[]): Promise<{ model?: string; skipped: number }> {
    const provider = deps.config().embeddings;
    if (!provider || manifests.length === 0) return { skipped: 0 }; // no provider ⇒ not a degradation
    const embed = createEmbedProvider(provider, deps.embedFetch);
    try {
      for (const m of manifests) {
        const vec = await embed(embedText(m));
        m.embedding = Array.from(vec);
      }
      return { model: provider.model, skipped: 0 };
    } catch (e) {
      if (e instanceof EmbeddingsUnavailable) {
        for (const m of manifests) delete m.embedding; // drop partials → corpus stays single-model-consistent
        console.warn(`[skillforge/daemon] embeddings unavailable at ingest — ${e.reason}; stored without vectors`);
        return { skipped: manifests.length }; // the WHOLE batch went lexical-only — report it
      }
      throw e; // never swallow an unexpected error
    }
  }

  function buildSourceRecord(ref: SourceRef, sourceId: string, skillCount: number): SourceRecord {
    const rec: SourceRecord = { sourceId, kind: ref.kind, input: ref.input, skillCount, addedAt: now(), status: "ok" };
    if (ref.ref !== undefined) rec.ref = ref.ref;
    if (ref.subdir !== undefined) rec.subdir = ref.subdir;
    return rec;
  }

  function upsertOpts(embeddingModel: string | undefined) {
    const enabledFor = deps.config().defaults?.enabledFor;
    return {
      ...(embeddingModel ? { embeddingModel } : {}),
      ...(enabledFor ? { defaultEnabledFor: enabledFor } : {}),
    };
  }

  return {
    async addSource(input: string, ref?: SourceRef): Promise<AddSourceResult> {
      const sref = ref ?? sniffSource(input);
      const tree = await materialize(sref);
      const manifests = await normalizeTree(tree);
      const emb = await embedAtIngest(manifests);

      const src = buildSourceRecord(sref, tree.sourceId, manifests.length);
      deps.store.upsert(manifests, src, upsertOpts(emb.model));
      const model = deps.publishManifest();
      deps.events.emit({ type: "source", ts: now(), data: { sourceId: tree.sourceId, status: "ok", changed: manifests.length } });
      const result: AddSourceResult = { sourceId: tree.sourceId, added: manifests.length, seq: model.seq };
      if (emb.skipped > 0) result.embeddingsSkipped = emb.skipped; // never-silent Tier-2 degradation signal
      return result;
    },

    async previewSource(input: string, ref?: SourceRef): Promise<SourcePreview> {
      // Commit NOTHING: resolve into a throwaway temp dir (folder reads in place), normalize, build the
      // humble inventory, delete. No store write, no manifest publish, no SSE event.
      const sref = ref ?? sniffSource(input);
      if (sref.kind === "folder") assertNotUncFolder(sref.input); // preview must not touch a UNC share either
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skf-preview-"));
      try {
        const tree = await resolveSource(sref, sref.kind === "folder" ? "" : tmp, injectors());
        const manifests = await normalizeTree(tree);
        return buildSourcePreview(sref, manifests);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },

    async resyncSource(sourceId: string): Promise<ResyncResult> {
      // 1) snapshot the OLD skills of this source (full entries → caps + contentHash + execAllowed).
      const beforeIds = deps.store.skillIdsForSource(sourceId);
      const before = new Map(beforeIds.map((id) => [id, deps.store.get(id)!] as const));

      // 2) re-resolve from the STORED SourceRef (re-clone / re-copy) and re-normalize.
      const stored = readStoredRecord(deps.store, sourceId);
      if (!stored) throw new Error(`cannot resync unknown source ${JSON.stringify(sourceId)}`);
      const ref = refOf(stored);
      const tree = await materialize(ref);
      const manifests = await normalizeTree(tree);
      const emb = await embedAtIngest(manifests);
      const after = new Map(manifests.map((m) => [m.id!, m] as const));

      // 3) diff: changed (caps or contentHash differ), added, removed, and exec grants auto-revoked (D10).
      const capabilityChanges: CapabilityChange[] = [];
      const revokedGrants: string[] = [];
      let changed = 0;
      let added = 0;
      for (const m of manifests) {
        const old = before.get(m.id!);
        if (!old) {
          added++;
          continue;
        }
        const hashChanged = old.contentHash !== m.contentHash;
        const capsChanged = !capsEqual(old.capabilities, m.capabilities ?? old.capabilities);
        if (hashChanged || capsChanged) {
          changed++;
          capabilityChanges.push({ id: m.id!, slug: m.slug, before: old.capabilities, after: m.capabilities ?? old.capabilities, contentHashChanged: hashChanged });
        }
        if (hashChanged && old.execAllowed) revokedGrants.push(m.id!);
      }
      const removedIds = beforeIds.filter((id) => !after.has(id));

      // 4) commit: upsert the new set, drop disappeared skills, rebind any revoked grant to the NEW hash
      //    with exec_allowed=0 (so a later content REVERT cannot silently re-activate a stale grant — D10).
      const src = buildSourceRecord(ref, sourceId, manifests.length);
      src.lastSynced = now();
      deps.store.upsert(manifests, src, upsertOpts(emb.model));
      for (const id of removedIds) deps.store.remove(id);
      for (const id of revokedGrants) {
        const m = after.get(id);
        if (m?.contentHash) deps.store.setExecAllowed(id, m.contentHash, false);
      }

      const model = deps.publishManifest();
      deps.events.emit({ type: "source", ts: now(), data: { sourceId, status: "ok", changed } });
      return { sourceId, changed, added, removed: removedIds.length, revokedGrants, capabilityChanges, seq: model.seq };
    },

    removeSource(sourceId: string): { seq: number } {
      for (const id of deps.store.skillIdsForSource(sourceId)) deps.store.remove(id);
      deps.store.deleteSourceRow(sourceId);
      try {
        fs.rmSync(resolveUnderRoot(sourcesPath(deps.home), sourceId), { recursive: true, force: true });
      } catch {
        /* the DB rows are gone; a stray tree dir is harmless and recoverable */
      }
      const model = deps.publishManifest();
      deps.events.emit({ type: "source", ts: now(), data: { sourceId, status: "ok" } });
      return { seq: model.seq };
    },

    listSources(): SourceRecord[] {
      return deps.store.listSourceRows().map((row) => {
        const stored = safeParseRecord(row.ref_json);
        const skillCount = deps.store.countSkillsForSource(row.id); // live from the DB (stored count can be stale)
        const rec: SourceRecord = {
          sourceId: row.id,
          kind: (stored?.kind ?? row.kind) as SourceRecord["kind"],
          input: stored?.input ?? "",
          skillCount, // recomputed live from the DB (the stored count can be stale)
          addedAt: row.added_at,
          status: (row.status as SourceRecord["status"]) ?? "ok",
        };
        if (stored?.ref !== undefined) rec.ref = stored.ref;
        if (stored?.subdir !== undefined) rec.subdir = stored.subdir;
        if (row.last_synced) rec.lastSynced = row.last_synced;
        if (stored?.error) rec.error = stored.error;
        return rec;
      });
    },

    async rebuildFromSources(): Promise<{ rebuilt: number; skills: number }> {
      // CRASH RECOVERY (§5): the DB is re-derivable by re-walking sources/. Each sources/<sourceId> dir is
      // a self-contained tree whose dir name IS the original sourceId, so shortId(sourceId, relPath)
      // reproduces identical skill ids. The original SourceRef (kind/input) is unrecoverable once the DB
      // is gone, so a synthetic folder record is recorded (provenance is degraded but functional).
      //
      // ENABLE/GRANT STATE must NOT fail OPEN (§6 "worse than none"): a fresh upsert re-seeds every skill to
      // all-enabled (DEFAULT_ENABLED), which would silently RE-ENABLE a skill the user had DISABLED (a
      // known-bad). The last-good read-model (manifest.json) survives a DB-loss crash and carries the user's
      // per-skill enabledFor + execAllowed, so we restore from it by stable id: enable toggles verbatim (a
      // user preference, incl. disables), and exec grants ONLY where the rebuilt bytes still match the
      // granted contentHash (a content change since the crash fails CLOSED — re-review required, D10).
      const survivor = readJsonTolerant<ManifestReadModel>(manifestPath(deps.home));
      const priorById = new Map<string, ManifestSkillEntry>();
      for (const e of survivor?.skills ?? []) if (e?.id) priorById.set(e.id, e);

      const root = sourcesPath(deps.home);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return { rebuilt: 0, skills: 0 };
      }
      let rebuilt = 0;
      let skills = 0;
      for (const d of entries) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue; // skip staging dirs / dotfiles
        const dir = resolveUnderRoot(root, d.name);
        const skillDirs = await walkSkillDirs(dir);
        if (skillDirs.length === 0) continue;
        const tree: FetchedTree = { sourceId: d.name, root: dir, skillDirs, ref: { kind: "folder", input: d.name } };
        const manifests = await normalizeTree(tree);
        if (manifests.length === 0) continue;
        const src: SourceRecord = { sourceId: d.name, kind: "folder", input: d.name, skillCount: manifests.length, addedAt: now(), status: "ok" };
        deps.store.upsert(manifests, src);

        // restore the surviving read-model's per-skill enable + (hash-matched) exec grant — never fail open.
        for (const m of manifests) {
          const prior = m.id ? priorById.get(m.id) : undefined;
          if (!prior) continue;
          for (const t of TARGETS) {
            const on = prior.enabledFor?.[t];
            if (typeof on === "boolean") deps.store.setEnabled(m.id!, t, on); // user preference, incl. disables
          }
          if (prior.execAllowed && m.contentHash && prior.contentHash === m.contentHash) {
            deps.store.setExecAllowed(m.id!, m.contentHash, true); // grant survives ONLY if bytes still match (D10)
          }
        }
        rebuilt++;
        skills += manifests.length;
      }
      if (rebuilt > 0) deps.publishManifest();
      return { rebuilt, skills };
    },
  };
}

// ── helpers (DB row → SourceRecord/SourceRef) ────────────────────────────────────────────────────────
function safeParseRecord(json: string): Partial<SourceRecord> | undefined {
  try {
    return JSON.parse(json) as Partial<SourceRecord>;
  } catch {
    return undefined;
  }
}

function readStoredRecord(store: SqliteSkillStore, sourceId: string): Partial<SourceRecord> | undefined {
  const row = store.getSourceRow(sourceId);
  if (!row) return undefined;
  const rec = safeParseRecord(row.ref_json) ?? {};
  if (!rec.kind) rec.kind = row.kind as SourceRecord["kind"];
  return rec;
}

function refOf(rec: Partial<SourceRecord>): SourceRef {
  const ref: SourceRef = { kind: (rec.kind ?? "folder") as SourceRef["kind"], input: rec.input ?? "" };
  if (rec.ref !== undefined) ref.ref = rec.ref;
  if (rec.subdir !== undefined) ref.subdir = rec.subdir;
  return ref;
}

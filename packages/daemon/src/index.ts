// @skillforge/daemon — the persistence half of the local daemon (PLAN Phase 2, W1a).
//
// SCOPE: store (SQLite/WAL CQRS write side) + manifest derive (CQRS read side) + writer lock + staleness.
// The HTTP server / ingest / routes are a LATER wave and consume `createPersistence` — this barrel is the
// skeleton they wire onto. All disk IO for the read-model reuses core's Windows-safe atomicWriteFile +
// readJsonTolerant (never a half-written / non-tolerant manifest); SQLite stays confined to the daemon
// (D9/D25) behind node:sqlite (run under --experimental-sqlite).
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile, readJsonTolerant } from "@skillforge/core";
import type { CloneFn, RegistryResolveFn, UnzipFn, SourceInjectors } from "@skillforge/core";
import type { ManifestReadModel } from "@skillforge/contracts";

/** Injected url fetch shape (the SourceInjectors.fetchImpl — distinct from the embeddings FetchLike). */
type UrlFetch = NonNullable<SourceInjectors["fetchImpl"]>;
import type { DaemonConfig, PatchConfigRequest } from "@skillforge/contracts/api";
import { manifestPath as manifestPathOf, dbPath, writerPidPath, skillforgeHome } from "./home.ts";
import { openStore, type SqliteSkillStore } from "./store/store.ts";
import { deriveReadModel } from "./manifest/derive.ts";
import { acquireWriterLock, type WriterLock } from "./lock/pidfile.ts";
import { staleness, type StalenessReport } from "./staleness.ts";
import { loadConfig, saveConfig, applyPatch, configPath } from "./config/config.ts";
import { createEventBus, ACTIVITY_LOG_FILE, type EventBus } from "./server/events.ts";
import { createSuppressionStore, type SuppressionStore } from "./server/suppression.ts";
import { createIngest, type Ingest } from "./ingest/ingest.ts";
import { gitCloneFn } from "./ingest/git-clone.ts";
import { registryResolveFn } from "./ingest/registry-resolve.ts";
import { makeHeartbeatAcquire, startHeartbeat, HEARTBEAT_INTERVAL_MS, type Heartbeat } from "./server/heartbeat.ts";
import { buildRoutes, type RouteContext } from "./server/routes/index.ts";
import { startHttpServer, type HttpServer } from "./server/http.ts";
import { resolveWebDir } from "./server/static.ts";

export * from "./home.ts";
export * from "./store/schema.ts";
export * from "./store/store.ts";
export * from "./manifest/derive.ts";
export * from "./lock/pidfile.ts";
export * from "./staleness.ts";
// ── Phase-2 Wave-1b: config + ingest + server + events + heartbeat ──
export * from "./config/config.ts";
export * from "./ingest/git-clone.ts";
export * from "./ingest/registry-resolve.ts";
export * from "./ingest/ingest.ts";
export * from "./server/events.ts";
export * from "./server/suppression.ts";
export * from "./server/activity.ts";
export * from "./server/heartbeat.ts";
export * from "./server/http.ts";
export * from "./server/static.ts";
export * from "./server/routes/index.ts";

/** Injected fetch shape for the embeddings provider — derived from createEmbedProvider's signature (the
 *  source of truth; equals core's exported FetchLike now that the url/embed fetch types are disambiguated). */
type EmbedFetch = NonNullable<Parameters<typeof import("@skillforge/core").createEmbedProvider>[1]>;

export interface Persistence {
  home: string;
  store: SqliteSkillStore;
  lock: WriterLock;
  /** Derive the read-model from the DB (seq seeded from the existing manifest) WITHOUT writing it. */
  deriveManifest(): ManifestReadModel;
  /** Derive + atomically publish manifest.json (temp → fsync → atomic replace); returns what was written. */
  publishManifest(now?: string): ManifestReadModel;
  /** Tolerant last-good read of the published manifest (undefined when absent/empty/corrupt). */
  readManifest(): ManifestReadModel | undefined;
  /** Is the published manifest out of date vs the DB? (actor-observability staleness signal — D19) */
  staleness(): StalenessReport;
  /** Close the DB and release the writer lock. */
  close(): void;
}

export interface CreatePersistenceOptions {
  /** override the SkillForge home dir (tests pass a temp dir; never touch the real ~/.skillforge). */
  home?: string;
  /** override the writer-lock acquisition (tests inject a simulated pid / liveness). */
  acquireLock?: typeof acquireWriterLock;
}

/**
 * Wire store + manifest + writer lock into a single persistence handle the server will consume.
 * On startup it acquires the OS writer lock, opens the DB, and reconciles the SEQ-HANDOFF INVARIANT:
 * it seeds the store's seq floor from the existing manifest BEFORE any mutation, so a freshly-built DB
 * never regresses the monotonic seq below the CLI's last write.
 */
export function createPersistence(opts: CreatePersistenceOptions = {}): Persistence {
  const home = skillforgeHome(opts.home);
  fs.mkdirSync(home, { recursive: true });

  const lock = (opts.acquireLock ?? acquireWriterLock)(writerPidPath(home));
  const store = openStore(dbPath(home));
  const mfPath = manifestPathOf(home);

  // SEQ-HANDOFF: seed the seq floor from the last published manifest BEFORE serving / mutating.
  const startup = readJsonTolerant<ManifestReadModel>(mfPath);
  if (startup && typeof startup.seq === "number") store.seedSeqFloor(startup.seq);

  return {
    home,
    store,
    lock,
    deriveManifest(): ManifestReadModel {
      return deriveReadModel(store, { existingManifest: readJsonTolerant<ManifestReadModel>(mfPath) });
    },
    publishManifest(now?: string): ManifestReadModel {
      const model = deriveReadModel(store, {
        existingManifest: readJsonTolerant<ManifestReadModel>(mfPath),
        now,
      });
      atomicWriteFile(mfPath, `${JSON.stringify(model, null, 2)}\n`);
      return model;
    },
    readManifest(): ManifestReadModel | undefined {
      return readJsonTolerant<ManifestReadModel>(mfPath);
    },
    staleness(): StalenessReport {
      return staleness(readJsonTolerant<ManifestReadModel>(mfPath), store);
    },
    close(): void {
      store.close();
      lock.release();
    },
  };
}

// ── createDaemon (W1b) — wire persistence + config + ingest + event bus + heartbeat + http server ──────
//
// The daemon is the SOLE writer (D9): it acquires the writer lock (heartbeat-aware so a PID-reuse false
// -refuse is reclaimable — W1b heartbeat), serves the control API on 127.0.0.1, and owns the sourcing
// pipeline. createDaemon builds the wiring SYNCHRONOUSLY (lock + DB are held immediately); `start()`
// binds the http port + begins the mtime heartbeat; `stop()` tears both down and releases the lock.
export interface DaemonOptions {
  /** override the SkillForge home dir (tests pass a temp dir). */
  home?: string;
  /** overlay onto the loaded config.json (e.g. tests pin an embeddings provider or port 0). */
  config?: Partial<DaemonConfig>;
  /** override the git CloneFn (tests inject a no-network fake); defaults to the real system git spawn. */
  clone?: CloneFn;
  /** registry resolver; defaults to the real edge spawn (`npx skills`, W6). Tests inject a no-network fake. */
  registry?: RegistryResolveFn;
  /** unzip for `.zip` url payloads (W6); absent ⇒ a `.zip` url source throws loudly (never a silent skip). */
  unzip?: UnzipFn;
  /** injected url fetch for `url` sources (tests pass a no-network fixture; defaults to the global fetch). */
  urlFetch?: UrlFetch;
  /** injected fetch for the embeddings provider (ingest + route-test); tests pass a hermetic fake. */
  embedFetch?: EmbedFetch;
  /** reachability probe for /health (injectable for tests). */
  reachable?: (url: string) => Promise<boolean>;
  /** heartbeat refresh interval (ms); the stale threshold is 3× this. */
  heartbeatIntervalMs?: number;
  /** override the writer-lock acquisition (tests inject a simulated holder). */
  acquireLock?: typeof acquireWriterLock;
  /** override the bound port (defaults to config.port; tests pass 0 for an ephemeral port). */
  port?: number;
  /** override the served @skillforge/ui web/ dir (defaults to resolveWebDir(); tests may point elsewhere). */
  webDir?: string;
}

export interface Daemon {
  home: string;
  persistence: Persistence;
  events: EventBus;
  ingest: Ingest;
  /** conversation-scoped sticky-turn suppression (R1-B1) — tracked here, honored by the run chokepoint. */
  suppression: SuppressionStore;
  config(): DaemonConfig;
  /** bound port once `start()` has resolved. */
  port?: number;
  /** base URL once `start()` has resolved. */
  url?: string;
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
}

/** Default reachability probe: any HTTP response (even a 4xx/5xx) means the host is UP; a connection /
 *  timeout failure means DOWN. A 1.5s abort keeps /health snappy when a configured host is absent. */
async function defaultReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    try {
      await res.body?.cancel?.(); // drain so the socket can close (best-effort)
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

export function createDaemon(opts: DaemonOptions = {}): Daemon {
  const home = skillforgeHome(opts.home);
  fs.mkdirSync(home, { recursive: true });

  // config: tolerant load, overlay opts.config, persist a baseline if config.json does not exist yet.
  let currentConfig: DaemonConfig = { ...loadConfig(home), ...(opts.config ?? {}) };
  if (!fs.existsSync(configPath(home))) saveConfig(home, currentConfig);

  // Heartbeat-aware acquisition: staleAfter (10× interval) + a confirmation re-check are derived from the
  // interval inside makeHeartbeatAcquire, so a transient main-loop pause never false-reclaims a live lock.
  const acquireLock =
    opts.acquireLock ?? makeHeartbeatAcquire(opts.heartbeatIntervalMs ? { intervalMs: opts.heartbeatIntervalMs } : {});
  const persistence = createPersistence({ home, acquireLock });

  const events = createEventBus({ logPath: path.join(home, ACTIVITY_LOG_FILE) });
  const suppression = createSuppressionStore();

  const ingest = createIngest({
    home,
    store: persistence.store,
    publishManifest: persistence.publishManifest,
    events,
    config: () => currentConfig,
    clone: opts.clone ?? gitCloneFn,
    registry: opts.registry ?? registryResolveFn, // W6: the real `npx skills` edge spawn (D24), injectable for tests
    ...(opts.unzip ? { unzip: opts.unzip } : {}), // .zip stays DEFERRED-LOUD: no UnzipFn ⇒ resolveUrl throws (never silent)
    ...(opts.urlFetch ? { urlFetch: opts.urlFetch } : {}),
    ...(opts.embedFetch ? { embedFetch: opts.embedFetch } : {}),
  });

  function patchConfig(patch: PatchConfigRequest): DaemonConfig {
    currentConfig = applyPatch(currentConfig, patch);
    saveConfig(home, currentConfig);
    return currentConfig;
  }

  const routeCtx: RouteContext = {
    home,
    persistence,
    config: () => currentConfig,
    patchConfig,
    events,
    ingest,
    suppression,
    startedAt: Date.now(),
    reachable: opts.reachable ?? defaultReachable,
    webDir: resolveWebDir(opts.webDir),
    ...(opts.embedFetch ? { embedFetch: opts.embedFetch } : {}),
  };

  // Begin the mtime heartbeat IMMEDIATELY — the writer lock is held from HERE (createPersistence above),
  // not from start(), so refreshing must start now or a created-but-not-yet-started daemon's lock could
  // be falsely reclaimed as stale. The timer is unref'd, so an ingest-only (server-less) daemon still
  // exits cleanly; stop() halts it.
  const heartbeat: Heartbeat = startHeartbeat(writerPidPath(home), opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);

  let httpServer: HttpServer | undefined;
  let started = false;

  const daemon: Daemon = {
    home,
    persistence,
    events,
    ingest,
    suppression,
    config: () => currentConfig,
    async start() {
      if (started && httpServer) return { port: httpServer.port, url: httpServer.url };
      started = true;
      // crash recovery: an empty DB beside a populated sources/ → rebuild from the materialized trees.
      if (persistence.store.skillCount() === 0) await ingest.rebuildFromSources();
      const boundPort = opts.port ?? currentConfig.port;
      httpServer = await startHttpServer(buildRoutes(routeCtx), boundPort);
      daemon.port = httpServer.port;
      daemon.url = httpServer.url;
      return { port: httpServer.port, url: httpServer.url };
    },
    async stop() {
      heartbeat.stop();
      if (httpServer) await httpServer.close();
      httpServer = undefined;
      persistence.close();
    },
  };
  return daemon;
}

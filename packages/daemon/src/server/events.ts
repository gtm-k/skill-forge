// @skillforge/daemon/server/events — the in-process SSE event bus (§9 Activity).
//
// One fan-out point for the daemon's live DaemonEvent stream (selection / exec / injection / source /
// staleness). `GET /events` subscribes a connection; ingest/routing emit. SSE is LIVE-ONLY, so every
// emitted event is ALSO appended (one JSON line = the full DaemonEvent) to home/activity.log.jsonl —
// the durable backfill `GET /activity` rehydrates the surface from on load (a refresh must not lose the
// timeline). A subscriber whose callback throws is isolated (its error is surfaced to stderr, never
// allowed to take down the emit or the other subscribers — actor-observability, never silent).
import fs from "node:fs";
import path from "node:path";
import type { DaemonEvent } from "@skillforge/contracts/api";

/** Relative name of the daemon's append-only activity mirror (selection/source/staleness backfill). */
export const ACTIVITY_LOG_FILE = "activity.log.jsonl";

export interface EventBus {
  /** Publish to every live subscriber AND durably append to the activity log (best-effort persistence). */
  emit(event: DaemonEvent): void;
  /** Register a live listener; returns an unsubscribe fn (idempotent). */
  subscribe(fn: (event: DaemonEvent) => void): () => void;
  /** Number of live subscribers (test/introspection). */
  readonly size: number;
}

export interface EventBusOptions {
  /** absolute path of the activity log to mirror emits into; omitted ⇒ in-memory only (no persistence). */
  logPath?: string;
}

export function createEventBus(opts: EventBusOptions = {}): EventBus {
  const subscribers = new Set<(event: DaemonEvent) => void>();

  function persist(event: DaemonEvent): void {
    if (!opts.logPath) return;
    try {
      fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
      fs.appendFileSync(opts.logPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (e) {
      // A backfill-log write failure must be VISIBLE (ops can lose timeline history), but must NOT abort
      // the live emit — the connected UI still gets the event. Surface, do not throw.
      console.warn(`[skillforge/daemon] activity-log append failed: ${(e as Error).message}`);
    }
  }

  return {
    emit(event: DaemonEvent): void {
      persist(event);
      for (const fn of subscribers) {
        try {
          fn(event);
        } catch (e) {
          // Isolate a bad subscriber (e.g. a dropped SSE socket) so it can never starve the others.
          console.warn(`[skillforge/daemon] event subscriber threw: ${(e as Error).message}`);
        }
      }
    },
    subscribe(fn: (event: DaemonEvent) => void): () => void {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    get size() {
      return subscribers.size;
    },
  };
}

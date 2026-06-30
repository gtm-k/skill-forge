// @skillforge/daemon/server/activity — backfill DaemonEvent[] from the append-only JSONL logs (§5, §9).
//
// SSE is live-only; this rehydrates the Activity surface on load. Sources are PARTITIONED by event type
// so a future wave that routes exec/injection through BOTH the bus AND the dedicated audit log can never
// double-count:
//   • exec      ← home/exec.log.jsonl   (core/exec writes ExecLogLine; IS the DaemonEvent.exec `data`)
//   • injection ← home/inject.log.jsonl (the LM Studio plugin's InjectLogLine, mapped best-effort)
//   • selection / source / staleness ← home/activity.log.jsonl (the bus mirror — full DaemonEvent lines)
//
// BOUNDED TAIL READ (these logs are append-only with NO rotation, and getActivity is CSRF-reachable):
// we read only the LAST `maxBytes` of each file and reverse-scan it, parsing newest→oldest and STOPPING
// as soon as we have `limit` events OR a line older than `since` (the log is chronological). Memory/CPU
// stay bounded by maxBytes regardless of total log size — a multi-GB log never gets slurped or fully
// parsed. Each line is parsed tolerantly: a corrupt/truncated tail line is SKIPPED (a mid-write crash
// must not blank the surface), never thrown.
import fs from "node:fs";
import path from "node:path";
import type { DaemonEvent, ActivityQuery } from "@skillforge/contracts/api";
import type { Disclosure, ExecLogLine, TargetId } from "@skillforge/contracts";
import { ACTIVITY_LOG_FILE } from "./events.ts";
import { EXEC_LOG_FILE } from "@skillforge/core";

// EXEC_LOG_FILE is the shared layout name (Wave C / D3) — re-exported so daemon-internal `from "./activity.ts"`
// import sites (routes/index.ts) are unchanged.
export { EXEC_LOG_FILE };
export const INJECT_LOG_FILE = "inject.log.jsonl";

const DEFAULT_LIMIT = 200;
/** The most bytes read from the TAIL of any one log per request (bounds memory/CPU; ~the most recent few
 *  thousand events). A request never reads or parses more than 3× this (one tail per partitioned log). */
const MAX_TAIL_BYTES = 256 * 1024;

interface ScanBound {
  since?: string;
  limit: number;
  maxBytes: number;
}

/**
 * Read the last `bound.maxBytes` of `file`, reverse-scan its lines newest→oldest, map each via `toEvent`,
 * and collect up to `bound.limit` events, stopping early once a line is older than `bound.since`. Returns
 * NEWEST-FIRST. A partial first line (when the window starts mid-file) is dropped. Never throws.
 */
function tailEvents(file: string, toEvent: (parsed: unknown) => DaemonEvent | undefined, bound: ScanBound): DaemonEvent[] {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return []; // absent log → nothing to backfill (the surface is simply empty)
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];
    const start = Math.max(0, size - bound.maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      // we began mid-file → the first (partial) line is incomplete; drop it.
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    const lines = text.split("\n");
    const out: DaemonEvent[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i]!.trim();
      if (!t) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        continue; // a corrupt/truncated line is skipped, never fails the scan
      }
      const ev = toEvent(parsed);
      if (!ev) continue;
      if (bound.since && ev.ts < bound.since) break; // chronological → everything earlier is also < since
      out.push(ev);
      if (out.length >= bound.limit) break;
    }
    return out; // newest-first
  } finally {
    fs.closeSync(fd);
  }
}

function asExec(o: unknown): DaemonEvent | undefined {
  if (!o || typeof (o as ExecLogLine).ts !== "string") return undefined;
  return { type: "exec", ts: (o as ExecLogLine).ts, data: o as ExecLogLine };
}

/** The LM Studio plugin's InjectLogLine (replicated shape — no adapter import). target/tokenCost are not
 *  in that record, so they are filled best-effort on backfill (live injection events carry the full set). */
interface InjectLogLine {
  ts: string;
  slug: string | null;
  disclosure: string;
  injectedBytes: number;
  injectedLen: number;
}

function asInjection(o: unknown): DaemonEvent | undefined {
  const line = o as InjectLogLine;
  if (!line || typeof line.ts !== "string") return undefined;
  return {
    type: "injection",
    ts: line.ts,
    data: {
      slug: line.slug ?? "",
      target: "lmstudio" as TargetId, // the inject log is the LM Studio plugin's; live events stamp the real target
      injectedBytes: line.injectedBytes ?? 0,
      injectedChars: line.injectedLen ?? 0,
      tokenCost: Math.ceil((line.injectedLen ?? 0) / 4), // estimate (the log carries no token cost)
      disclosure: (line.disclosure ?? "none") as Disclosure,
    },
  };
}

/** Only the bus-owned types live in activity.log.jsonl's backfill (exec/injection have dedicated logs). */
function asMirror(o: unknown): DaemonEvent | undefined {
  const ev = o as DaemonEvent;
  if (!ev || typeof ev.type !== "string" || typeof ev.ts !== "string") return undefined;
  return ev.type === "selection" || ev.type === "source" || ev.type === "staleness" ? ev : undefined;
}

/**
 * Assemble the Activity backfill for `home`, applying the ActivityQuery. Newest-first, capped at
 * `query.limit` (default 200). `since` filters by ISO ts (inclusive lower bound); `type` narrows to one
 * event type (and reads ONLY that type's log — cheaper). Every read is tail-bounded (MAX_TAIL_BYTES).
 */
export function getActivity(home: string, query: ActivityQuery = {}): DaemonEvent[] {
  const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_LIMIT;
  const bound: ScanBound = { limit, maxBytes: MAX_TAIL_BYTES, ...(query.since ? { since: query.since } : {}) };

  let events: DaemonEvent[];
  if (query.type === "exec") {
    events = tailEvents(path.join(home, EXEC_LOG_FILE), asExec, bound);
  } else if (query.type === "injection") {
    events = tailEvents(path.join(home, INJECT_LOG_FILE), asInjection, bound);
  } else if (query.type) {
    const want = query.type;
    events = tailEvents(path.join(home, ACTIVITY_LOG_FILE), (o) => {
      const ev = asMirror(o);
      return ev && ev.type === want ? ev : undefined;
    }, bound);
  } else {
    // merge the three partitioned tails (each already bounded + newest-first), then sort + cap.
    events = [
      ...tailEvents(path.join(home, ACTIVITY_LOG_FILE), asMirror, bound),
      ...tailEvents(path.join(home, EXEC_LOG_FILE), asExec, bound),
      ...tailEvents(path.join(home, INJECT_LOG_FILE), asInjection, bound),
    ];
  }

  // Newest-first by ISO ts (lexicographic order == chronological for ISO-8601 Z timestamps).
  events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return events.slice(0, limit);
}

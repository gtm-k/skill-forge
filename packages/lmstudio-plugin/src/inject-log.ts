// @skillforge/lmstudio/inject-log — the D11 SELF-VERIFYING hand-off record.
//
// "Fired" must be provable by BYTES, not by a selection decision. Each turn we append one JSON line
// recording the EXACT injected content buildInjection produced — injectedBytes (MEASURED on the final
// text) and injectedLen — plus the slug, disclosure level, firing tier and selection reasons. An ops
// reader can then diff what the host echoes back against this line; nothing about the injection is
// invisible (actor-observability). This is append-only and local-only (never network).
import fs from "node:fs";
import path from "node:path";

/** One append-only injection record. `slug` is null when nothing fired (mode "none" / no match). */
export interface InjectLogLine {
  ts: string;
  traceId: string;
  slug: string | null;
  disclosure: string;
  injectedBytes: number;
  injectedLen: number;
  tier: string;
  reasons: string[];
}

/** Relative name of the append-only injection log under home. */
export const INJECT_LOG_FILE = "inject.log.jsonl";

/**
 * Append one JSON line to home/inject.log.jsonl (one record per turn). Creates `home` if absent
 * (mkdir -p) so the very first turn after `add` still records. Synchronous append — the record must be
 * durable before the rewritten turn is handed back, so "fired" is never claimed without its byte proof.
 */
export function appendInjectLog(home: string, line: InjectLogLine): void {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, INJECT_LOG_FILE), `${JSON.stringify(line)}\n`);
}

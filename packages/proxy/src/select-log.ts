// @skillforge/proxy/select-log — the never-silent, append-only per-request routing record (D2/D11/M-embed).
//
// The proxy mutates ONLY the outgoing request (it persists nothing about the chat). So the ONE durable trace
// of "what the proxy did this request" is this line: which skill it injected as the ephemeral system message,
// how many bytes, the firing tier, and — critically — whether semantic Tier-2 was DISABLED this request
// (`tier2Disabled`). That makes a degraded route observable to ops even though the proxy keeps working on
// Tier 0/1 (M-embed: never a silent downgrade). Append-only, local-only (never network), mirrors the
// LM Studio plugin's inject.log.jsonl so an operator reads both adapters the same way.
import fs from "node:fs";
import path from "node:path";

/** Relative name of the proxy's append-only routing log under home. */
export const SELECT_LOG_FILE = "select.log.jsonl";

/** One append-only routing record (one per /v1/chat/completions request). */
export interface SelectLogLine {
  ts: string;
  /** sha256(query + home).slice(0,12) — ties the line to (query, home) without storing the raw text. */
  traceId: string;
  /** the proxy's placement channel — always system-ephemeral (R1-B1, D15). */
  channel: "system-ephemeral";
  /** the injected skill slug, or null when nothing fired (mode "none" / X-Skill:off / no match). */
  slug: string | null;
  /** "full" | "menu" | "none" — what buildInjection decided. */
  disclosure: string;
  /** MEASURED byte length of the injected system message (0 when nothing injected). */
  injectedBytes: number;
  /** char length of the injected text (0 when nothing injected). */
  injectedLen: number;
  /** the firing tier (selection.mode): explicit | semantic | lexical | none. */
  tier: string;
  /** present iff semantic Tier-2 WOULD have run but could not (provider absent/unreachable) — VISIBLE, never silent. */
  tier2Disabled?: string;
  /** the X-Skill header directive that forced this request: a slug (Tier-0 force) or "off" (passthrough). */
  forced?: string;
  /** non-fatal injection degradations this request (unreadable/unsafe chosen body, no-stored-vectors). Present
   *  only when non-empty — surfaced here AND on the X-Skill-Warnings response header (never silently swallowed). */
  warnings?: string[];
  /** selection reasons (lexical hits / cosine / explicit) — empty on a no-match. */
  reasons: string[];
}

/**
 * Append one JSON line to home/select.log.jsonl (one record per request). Creates `home` if absent so the
 * very first request still records. Synchronous append — the record is durable before the response is
 * returned, so "what the proxy injected" is never claimed without its byte proof.
 */
export function appendSelectLog(home: string, line: SelectLogLine): void {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, SELECT_LOG_FILE), `${JSON.stringify(line)}\n`);
}

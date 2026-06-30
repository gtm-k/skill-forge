// @skillforge/mcp-server/stdio — the newline-delimited (NDJSON) stdio transport loop.
//
// THE CONTRACT (load-bearing): stdout is the PROTOCOL CHANNEL. Each line in is one JSON-RPC message; each
// response is written as a single line of JSON + "\n" to stdout. ALL diagnostics go to stderr — anything
// non-protocol on stdout corrupts the stream. Lines are processed SEQUENTIALLY (a promise queue) so
// responses are written in request order and two async handlers never interleave a half-written line.
//
// We split lines MANUALLY (rather than node:readline) so we can BOUND the per-line buffer: a peer that
// streams a newline-free flood would otherwise grow the readline buffer without limit (a self-DoS). A line
// that exceeds MAX_LINE_UNITS — WHETHER OR NOT it ends in a newline — is rejected with one -32700 reply and
// its bytes are dropped rather than buffered or parsed (a newline does NOT exempt an over-long frame from
// the cap). Framing recovers on the next newline-delimited line. CRLF parity with readline's
// crlfDelay:Infinity: we split on "\n" and trim a trailing "\r" (handleLine also trims, so a stray \r is
// harmless either way).

import type { Readable, Writable } from "node:stream";
import { createMcpServer, type McpServer } from "./server.ts";
import { error, serialize, JSON_RPC } from "./protocol.ts";
import type { McpServerDeps } from "./deps.ts";

/** Max length (in UTF-16 code units) of a single newline-delimited message. Generous — JSON-RPC messages
 *  carrying skill instructions/bundles can be large — but bounded so a newline-free flood cannot grow the
 *  buffer without limit. ~16Mi units ≈ 16 MB of ASCII; an over-long line is rejected, not buffered. */
export const MAX_LINE_UNITS = 16 * 1024 * 1024;

export interface StdioOptions {
  /** defaults to process.stdin / process.stdout / process.stderr (overridable for tests). */
  input?: Readable;
  output?: Writable;
  errorOut?: Writable;
  /** max length (UTF-16 units) of one newline-delimited line; defaults to MAX_LINE_UNITS (overridable for tests). */
  maxLineUnits?: number;
}

export interface StdioHandle {
  server: McpServer;
  /** resolves when the input stream closes (all queued work drained). */
  closed: Promise<void>;
}

/** Run the MCP server over a newline-delimited stdio transport. Returns the server + a `closed` promise. */
export function runStdioServer(deps: McpServerDeps, opts: StdioOptions = {}): StdioHandle {
  // Annotate to the single stream interface (not the `opts.* | process.std*` union): `.write()` on a
  // union of two overloaded method sets is "not callable" under strict @types/node. process.std* are
  // assignable to these, so this only narrows — and makes the gate robust to @types/node version drift.
  const input: Readable = opts.input ?? process.stdin;
  const output: Writable = opts.output ?? process.stdout;
  const errorOut: Writable = opts.errorOut ?? process.stderr;
  const maxLineUnits = opts.maxLineUnits ?? MAX_LINE_UNITS;
  const server = createMcpServer(deps);

  // Sequential processing queue: each line's response is fully written before the next is handled.
  let queue: Promise<void> = Promise.resolve();
  function enqueueLine(line: string): void {
    queue = queue.then(async () => {
      try {
        const res = await server.handleLine(line);
        if (res !== null) output.write(res);
      } catch (e) {
        // diagnostics NEVER touch stdout (the protocol channel) — they go to stderr.
        errorOut.write(`[skillforge-mcp] error handling a line: ${(e as Error).message}\n`);
      }
    });
  }
  function enqueueWrite(s: string): void {
    queue = queue.then(() => {
      output.write(s);
    });
  }
  // Reject ONE over-long line: a single -32700 reply (null id — we never parsed one) onto stdout, the
  // human-readable diagnostic onto stderr ONLY (stdout is the protocol channel). Used for BOTH an over-long
  // newline-terminated frame and a newline-free flood, so the cap is enforced identically either way.
  function rejectOverLong(): void {
    enqueueWrite(serialize(error(null, JSON_RPC.PARSE_ERROR, `parse error: line exceeds the ${maxLineUnits}-unit limit`)));
    errorOut.write(`[skillforge-mcp] dropped an over-long line (> ${maxLineUnits} units)\n`);
  }

  let buf = "";
  let dropping = false; // the current (unterminated) line blew the cap — drop bytes until the next "\n".
  input.setEncoding("utf8");

  input.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (dropping) {
        dropping = false; // the over-long (newline-free) prefix ends at this newline; resume framing.
        continue;
      }
      if (raw.length > maxLineUnits) {
        // A single newline-TERMINATED line over the cap. The byte cap applies REGARDLESS of the trailing
        // newline: reject + DROP the whole frame instead of enqueueing/parsing it. Framing recovers
        // immediately — the newline is already consumed, so the next iteration handles the next line.
        rejectOverLong();
        continue;
      }
      enqueueLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    }
    if (buf.length > maxLineUnits) {
      // What remains has no newline yet and already exceeds the cap. Reject the FIRST time (one -32700),
      // then keep DROPPING bytes until the next newline rather than buffering an unbounded newline-free
      // flood (self-DoS hardening). While already dropping we discard the prefix without re-erroring — one
      // -32700 per over-long line, not one per chunk — which also keeps the drop phase itself bounded.
      if (!dropping) {
        dropping = true;
        rejectOverLong();
      }
      buf = "";
    }
  });

  const closed = new Promise<void>((resolve) => {
    const finish = (): void => {
      // Flush a trailing newline-less line (readline parity), unless it was being dropped as over-long.
      if (!dropping && buf.length > 0) {
        enqueueLine(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
      }
      buf = "";
      void queue.then(() => resolve());
    };
    input.on("end", finish);
    // Some inputs only emit 'close' (no 'end', e.g. a destroyed stream). Guard so `closed` always settles.
    input.on("close", () => {
      void queue.then(() => resolve());
    });
  });

  return { server, closed };
}

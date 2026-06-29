#!/usr/bin/env -S node --experimental-strip-types --experimental-sqlite
// @skillforge/daemon/bin — the daemon entry point.
//
// Run under BOTH `--experimental-strip-types` (native TS) AND `--experimental-sqlite` (node:sqlite, via
// the W1a store). It acquires the writer lock, opens the DB, and serves the control API on 127.0.0.1.
// SIGINT/SIGTERM tear the server down and RELEASE the lock cleanly (so the next start is not refused).
import { createDaemon } from "./index.ts";

const daemon = createDaemon();
const { url } = await daemon.start();
// stdout is the only place an operator sees the bound URL — never silent (actor-observability). The daemon
// serves the visual manager single-origin, so the same URL is both the control API and the console.
console.log(`[skillforge] daemon listening at ${url}`);
console.log(`[skillforge] visual manager → ${url}/`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[skillforge] ${signal} — shutting down`);
  try {
    await daemon.stop();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

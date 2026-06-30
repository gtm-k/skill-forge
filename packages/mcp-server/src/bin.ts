#!/usr/bin/env node
// @skillforge/mcp-server/bin — the stdio entrypoint for MCP hosts (Claude Desktop / Cursor / LM Studio).
//
// Wires the newline-delimited stdio transport to the read-model-backed deps over $SKILLFORGE_HOME →
// ~/.skillforge. This is the daemon-DOWN path: it reads the CLI-written read-model directly and runs
// skill scripts through core.run(). Run with Node 22 type-stripping (no build step):
//   node --experimental-strip-types path/to/bin.ts
// or via the bin name `skillforge-mcp` once the workspace is linked.
//
// stdout is the protocol channel; the startup banner + all diagnostics go to stderr only.
import { createReadModelDeps, skillforgeHome } from "./catalog.ts";
import { runStdioServer } from "./stdio.ts";
import { SERVER_VERSION } from "./index.ts";

const home = skillforgeHome();
process.stderr.write(
  `[skillforge-mcp] v${SERVER_VERSION} serving home ${home} over stdio (newline-delimited JSON-RPC 2.0)\n`,
);

const deps = createReadModelDeps(home, SERVER_VERSION);
const { closed } = runStdioServer(deps);

// Keep the process alive until stdin closes; exit cleanly when the host disconnects.
closed.then(() => {
  process.stderr.write("[skillforge-mcp] stdin closed — exiting\n");
  process.exit(0);
});

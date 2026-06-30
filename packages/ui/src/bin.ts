#!/usr/bin/env node
// @skillforge/ui/bin — the thin `skill-forge-ui` launcher. Parses argv + prints the URL; ALL logic lives
// in server.ts / select-handler.ts (the same "thin shell" rule the CLI's bin follows). Dev invocation:
//   node --experimental-strip-types src/bin.ts [--home <dir>] [--port <n>]
// The server it starts is READ-ONLY and loopback-only — it renders the CLI-written read-model and runs
// core.select for the live route tester. It never writes to the skill home.
import os from "node:os";
import path from "node:path";
import { startServer } from "./server.ts";

const USAGE = `usage:
  skill-forge-ui [--home <dir>] [--port <n>]   start the read-only visual manager (default port: ephemeral)
`;

function fail(msg: string, code = 2): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

interface Args {
  home: string;
  port: number;
}

function parseArgs(argv: string[]): Args {
  // Resolution mirrors the CLI's home precedence: --home → $SKILLFORGE_HOME → <homedir>/.skillforge.
  let home = process.env.SKILLFORGE_HOME ?? path.join(os.homedir(), ".skillforge");
  let port = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") {
      const v = argv[++i];
      if (!v) fail(`error: --home needs a directory.\n\n${USAGE}`);
      home = v;
    } else if (a === "--port") {
      const v = argv[++i];
      const n = Number(v);
      if (!v || !Number.isInteger(n) || n < 0 || n > 65535) fail(`error: --port needs an integer 0-65535.\n\n${USAGE}`);
      port = n;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      fail(`error: unknown argument ${JSON.stringify(a)}.\n\n${USAGE}`);
    }
  }
  return { home, port };
}

async function main(): Promise<void> {
  const { home, port } = parseArgs(process.argv.slice(2));
  const { port: bound } = await startServer(home, port);
  process.stdout.write(`SkillForge visual manager (read-only) — home: ${home}\n`);
  process.stdout.write(`  http://localhost:${bound}\n`);
}

main().catch((err: unknown) => {
  fail(`error: ${err instanceof Error ? err.message : String(err)}`, 1);
});

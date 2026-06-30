#!/usr/bin/env node
// @skillforge/cli/bin — the thin `skill-forge` CLI. Parses argv + prints; ALL real logic lives in
// add.ts / manifest.ts (same "thin shell" rule the UI follows). Dev invocation:
//   node --experimental-strip-types src/bin.ts add <git-url|folder>
// (A published launcher shim — a tiny .mjs that re-execs node with --experimental-strip-types — is a
// later packaging concern; the `bin` field points at this .ts for the dev/junction-linked workflow.)
//
// Observability + HUMBLE framing: the add summary reports WHAT was sourced and a humble capability
// inventory ("carries N scripts; M flagged — what we noticed, not a safety verdict"), never a safety
// verdict. Warnings (e.g. embeddings skipped because the endpoint is down) go to stderr — never silent.
import { addSource } from "./add.ts";
import { readManifest } from "./manifest.ts";
import { manifestPath as manifestPathOf, skillforgeHome } from "./home.ts";
import type { CapabilityFlag } from "@skillforge/contracts";

const USAGE = `usage:
  skill-forge add <git-url | local-folder>   materialize a source + update the manifest
  skill-forge list                           list installed skills and their enabled targets
`;

function fail(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function flagLabel(flags: CapabilityFlag[]): string {
  return flags.length === 0 ? "" : ` [${flags.join(", ")}]`;
}

async function cmdAdd(input: string | undefined): Promise<void> {
  if (!input) fail(`error: \`add\` needs a source.\n\n${USAGE}`, 2);

  const { added, sourceId, manifestPath: mfPath, warnings } = await addSource(input);

  // Warnings first, on stderr — never silent (A0-A: an embeddings skip is reported, not hidden).
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  const out = process.stdout;
  out.write(`Added ${added.length} skill${added.length === 1 ? "" : "s"} from source ${sourceId}\n`);
  out.write(`Capability inventory (what we noticed, not a safety verdict):\n`);
  for (const e of added) {
    const c = e.capabilities;
    out.write(`  ${e.slug}: carries ${c.scriptCount} script${c.scriptCount === 1 ? "" : "s"}, ${c.flags.length} flagged${flagLabel(c.flags)}\n`);
  }
  const seq = readManifest(mfPath)?.seq ?? 0;
  out.write(`manifest: ${mfPath} (seq ${seq})\n`);
}

function cmdList(): void {
  const mfPath = manifestPathOf(skillforgeHome());
  const model = readManifest(mfPath);
  if (!model || model.skills.length === 0) {
    process.stdout.write(`no skills installed (manifest: ${mfPath})\n`);
    return;
  }
  for (const s of model.skills) {
    const on = Object.entries(s.enabledFor)
      .filter(([, v]) => v)
      .map(([t]) => t)
      .join(", ");
    process.stdout.write(`${s.slug}  [${on || "none"}]\n`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "add":
      await cmdAdd(rest[0]);
      return;
    case "list":
      cmdList();
      return;
    default:
      fail(cmd ? `error: unknown command ${JSON.stringify(cmd)}.\n\n${USAGE}` : USAGE, 2);
  }
}

main().catch((err: unknown) => {
  fail(`error: ${err instanceof Error ? err.message : String(err)}`);
});

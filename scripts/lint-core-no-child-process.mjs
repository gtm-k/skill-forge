// Structural lint (PLAN §2 / D24): @skillforge/core's leverage point stays child_process-FREE.
//
// THE INVARIANT: the ONLY module in packages/core/src allowed to import node:child_process is
// core/src/exec/ — the single skill-script spawn chokepoint. Everywhere else core takes an INJECTED edge
// capability (CloneFn / RegistryResolveFn / EmbedFn), so "our execution is never silent": every spawn is
// either the audited exec chokepoint or lives at an adapter's edge (CLI/daemon), never hidden inside the
// pure core. This grep-based guard fails CI the moment a core module reintroduces a direct spawn.
//
// Zero-install: node built-ins only, no deps. Matches a QUOTED module specifier ("child_process" /
// "node:child_process") so it never false-positives on capability.ts's bare `\bchild_process\b` detection
// regex or on a prose comment that merely mentions the words.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const coreSrc = join(repoRoot, "packages", "core", "src");
const EXEC_DIR = join(coreSrc, "exec") + sep; // the ONE allowed importer subtree

// A quoted ESM/CJS module specifier for (node:)?child_process — import/require/dynamic-import all match.
const SPECIFIER = /["'](?:node:)?child_process["']/;

/** Recursively collect every .ts file under `dir`. */
function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...tsFiles(abs));
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

const violations = [];
let scanned = 0;
for (const file of tsFiles(coreSrc)) {
  scanned++;
  if (file.startsWith(EXEC_DIR)) continue; // exec/ is the sanctioned spawn chokepoint
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    if (SPECIFIER.test(line)) violations.push(`${relative(repoRoot, file)}:${i + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error(
    `\n[lint-core-no-child-process] FAILED — packages/core/src imports child_process OUTSIDE core/src/exec/ ` +
      `(D24: core stays child_process-free; spawns are injected or live in the exec chokepoint):\n`,
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    `\nFix: inject the capability at the edge (CloneFn / RegistryResolveFn) like cli/daemon do, ` +
      `or route a skill-script spawn through core/src/exec.\n`,
  );
  process.exit(1);
}

console.log(
  `[lint-core-no-child-process] OK — scanned ${scanned} core/src file(s); ` +
    `node:child_process is confined to core/src/exec/ (the audited spawn chokepoint).`,
);

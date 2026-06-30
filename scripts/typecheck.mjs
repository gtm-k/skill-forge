// Type gate: `node scripts/typecheck.mjs` → `tsc --noEmit` over every package's src + test.
//
// WHY a wrapper (not a bare `tsc`): the repo is zero-install, so there is no root `tsc` and no @types.
// This script bootstraps the isolated sidecar in scripts/typecheck/ (the only npm deps in the repo) and
// the @skillforge/* junctions (scripts/link-workspace.mjs), then runs tsc against tsconfig.json. It is
// the SAME gate locally and in CI. A non-zero tsc exit propagates as this process's exit code.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here); // v2/
const tool = join(here, "typecheck"); // scripts/typecheck/
const tscJs = join(tool, "node_modules", "typescript", "bin", "tsc");

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) {
    // never silent: a missing tool / spawn failure is surfaced, not swallowed into a misleading pass.
    console.error(`[typecheck] failed to run ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  return r.status ?? 1;
}

// 1) the only npm deps in the repo: typescript + @types/node, isolated + version-pinned in the sidecar.
//    Re-run `npm ci` when the sidecar is missing OR DRIFTED from the pin — a stale sidecar left from an
//    earlier pin must not silently run a different tsc/@types/node than CI installs from the committed
//    lockfile (that would make the gate non-deterministic: green locally, red in CI, or vice versa).
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const installedVersion = (pkg) => {
  try { return readJson(join(tool, "node_modules", pkg, "package.json")).version; }
  catch { return null; }
};
const pinned = readJson(join(tool, "package.json")).devDependencies;
const drift =
  !existsSync(tscJs) ||
  installedVersion("typescript") !== pinned.typescript ||
  installedVersion("@types/node") !== pinned["@types/node"];
if (drift) {
  console.error("[typecheck] installing/refreshing sidecar tooling (typescript + @types/node) from the lockfile…");
  // npm is a .cmd on Windows → shell:true. `npm ci` is reproducible from the committed lockfile.
  const code = run("npm", ["ci", "--silent"], { cwd: tool, shell: true });
  if (code !== 0 || !existsSync(tscJs)) {
    console.error("[typecheck] sidecar install failed — cannot run the type gate.");
    process.exit(1);
  }
}

// 2) @skillforge/* resolution (idempotent; tsc needs the cross-package junctions to resolve imports).
//    A link failure must FAIL the gate — never let tsc run against stale/partial junctions and report a
//    misleading result (actor-observability: the gate must not pass without its precondition met).
const linkStatus = run(process.execPath, [join(here, "link-workspace.mjs")], { cwd: repo });
if (linkStatus !== 0) {
  console.error("[typecheck] workspace link failed — @skillforge/* junctions missing/partial; aborting the gate.");
  process.exit(1);
}

// 3) the gate itself. Invoke tsc's JS entry via this Node so there is no .cmd/PATH dependence.
const status = run(process.execPath, [tscJs, "-p", join(repo, "tsconfig.json"), "--noEmit"], { cwd: repo });
process.exit(status);

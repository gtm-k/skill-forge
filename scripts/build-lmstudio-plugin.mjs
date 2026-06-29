#!/usr/bin/env node
// scripts/build-lmstudio-plugin.mjs — assemble a RUNNABLE LM Studio plugin from this repo + LM Studio's
// reference RAG-v1 preprocessor (which provides the real `@lmstudio/sdk` and the `lms dev` build wiring).
//
// WHY this script exists: `@lmstudio/sdk` only exists INSIDE a built LM Studio plugin, so the plugin can't be
// a normal package in this repo (D18/A0-B/RUNBOOK.md). We clone rag-v1, swap in SkillForge's headless runtime
// + the SDK glue, and vendor @skillforge/core + @skillforge/contracts UNDER src/ (NOT node_modules — LM
// Studio's dev runner refuses to type-strip .ts files under node_modules: ERR_UNSUPPORTED_NODE_MODULES_TYPE_
// STRIPPING). The vendored cross-package imports are rewritten to `#skillforge/*` subpath imports and resolved
// via a package.json `imports` map that this script GENERATES COMPLETELY from the specifiers actually used —
// so every subpath (core/source, core/exec, contracts/api, …) resolves, not just the barrel.
//
// Usage:  node scripts/build-lmstudio-plugin.mjs [destDir]
//   destDir defaults to ~/.lmstudio-skillforge-plugin  (override with $SKILLFORGE_PLUGIN_DIR)
//   rag-v1 source defaults to ~/.lmstudio/extensions/plugins/lmstudio/rag-v1  (override with $LMS_RAG_DIR)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const ragDir = process.env.LMS_RAG_DIR || path.join(home, ".lmstudio", "extensions", "plugins", "lmstudio", "rag-v1");
const dest = process.argv[2] || process.env.SKILLFORGE_PLUGIN_DIR || path.join(home, ".lmstudio-skillforge-plugin");

const die = (msg) => { console.error(`\n[build-lmstudio-plugin] ERROR: ${msg}\n`); process.exit(1); };
const log = (msg) => console.log(`[build-lmstudio-plugin] ${msg}`);

// ── 0. preflight ──────────────────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(ragDir, "package.json"))) {
  die(`reference plugin not found at:\n    ${ragDir}\n\n` +
      `Install it first: open LM Studio → Discover → Plugins → "RAG v1" (lmstudio/rag-v1). It provides the\n` +
      `real @lmstudio/sdk and the lms-dev build wiring this script clones. Or set $LMS_RAG_DIR to its path.`);
}

// ── 1. clone rag-v1 → dest, then strip its identity + build artifacts ────────────────────────────────────
log(`cloning reference plugin\n    from ${ragDir}\n    to   ${dest}`);
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(ragDir, dest, { recursive: true });
for (const f of [".lmstudio/production.js", "install-state.json", "package-lock.json", "README.md", "src/config.ts"]) {
  fs.rmSync(path.join(dest, f), { force: true });
}

// ── 2. swap in SkillForge's plugin src (the headless runtime + the SDK glue; NOT the gate-only SDK stub) ──
const pluginSrc = path.join(repo, "packages", "lmstudio-plugin", "src");
const destSrc = path.join(dest, "src");
fs.mkdirSync(destSrc, { recursive: true });
for (const f of ["index.ts", "promptPreprocessor.ts", "select-inject.ts", "read-model.ts", "embed.ts", "inject-log.ts"]) {
  fs.copyFileSync(path.join(pluginSrc, f), path.join(destSrc, f));
}

// ── 3. vendor @skillforge/core + @skillforge/contracts UNDER src/ (whole src trees) ──────────────────────
fs.cpSync(path.join(repo, "packages", "core", "src"), path.join(destSrc, "vendor", "core"), { recursive: true });
fs.cpSync(path.join(repo, "packages", "contracts", "src"), path.join(destSrc, "vendor", "contracts"), { recursive: true });

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const tsFiles = () => walk(destSrc).filter((f) => f.endsWith(".ts"));

// drop any stray crash dumps the copy may have picked up
for (const f of walk(destSrc)) if (f.endsWith(".stackdump")) fs.rmSync(f, { force: true });

// ── 4. rewrite @skillforge/* → #skillforge/* (subpath imports resolved via the generated map below) ─────
for (const f of tsFiles()) {
  const s = fs.readFileSync(f, "utf8");
  const r = s.replaceAll("@skillforge/", "#skillforge/");
  if (r !== s) fs.writeFileSync(f, r);
}

// ── 5. GENERATE a COMPLETE imports map from the #skillforge specifiers actually used (fail loud on a miss) ─
// Scan EVERY .ts file (plugin src + vendor/**) for bare #skillforge/* specifiers — including deep subpaths
// (core/exec/gate, core/source/folder, core/index/embed-provider) and the plugin's own self-imports
// (lmstudio/embed). Each must get an explicit map entry; esbuild + Node's loader both honor explicit string
// targets (wildcards would mis-resolve dir-style subpaths whose module is `<sub>/index.ts`, not `<sub>.ts`).
const SPEC_RE = /#skillforge\/[A-Za-z0-9_\-/]+/g;
const collectSpecifiers = () => {
  const set = new Set();
  for (const f of tsFiles()) for (const m of fs.readFileSync(f, "utf8").matchAll(SPEC_RE)) set.add(m[0]);
  return set;
};
const relExists = (rel) => fs.existsSync(path.join(dest, rel));
function resolveTarget(spec) {
  const rest = spec.slice("#skillforge/".length);       // "core" | "core/source" | "core/exec/gate" | "lmstudio/embed"
  const slash = rest.indexOf("/");
  const pkg = slash === -1 ? rest : rest.slice(0, slash);
  const sub = slash === -1 ? "" : rest.slice(slash + 1);
  const base = pkg === "core" ? "src/vendor/core"
             : pkg === "contracts" ? "src/vendor/contracts"
             : pkg === "lmstudio" ? "src"                // the plugin's own files (self-package imports)
             : die(`unrecognized vendored package in specifier: ${spec}`);
  if (!sub || sub === "index") {
    return pkg === "contracts" ? "src/vendor/contracts/schema.ts" : `${base}/index.ts`; // contracts "." == schema.ts
  }
  const dir = `${base}/${sub}/index.ts`, flat = `${base}/${sub}.ts`;            // dir-with-index OR flat module
  if (relExists(dir)) return dir;
  if (relExists(flat)) return flat;
  return die(`cannot resolve ${spec}: neither ${dir} nor ${flat} exists`);
}
const specifiers = collectSpecifiers();
const imports = {};
for (const spec of [...specifiers].sort()) imports[spec] = "./" + resolveTarget(spec).split(path.sep).join("/");
// HARD completeness guard: every used specifier MUST have a map entry, or the plugin throws on first chat.
const unmapped = [...specifiers].filter((s) => !(s in imports));
if (unmapped.length) die(`imports map INCOMPLETE — no entry for:\n  - ${unmapped.join("\n  - ")}`);
log(`generated a COMPLETE imports map: ${Object.keys(imports).length} entries for ${specifiers.size} specifiers`);

// ── 6. write the plugin identity + the imports map ──────────────────────────────────────────────────────
const pkgPath = path.join(dest, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.name = "skillforge-lmstudio";
delete pkg.author;
pkg.imports = imports;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify({
  type: "plugin", runner: "node", owner: "skillforge-local", name: "skillforge-lmstudio", revision: 1,
}, null, 2) + "\n");

// ── done ────────────────────────────────────────────────────────────────────────────────────────────
log("plugin assembled.");
console.log(`\n  Next:\n    1) add a skill into ~/.skillforge (the home LM Studio reads):\n` +
            `         SKILLFORGE_HOME= node --experimental-strip-types packages/cli/src/bin.ts add <source>\n` +
            `    2) register the plugin (long-running watch — leave it running):\n` +
            `         cd ${dest} && lms dev\n` +
            `    3) in an LM Studio GUI chat, send a message matching the skill; confirm the block is\n` +
            `       prepended + persisted, then: tail -n 1 ~/.skillforge/inject.log.jsonl\n`);

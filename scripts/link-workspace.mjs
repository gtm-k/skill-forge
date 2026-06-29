// Zero-install workspace resolution: junction every packages/<pkg> with a package.json into
// node_modules/@skillforge/<name>. Node realpaths these on import, so --experimental-strip-types
// still applies (target is outside node_modules). A stand-in for `pnpm install` until deps are added.
// Dynamic so newly-added packages (cli, lmstudio-plugin, ui, ...) resolve without editing this file.
import { symlinkSync, mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const base = process.cwd();
const pkgsDir = join(base, "packages");
const scope = join(base, "node_modules", "@skillforge");
mkdirSync(scope, { recursive: true });

for (const dir of readdirSync(pkgsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const pkgJson = join(pkgsDir, dir.name, "package.json");
  if (!existsSync(pkgJson)) continue;
  let name;
  try {
    name = JSON.parse(readFileSync(pkgJson, "utf8")).name;
  } catch (e) {
    // never silent: a malformed package.json is surfaced, not skipped without trace.
    console.warn(`skip ${dir.name}: unreadable package.json (${e.message})`);
    continue;
  }
  if (!name?.startsWith("@skillforge/")) continue;
  const link = join(scope, name.slice("@skillforge/".length));
  if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(join(pkgsDir, dir.name), link, "junction");
  console.log(`linked ${name}`);
}

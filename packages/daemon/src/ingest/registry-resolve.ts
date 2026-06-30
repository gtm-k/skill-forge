// @skillforge/daemon/ingest/registry-resolve — the daemon's EDGE-OF-SYSTEM registry spawn (D24, §5, W6).
//
// core (@skillforge/core/source/registry) is deliberately child_process-free and takes an injected
// RegistryResolveFn; THIS file is the daemon's allowed edge spawn for the registry front door — the same
// pattern as ingest/git-clone.ts (the daemon, like the CLI, MAY spawn at its edge; the no-child_process
// lint is CORE-scoped). It materializes a registry skill (e.g. `npx skills add <name>`) INTO `dest`; core's
// resolveRegistry then realpath-PINS `dest` (dest-swap defence, D20) and walks it for SKILL.md — containment
// is wholly core's job, so this file only has to spawn SAFELY and fail LOUDLY.
//
// ── TRUST ASSUMPTION (read before changing the default) ──────────────────────────────────────────────────
// UNLIKE git-clone (which runs the operator's already-installed, known `git` binary against a validated
// https URL), `npx --yes skills` AUTO-INSTALLS AND EXECUTES whatever the npm registry resolves the package
// spec to. The DEFAULT spec is the BARE, UNSCOPED, UNPINNED name "skills" — i.e. `skills@latest`, a
// namesquat / dependency-confusion / supply-chain surface: a malicious publish (or a compromised maintainer)
// runs arbitrary code in the daemon's process on the next registry add. This is materially weaker than the
// git front door and is surfaced two ways (never silent): (1) the package spec is CONFIGURABLE so an
// operator can PIN it to a trusted "scope@version" (makeRegistryResolveFn({ packageSpec })); (2) running an
// UNPINNED spec emits a one-time console.warn. The token (the skill name) is still strictly validated below,
// but token validation does NOT bound what the resolved PACKAGE does — only pinning does.
//
// Hardening (mirrors git-clone): spawn() with an ARRAY argv and NO shell (no interpolation surface), plus a
// STRICT token validation BEFORE the spawn — the registry token can only be `name` / `scope/name` /
// `name@version`, so a hostile token can neither inject a second command nor smuggle a leading-dash option.
// Reject on a non-zero exit (or a spawn error) carrying the CLI's stderr tail — never a silent empty tree.
import { spawn } from "node:child_process";
import type { RegistryResolution, RegistryResolveFn } from "@skillforge/core";
import type { SourceRef } from "@skillforge/contracts";

/** The default npx package spec — BARE/UNSCOPED/UNPINNED (resolves to `skills@latest`). See the trust note;
 *  pin it to a trusted `scope@version` in production via makeRegistryResolveFn({ packageSpec }). */
export const DEFAULT_REGISTRY_PACKAGE = "skills";

/**
 * A safe registry identifier: an optional `@scope`, a name, an optional `/sub` segment, and an optional
 * `@version` — all from a conservative `[a-z0-9._-]` alphabet (case-insensitive), each segment STARTING
 * with an alphanumeric so a leading `-`/`.` (option injection / traversal) is impossible. No slashes beyond
 * the single scope separator, no whitespace, no shell metacharacters. This is the registry's analogue of
 * git-clone's assertHttpsUrl: a LOCAL guard at the spawn that does not trust the upstream classifier.
 */
const SAFE_REGISTRY_TOKEN = /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?:@[a-z0-9][a-z0-9._+-]*)?$/i;

export function assertSafeRegistryToken(token: string): void {
  if (token.length === 0 || token.length > 214 || !SAFE_REGISTRY_TOKEN.test(token)) {
    throw new Error(
      `refusing an unsafe registry token ${JSON.stringify(token)} — expected "name", "scope/name", or ` +
        `"name@version" (alphanumeric-led segments only, no shell metacharacters, no path traversal)`,
    );
  }
}

/** The npx command name (Windows resolves the npm shim via `npx.cmd`). The argv is array-only — the spawn
 *  below never uses a shell, so the token is passed as a single, non-interpolated argv element. */
function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

/** True when `packageSpec` carries a trailing `@version` pin (e.g. "skills@1.4.2", "@scope/pkg@1.0.0") —
 *  i.e. NOT resolved to `@latest`. A scoped name with no version ("@scope/pkg") is still UNPINNED. */
export function isPinnedPackageSpec(packageSpec: string): boolean {
  return /@[^/]+$/.test(packageSpec);
}

/**
 * Build the registry CLI argv (a PURE function — unit-testable without spawning). VALIDATES the token (so a
 * direct caller can never build an argv from an unvalidated token — defense in depth). Default front door:
 * `npx --yes <packageSpec> add <token>` run with cwd=`dest`, so the CLI materializes its skill tree UNDER
 * `dest` (wherever it lands, core.resolveRegistry walks it). `--yes` keeps npx non-interactive in a daemon
 * context. The validated token is the final positional arg; it can never be read as an option.
 */
export function registryArgv(token: string, packageSpec: string = DEFAULT_REGISTRY_PACKAGE): { command: string; args: string[] } {
  assertSafeRegistryToken(token);
  return { command: npxCommand(), args: ["--yes", packageSpec, "add", token] };
}

export interface RegistryResolveOptions {
  /** npx package spec to install+run. DEFAULT "skills" — UNPINNED (`@latest`). PIN to "skills@1.4.2" or a
   *  trusted "@scope/pkg@version" to remove the namesquat/supply-chain surface (see the trust note above). */
  packageSpec?: string;
}

/**
 * Build a RegistryResolveFn for an (optionally pinned) registry package. The returned fn spawns the CLI to
 * materialize `ref` INTO `dest`. No shell, array argv, validated token. Rejects on a spawn error (e.g.
 * npx/skills not on PATH) or a non-zero exit with the CLI's stderr tail — a registry source NEVER degrades
 * to a silent empty tree. An UNPINNED packageSpec emits a one-time supply-chain warning (never silent).
 */
export function makeRegistryResolveFn(opts: RegistryResolveOptions = {}): RegistryResolveFn {
  const packageSpec = opts.packageSpec ?? DEFAULT_REGISTRY_PACKAGE;
  let warnedUnpinned = false;

  return (ref: SourceRef, dest: string): Promise<RegistryResolution | void> => {
    const token = ref.input.trim();
    const { command, args } = registryArgv(token, packageSpec); // validates the token at the edge

    // never-silent supply chain: an UNPINNED spec runs whatever the registry resolves @latest to — surface
    // the trust assumption once so an operator can pin it, rather than silently executing remote code.
    if (!isPinnedPackageSpec(packageSpec) && !warnedUnpinned) {
      warnedUnpinned = true;
      console.warn(
        `[skillforge/daemon] registry resolve runs the UNPINNED npx package ${JSON.stringify(packageSpec)} ` +
          `(resolves to @latest — a namesquat/supply-chain surface). Pin it to a trusted scope@version via ` +
          `makeRegistryResolveFn({ packageSpec }).`,
      );
    }

    return new Promise<RegistryResolution | void>((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, { cwd: dest, stdio: ["ignore", "ignore", "pipe"] });
      } catch (err) {
        // e.g. Windows refusing to spawn a .cmd without a shell — surfaced, never swallowed.
        reject(new Error(`registry resolve could not start (is the "skills" CLI / npx available?): ${(err as Error).message}`));
        return;
      }
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        reject(new Error(`registry resolve could not start (is npx on PATH?): ${err.message}`));
      });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`registry resolve failed (exit ${code ?? "null"}) for ${JSON.stringify(token)}: ${stderr.trim()}`));
      });
    });
  };
}

/** The default RegistryResolveFn injected into resolveSource (W6): the UNPINNED `npx skills` front door.
 *  Operators wanting a pinned/trusted package pass `registry: makeRegistryResolveFn({ packageSpec })` to
 *  createDaemon (DaemonOptions.registry). core stamps provenance from ref.input either way. */
export const registryResolveFn: RegistryResolveFn = makeRegistryResolveFn();

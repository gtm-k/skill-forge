// @skillforge/mcp-server/catalog — the read-model-backed McpServerDeps (daemon-DOWN standalone path).
//
// This is the concrete data source the stdio bin uses: it READS the CLI-written read-model (manifest.json
// + sources/) and runs exec EXCLUSIVELY through core.run() (the one audited spawn chokepoint, D2). It owns
// NO writes to the read-model and NEVER spawns directly. It MIRRORS the daemon's POST /skills/:id/run gate
// (packages/daemon/src/server/routes/index.ts runSkillGated): resolve realpath-under-root → re-derive the
// bundle from on-disk bytes → recompute the contentHash → refuse unless exec is granted AND the on-disk
// hash still equals the granted hash → resolve the interpreter → validate the argv shape → apply §7 TRUST
// GATING (a source pinned to "dry-run", OR trust pins present but the source unresolvable ⇒ FAIL-CLOSED to
// dry-run) → DELEGATE to core.run(), which recomputes once more and audits exactly one line. The trust pin
// is visibly surfaced (McpRunOutcome.dryRun) so the actor SEES that the pin took effect — never silent.
// (The OWNER MCP RUN-MUTE (C4) is enforced HERE too, before the grant gate, via the SAME shared
// isMcpRunMuted predicate the daemon uses — so a muted skill is refused fail-closed even daemon-down,
// reading mcpRunMuted off the manifest entry. Conversation-scoped suppression (R1-B1) is the one daemon
// step with no standalone analogue — there is no conversation context in the stdio read-model path.)
//
// Why RE-DERIVE the bundle (vs. trusting manifest.bundle): the grant key is the canonical hash over the
// on-disk bytes (D10/D20). Re-walking the tree the SAME way ingest does (normalize-tree.collectBundleFiles
// + classifyBundleEntry) means an added/removed/edited file changes the recomputed hash → a hash-mismatch
// refusal ("you only run what you reviewed"), never a silent run of unreviewed bytes.

import path from "node:path";
import fs from "node:fs";
import {
  buildLexicalIndex,
  classifyBundleEntry,
  resolveUnderRoot,
  PathEscapeError,
  bundleContentHash,
  loadCatalog,
  loadInstructions,
  readJsonTolerant,
  run,
  // Wave C (D3): home + exec-gate helpers shared with the daemon (no longer replicated copies).
  skillforgeHome,
  sourcesPath,
  MANIFEST_FILE_NAME,
  EXEC_LOG_FILE,
  CONFIG_FILE_NAME,
  EXEC_ENV_ALLOWLIST,
  resolveInterpreterAbsolute,
  validateArgvShape,
  refusalLine,
  isMcpRunMuted,
  type ExecSkill,
  type ExecSink,
} from "@skillforge/core";
import type {
  BundleEntry,
  ExecRequest,
  ManifestReadModel,
  ManifestSkillEntry,
} from "@skillforge/contracts";
import type { TrustLevel } from "@skillforge/contracts/api";
import type {
  McpMenuItem,
  McpRefusalReason,
  McpResource,
  McpResourceOutcome,
  McpRunOutcome,
  McpServerDeps,
  McpSkillDetail,
} from "./deps.ts";

// ── home + layout + exec env allowlist: now @skillforge/core (Wave C / D3) — skillforgeHome / sourcesPath /
//    the layout names / EXEC_ENV_ALLOWLIST are imported above (the SAME implementation the daemon + CLI use,
//    no longer replicated copies). skillforgeHome is re-exported because mcp-server/index.ts re-exports it
//    from this module (consumed by bin.ts). ──
export { skillforgeHome };

// ── read-model access ────────────────────────────────────────────────────────────────────────────────
/** Read the raw manifest entries enabled for mcp (require an EXPLICIT enabledFor.mcp === true, mirroring
 *  loadCatalog + the daemon's enabledOnly filter). Tolerant of a missing/corrupt manifest → []. */
function readMcpEntries(home: string): ManifestSkillEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, MANIFEST_FILE_NAME), "utf8");
  } catch {
    return [];
  }
  let model: ManifestReadModel | undefined;
  try {
    model = JSON.parse(raw) as ManifestReadModel;
  } catch {
    return [];
  }
  const entries = Array.isArray(model?.skills) ? model.skills : [];
  return entries.filter((e) => e?.enabledFor?.mcp === true);
}

/** Find one mcp-enabled entry by id (preferred — unique) then slug. undefined when none matches. */
function findEntry(home: string, idOrSlug: string): ManifestSkillEntry | undefined {
  const entries = readMcpEntries(home);
  return entries.find((e) => e.id === idOrSlug) ?? entries.find((e) => e.slug === idOrSlug);
}

/** Tolerantly read the per-source trust pins (§7) from home/config.json. A missing/empty/corrupt config —
 *  OR a non-object `trustLevels` — yields {} (no pins). Mirrors the daemon's loadConfig→normalizeConfig
 *  semantics for the `trustLevels` field (carried through only when it is an object). NEVER throws. */
function loadTrustLevels(home: string): Record<string, TrustLevel> {
  const raw = readJsonTolerant<{ trustLevels?: unknown }>(path.join(home, CONFIG_FILE_NAME));
  const tl = raw?.trustLevels;
  return tl && typeof tl === "object" && !Array.isArray(tl) ? (tl as Record<string, TrustLevel>) : {};
}

// ── bundle re-derivation (mirrors source/normalize-tree.ts so the recomputed hash == the grant key) ────
/** Read every regular file under `skillRoot` as POSIX relPaths + bytes. Symlinks are skipped and every
 *  join passes through resolveUnderRoot, so a symlinked tree cannot leak bytes from outside the root. */
function collectBundleFiles(skillRoot: string): { relPath: string; bytes: Buffer }[] {
  const out: { relPath: string; bytes: Buffer }[] = [];
  const recurse = (absDir: string, relDir: string): void => {
    for (const d of fs.readdirSync(absDir, { withFileTypes: true })) {
      const childRel = relDir === "" ? d.name : `${relDir}/${d.name}`;
      const childAbs = resolveUnderRoot(skillRoot, childRel); // containment (throws on escape)
      if (d.isDirectory()) recurse(childAbs, childRel);
      else if (d.isFile()) out.push({ relPath: childRel, bytes: fs.readFileSync(childAbs) });
      // symlinks match neither branch → skipped
    }
  };
  recurse(skillRoot, "");
  return out;
}

/** Re-derive the bundle (sorted by relPath) from on-disk bytes — the SAME shape ingest computed, so
 *  bundleContentHash over it equals the stored grant key when the bytes are unchanged. */
function deriveBundle(skillRoot: string): BundleEntry[] {
  return collectBundleFiles(skillRoot)
    .map((f) => classifyBundleEntry(f.relPath, f.bytes))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

// interpreter resolution + argv-shape check: now @skillforge/core/exec/gate (Wave C / D3) — the SAME
// absolute-PATH-only resolver + NUL/non-string argv check the daemon route uses, so both surfaces gate
// identically (a drift here would be an interpreter-shadowing hole on one surface only).

// ── refusal audit (never-silent for the ops actor) ─────────────────────────────────────────────────────
/** Append one pre-spawn REFUSAL audit line to home/exec.log.jsonl, the SAME shape core.run writes for a real
 *  run — built via core's shared `refusalLine` (the line shape is single-sourced; only the IO is local). The
 *  IO FAILS SOFT: returns false on append failure (the caller maps that to an `audit-failed` refusal — never a
 *  silently-dropped guardrail event). */
function auditRefusal(home: string, slug: string, cwd: string, reason: string, contentHash: string): boolean {
  const line = refusalLine(slug, cwd, reason, contentHash, "mcp");
  try {
    const p = path.join(home, EXEC_LOG_FILE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(line)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ── group a bundle into per-kind relPath lists for the load_skill summary ──
function bundleSummary(bundle: BundleEntry[]): McpSkillDetail["bundle"] {
  const scripts: string[] = [];
  const references: string[] = [];
  const assets: string[] = [];
  for (const e of bundle) {
    if (e.kind === "script") scripts.push(e.relPath);
    else if (e.kind === "reference") references.push(e.relPath);
    else if (e.kind === "asset") assets.push(e.relPath);
    // "instructions" (SKILL.md) is delivered as the body, not listed as a bundle file here
  }
  return { scripts, references, assets };
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  rst: "text/plain",
  json: "application/json",
};

function mimeForRelPath(relPath: string): string {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "text/plain";
}

const RESOURCE_SCHEME = "skillforge://";

/** Parse `skillforge://<slug>/<relPath>` → { slug, relPath }. undefined for a non-matching/empty uri. */
function parseResourceUri(uri: string): { slug: string; relPath: string } | undefined {
  if (!uri.startsWith(RESOURCE_SCHEME)) return undefined;
  const rest = uri.slice(RESOURCE_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined; // need a non-empty slug AND a relPath
  const slug = rest.slice(0, slash);
  const relPath = rest.slice(slash + 1);
  if (slug === "" || relPath === "") return undefined;
  return { slug, relPath };
}

/**
 * Build the read-model-backed deps for a given home. The stdio bin wires this; Wave B supplies a
 * live-daemon implementation of the SAME McpServerDeps interface instead.
 */
export function createReadModelDeps(home: string, version: string): McpServerDeps {
  return {
    version,

    listSkills(query?: string): McpMenuItem[] {
      const cat = loadCatalog(home, "mcp");
      let skills = cat.skills;
      if (query && query.trim() !== "") {
        // Lexical RE-ORDER only (host-driven, R1-B2): the host still picks; we never narrow to a choice.
        const lex = buildLexicalIndex(skills);
        const order = new Map(lex.rank(query).map((m, i) => [m.slug, i]));
        skills = [...skills].sort((a, b) => (order.get(a.slug) ?? Infinity) - (order.get(b.slug) ?? Infinity));
      }
      return skills.map((s) => ({ id: s.id ?? "", slug: s.slug, name: s.name, description: s.description }));
    },

    loadSkill(idOrSlug: string): McpSkillDetail | undefined {
      const entry = findEntry(home, idOrSlug);
      if (!entry) return undefined;
      const detail: McpSkillDetail = {
        id: entry.id,
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        instructions: "",
        execAllowed: entry.execAllowed === true,
        bundle: bundleSummary(Array.isArray(entry.bundle) ? entry.bundle : []),
      };
      if (entry.capabilities) detail.capabilities = entry.capabilities;
      if (entry.mcpRunMuted) detail.mcpRunMuted = true; // C4: a humble heads-up so the host expects the refusal
      try {
        detail.instructions = loadInstructions(home, entry.dir);
      } catch (e) {
        // never-silent: the skill exists but its body could not be read (traversal/missing) — surface it.
        detail.instructionsError = (e as Error).message;
      }
      return detail;
    },

    async runScript(idOrSlug: string, script: string, args: string[]): Promise<McpRunOutcome> {
      const entry = findEntry(home, idOrSlug);
      if (!entry) {
        const ok = auditRefusal(home, "(unknown)", idOrSlug, `refusing to run: no mcp skill ${JSON.stringify(idOrSlug)}`, "");
        return ok
          ? { ok: false, reason: "not-found", detail: `no mcp-enabled skill matches ${JSON.stringify(idOrSlug)}` }
          : { ok: false, reason: "audit-failed", detail: "could not record the refusal audit line" };
      }

      // 1. resolve the skill's materialized root under sources/.
      let skillRoot: string;
      try {
        skillRoot = resolveUnderRoot(sourcesPath(home), entry.dir);
      } catch (e) {
        return finishRefusal(home, entry.slug, entry.dir, "bundle-unreadable",
          `the skill's materialized tree is unavailable — ${(e as Error).message}`, "");
      }

      // 2. resolve the requested script realpath-UNDER the skill root — reject traversal/symlink escape.
      try {
        resolveUnderRoot(skillRoot, script);
      } catch (e) {
        if (!(e instanceof PathEscapeError)) throw e;
        return finishRefusal(home, entry.slug, skillRoot, "path-escape", (e as Error).message, "");
      }

      // 3. re-derive the bundle from on-disk bytes + recompute the canonical contentHash (the grant key).
      let bundle: BundleEntry[];
      let recomputed: string;
      try {
        bundle = deriveBundle(skillRoot);
        recomputed = bundleContentHash(bundle.map((b) => ({ relPath: b.relPath, hash: b.hash })));
      } catch (e) {
        return finishRefusal(home, entry.slug, skillRoot, "bundle-unreadable",
          `cannot recompute the bundle hash from on-disk bytes — ${(e as Error).message}`, "");
      }

      // 3b. OWNER MCP RUN-MUTE (C4): the SAME shared predicate the daemon's live /mcp path uses (D3) — a
      //     human-set, persisted, NON-ROTATABLE pause of MCP runs, fail-closed HERE too (daemon-down). Checked
      //     before the grant gate; the skill stays visible/readable (only the run is refused). The detail names
      //     the owner-mute so the host can tell it apart from a conversation suppression (both are `suppressed`).
      if (isMcpRunMuted(entry.mcpRunMuted, "mcp")) {
        return finishRefusal(home, entry.slug, skillRoot, "suppressed",
          `${JSON.stringify(entry.slug)} is muted for MCP runs by the owner (re-enable in SkillForge)`, recomputed);
      }

      // 4. GRANT GATE (D2/D10): exec must be granted AND the on-disk hash must still equal the granted one.
      if (entry.execAllowed !== true || typeof entry.contentHash !== "string" || entry.contentHash === "") {
        return finishRefusal(home, entry.slug, skillRoot, "no-grant",
          `exec is not granted for ${JSON.stringify(entry.slug)} (default-deny — D2)`, recomputed,
          entry.contentHash, recomputed);
      }
      if (recomputed !== entry.contentHash) {
        return finishRefusal(home, entry.slug, skillRoot, "hash-mismatch",
          `the on-disk bundle no longer matches the granted contentHash (granted ${entry.contentHash}, ` +
          `on-disk ${recomputed}) — re-review required (D10/D20)`, recomputed, entry.contentHash, recomputed);
      }

      // 5. the script must be an executable BUNDLED script (run with its DERIVED interpreter).
      const norm = script.replace(/\\/g, "/");
      const be = bundle.find((b) => b.relPath === norm);
      if (!be || !be.exec?.interpreter) {
        return finishRefusal(home, entry.slug, skillRoot, "not-a-script",
          `${JSON.stringify(script)} is not an executable script in the bundle`, recomputed,
          entry.contentHash, recomputed);
      }

      // 6. resolve the interpreter to an ABSOLUTE path — refuse rather than spawn an unlocatable bare name.
      const interpAbs = resolveInterpreterAbsolute(be.exec.interpreter);
      if (!interpAbs) {
        return finishRefusal(home, entry.slug, skillRoot, "interpreter-unresolved",
          `cannot locate interpreter ${JSON.stringify(be.exec.interpreter)} on an absolute PATH entry`,
          recomputed, entry.contentHash, recomputed);
      }
      const scriptAbs = resolveUnderRoot(skillRoot, script); // already proven safe in step 2

      // 7. validate the FULL argv shape BEFORE delegating. A spawn-shape problem (e.g. a NUL byte in a
      //    caller arg) is refused with an ACCURATE `bad-args` reason here — not mislabeled hash-mismatch by
      //    the TOCTOU mapping below, and never thrown synchronously out of core.run's spawn().
      const argv = [interpAbs, scriptAbs, ...args];
      const argvError = validateArgvShape(argv);
      if (argvError) {
        return finishRefusal(home, entry.slug, skillRoot, "bad-args",
          `the requested argv is not spawn-safe — ${argvError}`, recomputed, entry.contentHash, recomputed);
      }

      // 8. TRUST GATING (§7), FAIL-CLOSED — the daemon route's step 7 (runSkillGated). A source pinned to
      //    "dry-run" forces dry-run; AND if trust pins exist but THIS skill's source cannot be resolved,
      //    assume the strictest (dry-run) — never spawn for real past an un-checkable pin. The pin is then
      //    surfaced on the outcome so the actor SEES it took effect (the (dry-run) suffix in tools.ts).
      const sourceId = entry.provenance?.[0]?.sourceId;
      const trustLevels = loadTrustLevels(home);
      const hasPins = Object.keys(trustLevels).length > 0;
      const trust = sourceId ? trustLevels[sourceId] : undefined;
      const dryRun = trust === "dry-run" || (hasPins && !sourceId);

      // 9. DELEGATE to core.run — the ONLY spawn path. It recomputes the hash AGAIN (belt-and-suspenders,
      //    D20) and audits exactly one line to exec.log.jsonl via logPath. On dry-run it records the intent
      //    and returns WITHOUT spawning (exit:null, stderrTail "dry-run: …").
      const execSkill: ExecSkill = {
        slug: entry.slug,
        rootDir: skillRoot,
        bundle,
        grantedContentHash: entry.contentHash,
      };
      const execRequest: ExecRequest = {
        argv,
        cwd: skillRoot,
        envAllowlist: [...EXEC_ENV_ALLOWLIST],
        ...(dryRun ? { dryRun: true } : {}),
      };
      const sink: ExecSink = {}; // tails come back on the result; the durable audit is the logPath append
      let result;
      try {
        result = await run(execSkill, execRequest, sink, { logPath: path.join(home, EXEC_LOG_FILE) });
      } catch (e) {
        // core.run rejects only when its OWN durable audit append fails — fail closed, visibly (never silent).
        return { ok: false, reason: "audit-failed", detail: (e as Error).message };
      }

      // core.run REFUSES pre-spawn (rare TOCTOU: bytes changed between OUR recompute and core's) by returning
      // exit:null + a "refusing to spawn:" reason. It already wrote the audit line, so map it to a NAMED
      // refusal (no double audit) rather than report a phantom success.
      if (result.exit === null && result.stdoutTail === "" && result.stderrTail.startsWith("refusing to spawn:")) {
        const reason = /cannot recompute/.test(result.stderrTail)
          ? "bundle-unreadable"
          : /cwd escapes/.test(result.stderrTail)
            ? "path-escape"
            : "hash-mismatch";
        return { ok: false, reason, detail: result.stderrTail, grantedHash: entry.contentHash, currentHash: result.contentHash };
      }

      return { ok: true, result, dryRun };
    },

    listResources(): McpResource[] {
      const out: McpResource[] = [];
      for (const entry of readMcpEntries(home)) {
        const bundle = Array.isArray(entry.bundle) ? entry.bundle : [];
        for (const b of bundle) {
          if (b.kind !== "reference") continue;
          out.push({
            uri: `${RESOURCE_SCHEME}${entry.slug}/${b.relPath}`,
            name: `${entry.slug}/${b.relPath}`,
            description: `Reference for skill "${entry.name}"`,
            mimeType: mimeForRelPath(b.relPath),
          });
        }
      }
      return out;
    },

    readResource(uri: string): McpResourceOutcome {
      const parsed = parseResourceUri(uri);
      if (!parsed) return { ok: false, reason: "invalid-uri", detail: `not a ${RESOURCE_SCHEME}<slug>/<relPath> uri: ${JSON.stringify(uri)}` };
      const entry = findEntry(home, parsed.slug);
      if (!entry) return { ok: false, reason: "not-found", detail: `no mcp-enabled skill with slug ${JSON.stringify(parsed.slug)}` };
      // REFERENCES-ONLY surface: listResources advertises ONLY kind==="reference" files, so a read MUST
      // match one. A request for any OTHER contained file (a script, SKILL.md, an asset) is refused with a
      // NAMED reason — not a silent read of an unintended file — even though resolveUnderRoot would contain it.
      const normRel = parsed.relPath.replace(/\\/g, "/");
      const bundle = Array.isArray(entry.bundle) ? entry.bundle : [];
      const ref = bundle.find((b) => b.relPath === normRel && b.kind === "reference");
      if (!ref) {
        return { ok: false, reason: "not-a-reference", detail: `${JSON.stringify(parsed.relPath)} is not a reference resource of skill ${JSON.stringify(parsed.slug)}` };
      }
      let abs: string;
      try {
        const skillRoot = resolveUnderRoot(sourcesPath(home), entry.dir);
        abs = resolveUnderRoot(skillRoot, parsed.relPath); // containment — never escapes home
      } catch (e) {
        if (e instanceof PathEscapeError) return { ok: false, reason: "path-escape", detail: (e as Error).message };
        throw e;
      }
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch (e) {
        return { ok: false, reason: "unreadable", detail: (e as Error).message };
      }
      return { ok: true, contents: { uri, mimeType: mimeForRelPath(parsed.relPath), text } };
    },
  };
}

/** Audit a pre-spawn refusal then return the NAMED outcome (audit failure overrides to `audit-failed`). */
function finishRefusal(
  home: string,
  slug: string,
  cwd: string,
  reason: Exclude<McpRefusalReason, "audit-failed">,
  detail: string,
  contentHash: string,
  grantedHash?: string,
  currentHash?: string,
): McpRunOutcome {
  const audited = auditRefusal(home, slug, cwd, `refusing to run: ${detail}`, contentHash);
  if (!audited) return { ok: false, reason: "audit-failed", detail: "could not record the refusal audit line" };
  const out: Extract<McpRunOutcome, { ok: false }> = { ok: false, reason, detail };
  if (grantedHash !== undefined) out.grantedHash = grantedHash;
  if (currentHash !== undefined) out.currentHash = currentHash;
  return out;
}

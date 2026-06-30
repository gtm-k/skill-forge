// @skillforge/ui/select-handler — the READ-ONLY data layer behind the visual manager (PLAN §9, D12).
//
// This module is the ONE place the UI talks to the runtime, and it does so by REUSING @skillforge/core
// for every load-bearing step (D3: one select() implementation, period). It NEVER writes, NEVER spawns,
// NEVER reimplements routing/injection/path-safety. It only:
//   • reads the CLI-written read-model (core.readJsonTolerant — last-good tolerant, pollution-stripped),
//   • runs core.tieredSelect over the manifest's slug/name/description (+ optional query embedding),
//   • lazily loads the chosen skill's SKILL.md body (via core.resolveUnderRoot — containment-checked) and
//     hands it to core.buildInjection, and
//   • returns a JSON-able RouteResult that INCLUDES the ROUTING thresholds so the UI can render exactly
//     where the top score sits relative to θ — making "inject nothing" (mode "none") legible, not silent.
//
// HUMBLE + observability-first: the result reports what we MEASURED (bytes, token cost, disclosure) and
// what we NOTICED (capabilities live on the manifest entries). A degraded semantic path (the query
// embedder unavailable) is surfaced as `semantic.degraded`, never hidden behind a silent lexical result.
import path from "node:path";
import fs from "node:fs";
import {
  buildLexicalIndex,
  tieredSelect,
  buildInjection,
  resolveUnderRoot,
  readJsonTolerant,
  type SelectInputs,
} from "@skillforge/core";
import {
  ROUTING,
  SCHEMA_VERSION,
  type InjectionPolicy,
  type ManifestReadModel,
  type ManifestSkillEntry,
  type SelectionMode,
  type SkillManifest,
  type TargetId,
} from "@skillforge/contracts";

// ── fixed home layout (owned by @skillforge/cli/home; mirrored here as a const because the UI must not
//    depend on the cli package — only core + contracts). The read-model also carries `sourcesDir`, which
//    we honor when present so a future layout change stays single-sourced. ──
const MANIFEST_FILE_NAME = "manifest.json";
const DEFAULT_SOURCES_DIR_NAME = "sources";
const SKILL_FILE_NAME = "SKILL.md";

/**
 * A generous per-target injection budget for the route TESTER. The UI is read-only and only ever
 * RENDERS the would-be injection, so we choose a budget high enough that a confident full body is shown
 * verbatim (the point of the tester) rather than surprise-downgraded to a menu. buildInjection still
 * enforces tokenCost <= maxTokens, so the displayed block is always a faithful, budget-bound preview.
 */
const UI_INJECT_POLICY: InjectionPolicy = { maxTokens: 8000, menuOnAmbiguous: true, maxMenuItems: 5 };

/** Maps a single query to its embedding vector; resolves to undefined on any failure (→ lexical-only). */
export type QueryEmbedder = (text: string) => Promise<number[] | undefined>;

export interface RouteResult {
  mode: string;
  chosen: { slug: string; score: number; tier: SelectionMode; reasons: string[] } | null;
  candidates: { slug: string; name: string; score: number; tier: SelectionMode; reasons: string[] }[];
  ambiguous: boolean;
  injection: {
    disclosure: string;
    text: string;
    injectedBytes: number;
    tokenCost: number;
    injectedSlugs: string[];
  };
  thresholds: { lexicalFireThreshold: number; semanticFireThreshold: number; ambiguityEpsilon: number };
  /**
   * Observability for the semantic tier — drives the UI's "degraded to lexical" banner. `available` is
   * true only when we actually ran the semantic cascade (manifest vectors + a query vector both present);
   * `degraded` is true when semantic was POSSIBLE (manifest carries vectors and an embedder was supplied)
   * but the query embed failed, so the result silently fell back to lexical — we make that visible.
   */
  semantic: { available: boolean; degraded: boolean; note: string };
}

/** Tolerant read of the CLI-written read-model. undefined when absent/empty/corrupt (last-good semantics). */
export function loadManifest(home: string): ManifestReadModel | undefined {
  const manifestPath = resolveUnderRoot(home, MANIFEST_FILE_NAME); // contained under home
  return readJsonTolerant<ManifestReadModel>(manifestPath);
}

/** The materialized-trees dir name for this home (read-model wins; else the fixed default). */
function sourcesDirName(model: ManifestReadModel | undefined): string {
  return typeof model?.sourcesDir === "string" && model.sourcesDir.length > 0
    ? model.sourcesDir
    : DEFAULT_SOURCES_DIR_NAME;
}

/** True when an entry is enabled for `target`. enabledFor defaults ON (a missing key is treated as on). */
function enabledForTarget(entry: ManifestSkillEntry, target: TargetId): boolean {
  return entry.enabledFor?.[target] !== false;
}

/**
 * List the manifest entries for the browser / inspect drawer (capabilities + bundle included). Optionally
 * filtered to a target. The heavy per-skill `embedding` vector is STRIPPED — the browser never needs it
 * (semantic re-rank happens server-side in routeQuery), and shipping 768 floats × N skills would bloat
 * the payload for no UI benefit. This is a read-only projection of the read-model; it never mutates disk.
 */
export function listSkills(home: string, target?: TargetId): Omit<ManifestSkillEntry, "embedding">[] {
  const model = loadManifest(home);
  if (!model || !Array.isArray(model.skills)) return [];
  const entries = target ? model.skills.filter((e) => enabledForTarget(e, target)) : model.skills;
  return entries.map(({ embedding: _embedding, ...rest }) => rest);
}

/**
 * Read one skill's SKILL.md body for the inspect drawer. `dir` is the read-model `entry.dir`
 * (POSIX `<sourceId>/<sourceRelPath>`, relative to sourcesDir). Containment is enforced by
 * resolveUnderRoot: a `dir` that escapes home (e.g. "../../etc/passwd") throws PathEscapeError rather
 * than reading outside the tree — the REFUSAL the UI relies on. A genuinely-missing body throws a clear
 * error (never a silent empty string for the actor reading the drawer).
 */
export function readInstructions(home: string, dir: string): string {
  const model = loadManifest(home);
  const rel = path.posix.join(sourcesDirName(model), dir, SKILL_FILE_NAME);
  const abs = resolveUnderRoot(home, rel); // throws PathEscapeError on escape — the containment refusal
  return fs.readFileSync(abs, "utf8");
}

/** Project a read-model entry to the minimal SkillManifest the lexical index + buildInjection consume. */
function toSkillManifest(entry: ManifestSkillEntry, instructions = ""): SkillManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    instructions,
    bodyLen: instructions.length,
    tokenEstimate: Math.ceil(instructions.length / 4),
    warnings: [],
  };
}

/**
 * Route `query` against the home's manifest for `target` and return a fully JSON-able RouteResult.
 *
 * REUSE-ONLY: tiered selection is core.tieredSelect, injection is core.buildInjection, every read is
 * containment-checked by core.resolveUnderRoot. `embed` is INJECTABLE: pass null/undefined for
 * lexical-only (hermetic tests + offline), or the server's LM Studio query embedder for the live
 * semantic tier. The semantic tier runs only when the manifest carries per-skill vectors AND the query
 * embed succeeds; a manifest with vectors + a failing embedder reports `semantic.degraded` (never silent).
 */
export async function routeQuery(
  home: string,
  query: string,
  target: TargetId,
  embed?: QueryEmbedder | null,
): Promise<RouteResult> {
  const model = loadManifest(home);
  const allEntries = model && Array.isArray(model.skills) ? model.skills : [];
  const entries = allEntries.filter((e) => enabledForTarget(e, target));

  const skills = entries.map((e) => toSkillManifest(e));
  const lexIndex = buildLexicalIndex(skills);

  // Semantic tier is only meaningful when EVERY in-scope skill carries a vector (a mixed corpus would
  // unfairly advantage the embedded ones in cosine ranking). Otherwise we stay lexical-only.
  const manifestHasVectors =
    entries.length > 0 && entries.every((e) => Array.isArray(e.embedding) && e.embedding.length > 0);
  const skillVecs = manifestHasVectors ? entries.map((e) => e.embedding ?? []) : undefined;

  let queryVec: number[] | undefined;
  let degraded = false;
  if (manifestHasVectors && typeof embed === "function") {
    queryVec = (await embed(query)) ?? undefined;
    if (!queryVec) degraded = true; // wanted semantic, embedder/endpoint unavailable → fell back to lexical
  }

  const inputs: SelectInputs = { skills, lexIndex };
  if (queryVec && skillVecs) {
    inputs.queryVec = queryVec;
    inputs.skillVecs = skillVecs;
  }
  const sel = tieredSelect(query, inputs);

  // Lazily load the chosen skill's body so buildInjection can render the full disclosure verbatim. Only
  // the confident-single-match path reads a body; the ambiguous menu path uses name+description only.
  let injectSkills = skills;
  if (sel.chosen) {
    const chosenEntry = entries.find((e) => e.slug === sel.chosen?.slug);
    if (chosenEntry) {
      let body = "";
      try {
        body = readInstructions(home, chosenEntry.dir);
      } catch {
        body = ""; // a missing/unreadable body must not crash the route — render header-only, observable as empty
      }
      injectSkills = skills.map((s) => (s.slug === chosenEntry.slug ? toSkillManifest(chosenEntry, body) : s));
    }
  }
  const inj = buildInjection(sel, injectSkills, UI_INJECT_POLICY);

  const nameBySlug = new Map(entries.map((e) => [e.slug, e.name]));
  return {
    mode: sel.mode,
    chosen: sel.chosen
      ? { slug: sel.chosen.slug, score: sel.chosen.score, tier: sel.chosen.tier, reasons: sel.chosen.reasons }
      : null,
    candidates: sel.candidates.map((c) => ({
      slug: c.slug,
      name: nameBySlug.get(c.slug) ?? c.slug,
      score: c.score,
      tier: c.tier,
      reasons: c.reasons,
    })),
    ambiguous: sel.ambiguous,
    injection: {
      disclosure: inj.disclosure,
      text: inj.text,
      injectedBytes: inj.injectedBytes,
      tokenCost: inj.tokenCost,
      injectedSlugs: inj.injectedSlugs,
    },
    thresholds: {
      lexicalFireThreshold: ROUTING.lexicalFireThreshold,
      semanticFireThreshold: ROUTING.semanticFireThreshold,
      ambiguityEpsilon: ROUTING.ambiguityEpsilon,
    },
    semantic: {
      available: queryVec !== undefined,
      degraded,
      note: queryVec
        ? "semantic tier active"
        : degraded
          ? "embeddings endpoint unavailable — degraded to lexical"
          : manifestHasVectors
            ? "no query embedder supplied — lexical only"
            : "manifest carries no embeddings — lexical only",
    },
  };
}

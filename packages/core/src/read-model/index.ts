// @skillforge/core/read-model — CONSUME the CLI-written read-model (manifest.json + sources/).
//
// The plugin is a pure READER of what `skill-forge add` produced (PLAN §4.1, §5). It NEVER writes the
// read-model and NEVER re-derives identity — it reconstructs the routing snapshot (SkillManifest[]) +
// the per-skill vectors/dirs the runtime needs, all from home. Every disk read routes through core's
// containment-safe primitives (readJsonTolerant for the untrusted manifest, resolveUnderRoot for the
// SKILL.md body) so a corrupt/partial manifest never throws and no read can escape `home`.
//
// Bodies are loaded LAZILY (loadInstructions), not eagerly: routing only needs name+description, and we
// only pay to read a SKILL.md body for the handful of skills an actual selection will inject (D15/§6).
import fs from "node:fs";
import path from "node:path";
import { readJsonTolerant } from "../safe/io.ts";
import { resolveUnderRoot } from "../safe/path.ts";
import { parseFrontmatter } from "../normalize.ts";
import {
  SCHEMA_VERSION,
  type ManifestReadModel,
  type SkillManifest,
  type TargetId,
} from "@skillforge/contracts";

/** Fixed home layout (owned by the CLI; mirrored here as constants — we never import the CLI). */
const MANIFEST_FILE = "manifest.json";
const SOURCES_DIR = "sources";

/** The reconstructed routing snapshot + the side-tables the runtime needs, all derived from `home`. */
export interface LoadedCatalog {
  /** routing-ready manifests (instructions:"" — loaded lazily by dir, see loadInstructions). Each carries
   *  `id`/`contentHash`/`embedding` so the runtime can build the SAME contentHash-keyed Tier-2 index the
   *  daemon does and run ONE semantic-primary cascade (selectWithEscalation, D26 — W6 parity). */
  skills: SkillManifest[];
  /** per-skill materialized dir (`<sourceId>/<relPath>`, relative to sources/) for the lazy body load. */
  dirBySlug: Map<string, string>;
  /** the read-model's embedding dim — fed to the EmbeddingIndex so a stored vector is validated/rejected
   *  the EXACT way the daemon validates it (parity); absent when nothing was embedded. */
  embeddingDim?: number;
  home: string;
}

/**
 * Load + reconstruct the routing catalog from home/manifest.json. Tolerant of an absent/corrupt/partial
 * manifest (readJsonTolerant returns undefined → an empty catalog, never a throw). Entries explicitly
 * enabled for `target` ONLY when enabledFor[target] === true (mirroring the daemon's enabledOnly filter,
 * skill_enable.enabled = 1) — so the plugin's routing pool is byte-identical to what the daemon's
 * route-test sees. Every manifest writer (CLI buildEntry + daemon entryFromRow) stamps all three targets
 * explicitly, so this never hides an out-of-the-box skill; a hand-edited manifest with a MISSING flag is
 * excluded here exactly as the daemon excludes it (no Test-vs-fires pool drift).
 */
export function loadCatalog(home: string, target: TargetId = "lmstudio"): LoadedCatalog {
  const model = readJsonTolerant<ManifestReadModel>(path.join(home, MANIFEST_FILE));
  const entries = Array.isArray(model?.skills) ? model.skills : [];

  const skills: SkillManifest[] = [];
  const dirBySlug = new Map<string, string>();

  for (const e of entries) {
    if (e?.enabledFor?.[target] !== true) continue; // require an EXPLICIT enable (mirrors daemon enabledOnly)
    const m: SkillManifest = {
      schemaVersion: SCHEMA_VERSION,
      slug: e.slug,
      name: e.name,
      description: e.description,
      instructions: "", // lazy — see loadInstructions; routing needs only name+description
      bodyLen: e.bodyLen,
      tokenEstimate: e.tokenEstimate,
      warnings: [],
    };
    // id + contentHash key the Tier-2 alignment (vectors keyed by contentHash, the SAME as the daemon);
    // embedding is the precomputed ingest vector. All optional/additive — absent on a pre-Tier-2 manifest.
    if (e.id !== undefined) m.id = e.id;
    if (e.contentHash !== undefined) m.contentHash = e.contentHash;
    if (Array.isArray(e.embedding)) m.embedding = e.embedding;
    skills.push(m);
    dirBySlug.set(e.slug, e.dir);
  }

  const catalog: LoadedCatalog = { skills, dirBySlug, home };
  if (typeof model?.embeddingDim === "number") catalog.embeddingDim = model.embeddingDim;
  return catalog;
}

/**
 * Lazily read a skill's instructions BODY (the SKILL.md content after frontmatter) for injection.
 * `dir` is the read-model's `<sourceId>/<relPath>` (relative to sources/), so the on-disk file lives at
 * home/sources/<dir>/SKILL.md. resolveUnderRoot canonicalizes + asserts containment under `home` — a
 * manifest dir that tried to traverse out (or a symlinked tree) can NEVER make this read escape home.
 * Reuses core's parseFrontmatter so the frontmatter-stripping is identical to ingest/normalize.
 */
export function loadInstructions(home: string, dir: string): string {
  const abs = resolveUnderRoot(home, `${SOURCES_DIR}/${dir}/SKILL.md`);
  const text = fs.readFileSync(abs, "utf8");
  return parseFrontmatter(text).body;
}

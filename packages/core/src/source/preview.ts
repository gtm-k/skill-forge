// @skillforge/core/source/preview — the BEFORE-COMMIT capability + provenance preview (§5, §9, D14).
//
// HUMBLE (D14): a SourcePreview is an INVENTORY of what we NOTICED across the skills a source would add —
// "adds N skills carrying M scripts; K flagged" — NEVER a "safe/verified" verdict. It surfaces counts,
// the UNION of capability flags, a per-skill row, and every parse warning, so the actor can review
// before committing (actor-observability). It computes nothing new: it aggregates the manifests
// normalizeTree already produced. Pure — no filesystem, no network, no execution.
import type {
  CapabilityFlag,
  SkillCapabilities,
  SkillManifest,
  SourceRef,
  ValidationIssue,
} from "@skillforge/contracts";
import type { SourcePreview } from "@skillforge/contracts/api";

// Stable presentation order for the flag union (mirrors capability.ts FLAG_ORDER — kept local so this
// module does not reach into capability.ts internals; the 6 flags are the frozen CapabilityFlag set).
const FLAG_ORDER: readonly CapabilityFlag[] = ["network", "pipe-to-shell", "destructive", "eval", "install", "fs-write"];

const EMPTY_CAPS: SkillCapabilities = { scriptCount: 0, interpreters: [], commands: [], flags: [] };

/**
 * Build the pre-commit SourcePreview for the skills `manifests` (the output of normalizeTree for one
 * source). `scriptCount` is summed across skills; `flaggedCount` is the number of skills carrying at
 * least one capability flag; `flags` is the union in canonical order; `warnings` is the de-duplicated
 * union of every skill's parse warnings. Humble inventory only — no verdict (D14).
 */
export function buildSourcePreview(ref: SourceRef, manifests: SkillManifest[]): SourcePreview {
  const flagUnion = new Set<CapabilityFlag>();
  let scriptCount = 0;
  let flaggedCount = 0;

  const skills = manifests.map((m) => {
    const caps = m.capabilities ?? EMPTY_CAPS;
    scriptCount += caps.scriptCount;
    if (caps.flags.length > 0) flaggedCount++;
    for (const f of caps.flags) flagUnion.add(f);
    return { slug: m.slug, name: m.name, description: m.description, capabilities: caps };
  });

  // De-dup the warning union by (level|field|msg) so the preview stays readable across many skills.
  const seen = new Set<string>();
  const warnings: ValidationIssue[] = [];
  for (const m of manifests) {
    for (const w of m.warnings) {
      const key = `${w.level}|${w.field ?? ""}|${w.msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(w);
    }
  }

  return {
    ref,
    skillCount: manifests.length,
    scriptCount,
    flaggedCount,
    flags: FLAG_ORDER.filter((f) => flagUnion.has(f)),
    skills,
    warnings,
  };
}

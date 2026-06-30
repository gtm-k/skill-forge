// @skillforge/core/inject — BOUNDARY 3: the channel-AGNOSTIC injection content
// builder (D15, R1-B1; §6). Core emits WHAT to inject (the rendered content), never
// WHERE it lands. It must not know whether the host will persist the text (LM Studio
// rewrites the user turn) or treat it as ephemeral (proxy / system-ephemeral) — that
// placement decision belongs to each target adapter, not here.
//
// It decides menu vs full vs none and MEASURES injectedBytes on the FINAL text. That
// measurement is the only thing that makes the hand-off self-verifying (D11): the host
// echoes back what it injected and the byte count is compared, no trust required.
//
// HUMBLE framing: this module reports what we *rendered and measured* — bytes, token
// estimate, disclosure level. It never asserts a skill is "safe" / "verified" / "trusted";
// it only ever inserts the instructions body, never scripts or references (§6 progressive
// disclosure), so an injected block can never smuggle an executable PAYLOAD as text.
// Two further invariants are enforced here, not assumed:
//   (1) BUDGET — every returned content satisfies tokenCost <= policy.maxTokens. The menu
//       and downgraded-menu paths are shrunk (drop items / truncate descriptions) or fall
//       to disclosure "none" so a sticky channel (LM Studio user-turn rewrite) can never be
//       handed an over-budget block.
//   (2) METADATA SANITIZATION — skill NAME + DESCRIPTION come from untrusted sourced
//       frontmatter, so they are collapsed to a single line, stripped of control chars and
//       length-capped before rendering. A description carrying newlines or "IGNORE PREVIOUS
//       INSTRUCTIONS …" can therefore not smuggle a second instruction line into the menu.
//       The renderFull instructions BODY stays verbatim — that body IS the intended skill
//       content (progressive disclosure), not metadata. Everything stays deterministic.

import type {
  Disclosure,
  InjectionContent,
  InjectionPolicy,
  Selection,
  SkillManifest,
} from "@skillforge/contracts";

const DEFAULT_MAX_MENU_ITEMS = 5;

/** Length caps for untrusted metadata. Names are short labels; descriptions one sentence. */
const NAME_CAP = 80;
const DESC_CAP = 200;

/**
 * Description caps tried (generous → terse, finally 0 = name-only) when a menu must be
 * shrunk to fit the token budget. Deterministic, fixed order; keeps the highest-ranked
 * items by truncating their descriptions before dropping whole items.
 */
const DESC_SHRINK_CAPS = [DESC_CAP, 120, 80, 40, 20, 8, 0] as const;

/** A char≈4-bytes token estimate, matching normalize.ts (tokenEstimate). Final text only. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Sanitize one piece of UNTRUSTED metadata (name/description from sourced frontmatter):
 * strip C0/C1 control characters + DEL (the \p{Cc} category — includes newline, CR, tab),
 * collapse every remaining run of whitespace (incl. NBSP and U+2028/U+2029 line separators)
 * to a single space, trim, then cap length with a single-char ellipsis. GUARANTEE: the
 * result contains no newline/control byte and has length <= cap, so it can never break out
 * of its menu line or carry a second "instruction" line. cap <= 0 yields "" (used by the
 * budget shrinker to drop a description entirely).
 */
function oneLine(s: string, cap: number): string {
  if (cap <= 0) return "";
  const cleaned = s
    .replace(/\p{Cc}/gu, " ") // C0/C1 control chars + DEL (incl. \n \r \t) → space
    .replace(/\s+/g, " ") // collapse all whitespace runs to one space
    .trim();
  if (cleaned.length <= cap) return cleaned;
  // Reserve one code unit for the ellipsis so the result length never exceeds cap.
  return cleaned.slice(0, cap - 1).trimEnd() + "…";
}

/** Assemble the final content record — injectedBytes/tokenCost are ALWAYS measured here. */
function content(text: string, disclosure: Disclosure, injectedSlugs: string[]): InjectionContent {
  return {
    text,
    disclosure,
    injectedSlugs,
    tokenCost: estimateTokens(text),
    injectedBytes: Buffer.byteLength(text, "utf8"),
  };
}

const EMPTY: InjectionContent = {
  text: "",
  disclosure: "none",
  injectedSlugs: [],
  tokenCost: 0,
  injectedBytes: 0,
};

/** Render a menu applying a per-line description cap (NAME_CAP fixed). descCap 0 → name-only. */
function renderMenuCapped(items: readonly { name: string; description: string }[], descCap: number): string {
  return items
    .map((s) => {
      const name = oneLine(s.name, NAME_CAP);
      const desc = oneLine(s.description, descCap);
      return desc ? `${name} — ${desc}` : name;
    })
    .join("\n");
}

/**
 * Render a compact menu: one `"<name> — <description>"` line per item. Deterministic
 * (no Date/random), order-preserving. NO instructions body — a menu is the "ask before
 * committing" disclosure when we are not confident enough to inject a sticky full skill.
 * Name + description are SANITIZED (see oneLine): untrusted frontmatter cannot smuggle a
 * newline or an extra instruction line into the rendered text.
 */
export function renderMenu(items: { name: string; description: string }[]): string {
  return renderMenuCapped(items, DESC_CAP);
}

/**
 * Render the full block for a confident single match: a short header line naming the
 * skill, then its instructions body verbatim. Deterministic. Only `instructions` is
 * emitted — never bundle scripts/references (§6). The header NAME is sanitized (untrusted
 * metadata); the instructions BODY is intentionally verbatim — it IS the skill content.
 */
export function renderFull(skill: { name: string; instructions: string }): string {
  return `# ${oneLine(skill.name, NAME_CAP)}\n\n${skill.instructions}`;
}

/**
 * Render a menu of `items` GUARANTEED to fit `maxTokens` (the budget invariant). Shrinks
 * deterministically: for each item count (full → 1) try ever-tighter description caps,
 * re-measuring after each step; the first non-empty rendering within budget wins. Returns
 * count 0 (→ caller emits EMPTY / disclosure "none") if not even a single minimal item fits.
 */
function fitMenu(
  items: readonly { name: string; description: string }[],
  maxTokens: number,
): { text: string; count: number } {
  for (let n = items.length; n >= 1; n--) {
    const subset = items.slice(0, n);
    for (const descCap of DESC_SHRINK_CAPS) {
      const text = renderMenuCapped(subset, descCap);
      // Require non-empty text so an all-empty-name degenerate menu never passes as content.
      if (text.length > 0 && estimateTokens(text) <= maxTokens) return { text, count: n };
    }
  }
  return { text: "", count: 0 };
}

/**
 * Build budget-fitting menu content from `items`. tokenCost is GUARANTEED <= maxTokens;
 * if nothing fits, returns EMPTY (disclosure "none"). injectedSlugs names ONLY the items
 * actually rendered after any shrink (never claims a candidate we dropped).
 */
function menuContent(items: SkillManifest[], maxTokens: number): InjectionContent {
  const { text, count } = fitMenu(items, maxTokens);
  if (count === 0) return EMPTY;
  return content(text, "menu", items.slice(0, count).map((s) => s.slug));
}

/**
 * Decide and render what to inject for a selection. Pure given (sel, skills, policy).
 *
 *  - mode "none" / no chosen        → disclosure "none", inject nothing.
 *  - ambiguous + menuOnAmbiguous    → disclosure "menu" of the top candidates (no body),
 *                                     shrunk to fit policy.maxTokens (→ "none" if none fit).
 *  - confident single match         → disclosure "full"; if the full body would exceed
 *                                     policy.maxTokens (a sticky budget liability) it is
 *                                     downgraded to a one-item "menu", itself budget-bound.
 *
 * INVARIANT: the returned InjectionContent.tokenCost is ALWAYS <= policy.maxTokens.
 */
export function buildInjection(
  sel: Selection,
  skills: SkillManifest[],
  policy: InjectionPolicy,
): InjectionContent {
  // Inject nothing — "none" is first-class; a wrong/absent skill is better than a guess.
  if (sel.mode === "none" || !sel.chosen) return EMPTY;

  const bySlug = new Map(skills.map((s) => [s.slug, s]));

  // Ambiguous and the host wants a menu rather than a guessed sticky skill (R1-B1).
  if (sel.ambiguous && policy.menuOnAmbiguous) {
    const cap = policy.maxMenuItems ?? DEFAULT_MAX_MENU_ITEMS;
    // Resolve candidate slugs to manifests; skip any we can't see so injectedSlugs only
    // ever names skills we actually rendered (noUncheckedIndexedAccess: get() is T|undefined).
    const picked: SkillManifest[] = [];
    for (const c of sel.candidates.slice(0, cap)) {
      const s = bySlug.get(c.slug);
      if (s) picked.push(s);
    }
    if (picked.length === 0) return EMPTY; // nothing resolvable to show — inject nothing.
    // Budget-enforced: shrink to fit policy.maxTokens (a sticky LM Studio channel must not
    // be handed an over-budget menu); → "none" if not even one minimal item fits.
    return menuContent(picked, policy.maxTokens);
  }

  // Confident single match — attempt the full body.
  const chosen = bySlug.get(sel.chosen.slug);
  if (!chosen) return EMPTY; // chosen slug not in the snapshot — don't fabricate content.

  const full = renderFull(chosen);
  if (estimateTokens(full) <= policy.maxTokens) return content(full, "full", [chosen.slug]);

  // The full body would blow the per-target budget and become a sticky liability — fall back
  // to a single-item menu (name + description only), ALSO budget-enforced so the downgrade
  // can never itself exceed the budget; → "none" if even the lone item cannot be made to fit.
  return menuContent([chosen], policy.maxTokens);
}

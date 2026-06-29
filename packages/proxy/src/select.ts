// @skillforge/proxy/select — pool → cascade → injection, the inject-based runtime for the proxy target.
//
// This is the THIRD inject-based parity path (after the LM Studio plugin and the daemon route-test). It is a
// HEADLESS, network-optional unit (the query embed is the only network touch, and it is injectable) so the
// suite stays hermetic. It REUSES @skillforge/core for every load-bearing step — loadCatalog (the standalone
// read-model reader), selectWithEscalation (the ONE semantic-primary cascade, D26 — the SAME unit the daemon
// route-test + the plugin call, so the proxy can NEVER diverge on a partial corpus) and buildInjection (the
// channel-agnostic content builder, BOUNDARY 3). It mirrors the daemon's handleRouteTest pool-build exactly
// (loadCatalog → buildLexicalIndex → createEmbeddingIndex.ensure → createEmbedProvider → selectWithEscalation
// → buildInjection), so for a given catalog+context the proxy's selection is byte-identical to core.select.
//
// CHANNEL = system-ephemeral: this module decides WHAT to inject (content). The PLACEMENT (splicing a system
// message into the forwarded request) is the adapter's job (inject.ts) — never folded into core's content
// decision. Unlike the LM Studio user-turn-rewrite channel, the proxy persists nothing, so there is NO sticky
// re-injection guard here: every request is evaluated from scratch.
import {
  buildInjection,
  buildLexicalIndex,
  createEmbeddingIndex,
  createEmbedProvider,
  selectWithEscalation,
  loadCatalog,
  loadInstructions,
  type EmbedFn,
  type EmbeddingIndex,
} from "@skillforge/core";
import type { FetchLike } from "@skillforge/core";
import type {
  InjectionContent,
  InjectionPolicy,
  Selection,
  SkillManifest,
  TargetId,
} from "@skillforge/contracts";
import type { DaemonConfig } from "@skillforge/contracts/api";
import type { SkillRecord } from "@skillforge/contracts/api";

/** A minimal chat message — only role + content matter; the LAST `role:"user"` message is the query. */
export interface ProxyChatMsg {
  role?: string;
  content?: unknown;
}

export interface ProxySelectInput {
  home: string;
  /** the chat request's messages (the LAST user turn is the routing query). */
  messages: readonly ProxyChatMsg[];
  /** resolved daemon config (provides the INDEPENDENT embeddings provider — M-embed). */
  config: DaemonConfig;
  /** which inject target's enabled pool to route over (defaults to "proxy"). */
  target?: TargetId;
  /** X-Skill:<slug> force → a Tier-0 explicit `$slug` selection. Lowercased by the caller. */
  forcedSlug?: string;
  /** injected fetch for the Tier-2 query-embed provider (hermetic tests pass a fake; default = global fetch). */
  embedFetch?: FetchLike;
  /** per-target/per-model overrides; defaults: maxTokens 2000, menuOnAmbiguous true, maxMenuItems 5. */
  policy?: Partial<InjectionPolicy>;
}

export interface ProxySelectResult {
  selection: Selection;
  injection: InjectionContent;
  /** present when semantic Tier-2 WOULD have run but could not (provider absent/unreachable) — M-embed. */
  tierDisabled?: { tier: "semantic"; reason: string };
  /** non-fatal degradations this request (unreadable/unsafe chosen body, no-stored-vectors) — never silent. */
  warnings: string[];
  /** the routing query actually used (last user turn, or `$slug <turn>` under an X-Skill force). */
  query: string;
}

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_MAX_MENU_ITEMS = 5;

/** The LAST `role:"user"` message is the query. "" when none / messages is not an array. */
export function lastUserMessage(messages: readonly ProxyChatMsg[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

/**
 * Route the chat to a skill and build the (channel-agnostic) injection content. Deterministic given
 * (read-model snapshot, messages, config, embedder). Mirrors the daemon's handleRouteTest pool-build so the
 * proxy's selection + injection are byte-identical to core/daemon/plugin over the same catalog (D5/D26).
 */
export async function selectForProxy(inp: ProxySelectInput): Promise<ProxySelectResult> {
  const target: TargetId = inp.target ?? "proxy";
  const catalog = loadCatalog(inp.home, target);
  const lastUser = lastUserMessage(inp.messages);
  // An X-Skill force becomes a Tier-0 explicit `$slug` query — the SAME mechanism the daemon route-test's
  // `explicit` field uses (routes/index.ts), so a forced selection is parity-identical to an explicit route.
  const query = inp.forcedSlug ? `$${inp.forcedSlug} ${lastUser}`.trim() : lastUser;

  const lexIndex = buildLexicalIndex(catalog.skills);

  // Tier-2 store: vectors keyed by contentHash, validated against the configured dim EXACTLY as the daemon
  // validates them (createEmbeddingIndex). Always built (even with no provider) so the cascade is identical;
  // escalate gates Tier-2 on the embedFn (absent ⇒ a VISIBLE tierDisabled, never a silent downgrade).
  const embeddingIndex: EmbeddingIndex = createEmbeddingIndex(
    inp.config.embeddings?.dim ? { dim: inp.config.embeddings.dim } : {},
  );
  await embeddingIndex.ensure(catalog.skills as unknown as SkillRecord[]);
  const embedFn: EmbedFn | undefined = inp.config.embeddings
    ? createEmbedProvider(inp.config.embeddings, inp.embedFetch)
    : undefined;

  // The ONE routing decision (D3/D26) — the semantic-primary cascade, never reimplemented here.
  const escalated = await selectWithEscalation(query, {
    skills: catalog.skills,
    lexIndex,
    embeddingIndex,
    ...(embedFn ? { embedFn } : {}),
  });
  const sel = escalated.selection;

  const warnings: string[] = [];
  // never-silent (M-embed): semantic was engaged this request but could not run (provider down) OR the
  // read-model carries no stored vectors — surface the gap (it is ALSO recorded in select.log.jsonl).
  if (escalated.tierDisabled) {
    warnings.push(`semantic tier unavailable (${escalated.tierDisabled.reason}) — routed on lexical+explicit only`);
  } else if (inp.config.embeddings && embeddingIndex.vectors.size === 0) {
    warnings.push(
      "semantic tier requested but the read-model has no stored embeddings — routed on lexical+explicit only (re-ingest with an embeddings provider)",
    );
  }

  // Lazily load the SKILL.md body for the CHOSEN skill ONLY — buildInjection renders no other body. GUARDED:
  // a corrupt/unsafe skill dir (traversal/symlink) must NOT abort the request — it degrades to a header-only
  // injection with a warning (the read-model reader throws PathEscapeError on an escaping dir).
  const skillsWithBody: SkillManifest[] = catalog.skills.map((s) => {
    if (!sel.chosen || s.slug !== sel.chosen.slug) return s;
    const dir = catalog.dirBySlug.get(s.slug);
    if (dir === undefined) return s;
    try {
      const instructions = loadInstructions(inp.home, dir);
      return { ...s, instructions, bodyLen: instructions.length, tokenEstimate: Math.ceil(instructions.length / 4) };
    } catch (e) {
      warnings.push(`could not load body for ${JSON.stringify(s.slug)} (${(e as Error).message}) — degraded injection`);
      return s;
    }
  });

  const policy: InjectionPolicy = {
    maxTokens: inp.policy?.maxTokens ?? DEFAULT_MAX_TOKENS,
    menuOnAmbiguous: inp.policy?.menuOnAmbiguous ?? true,
    maxMenuItems: inp.policy?.maxMenuItems ?? DEFAULT_MAX_MENU_ITEMS,
  };
  const injection = buildInjection(sel, skillsWithBody, policy);

  const result: ProxySelectResult = { selection: sel, injection, warnings, query };
  if (escalated.tierDisabled) result.tierDisabled = escalated.tierDisabled;
  return result;
}

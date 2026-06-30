// @skillforge/mcp-server/tools — the three MCP tools over the injected McpServerDeps.
//
// HOST-DRIVEN (R1-B2, D16): the host LLM chooses which skill to load from these descriptions. We do NOT
// run core.select() to decide load_skill — list_skills may LEXICALLY RE-ORDER its menu by a query, but the
// choice is the host's. Each tool returns an MCP tool result `{ content: [{type:"text", text}], isError? }`.
// A FAILURE that is the host's to see (no-grant / hash-mismatch / not-found) is returned as a VISIBLE
// isError result that NAMES the reason — never a silent success and never a JSON-RPC protocol error.

import type { McpServerDeps } from "./deps.ts";

/** An MCP tool-call result: text content blocks + an optional isError flag (a tool-level failure). */
export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A JSON-Schema-shaped tool descriptor for tools/list. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_NAMES = ["list_skills", "load_skill", "run_skill_script"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_skills",
    description:
      "List the SkillForge skills available to this host (the Tier-0 menu: name + description for every " +
      "skill enabled for MCP). Optionally pass `query` to lexically re-order the menu by relevance — the " +
      "ordering is a hint; YOU choose which skill to load. Follow up with load_skill to get a skill's full " +
      "instructions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "optional free-text to rank the menu by relevance (host still chooses)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "load_skill",
    description:
      "Load one SkillForge skill's full instructions plus a humble capability/bundle summary, by its id or " +
      "slug (as shown by list_skills). Returns the skill content for you to follow; placement is yours to decide.",
    inputSchema: {
      type: "object",
      properties: {
        idOrSlug: { type: "string", description: "the skill's id or slug from list_skills" },
      },
      required: ["idOrSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "run_skill_script",
    description:
      "Execute a bundled script that belongs to a skill, through SkillForge's audited execution chokepoint. " +
      "The skill must have exec GRANTED and its on-disk bytes must still match the reviewed content hash, or " +
      "the run is refused with a named reason. stdout/stderr tails and the exit code are returned.",
    inputSchema: {
      type: "object",
      properties: {
        idOrSlug: { type: "string", description: "the skill's id or slug" },
        script: { type: "string", description: "bundle-relative path of the script to run (e.g. scripts/run.sh)" },
        args: { type: "array", items: { type: "string" }, description: "optional argv passed to the script" },
        // C4: NO conversationId — a host-supplied conversation scope would be a forgeable, rotatable client
        // input. MCP run-gating is the owner's NON-ROTATABLE per-skill mute (refused with reason `suppressed`).
      },
      required: ["idOrSlug", "script"],
      additionalProperties: false,
    },
  },
];

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────
function textResult(text: string): ToolCallResult {
  return { content: [{ type: "text", text }] };
}
function errorResult(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}
function getStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
/** Collapse newlines/runs of whitespace so an untrusted description stays one readable menu line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── tool impls ────────────────────────────────────────────────────────────────────────────────────
async function listSkills(deps: McpServerDeps, args: Record<string, unknown>): Promise<ToolCallResult> {
  const query = getString(args, "query");
  const items = await deps.listSkills(query);
  if (items.length === 0) {
    return textResult(
      "No skills are currently enabled for MCP. Enable skills for the \"mcp\" target in SkillForge, then call list_skills again.",
    );
  }
  const header = `${items.length} SkillForge skill(s) available (host-driven — choose one and call load_skill with its slug or id):`;
  const lines = items.map((s) => `- ${s.slug} — ${s.name}: ${oneLine(s.description)}`);
  return textResult([header, "", ...lines].join("\n"));
}

async function loadSkill(deps: McpServerDeps, args: Record<string, unknown>): Promise<ToolCallResult> {
  const idOrSlug = getString(args, "idOrSlug");
  if (idOrSlug === undefined || idOrSlug === "") {
    return errorResult("load_skill: a string `idOrSlug` argument is required.");
  }
  const detail = await deps.loadSkill(idOrSlug);
  if (!detail) {
    return errorResult(`load_skill refused: not-found — no MCP skill matches ${JSON.stringify(idOrSlug)}. Call list_skills first.`);
  }
  const parts: string[] = [`# ${detail.name}`, "", detail.description, ""];
  if (detail.instructionsError) {
    parts.push(`(instructions unavailable: ${detail.instructionsError})`, "");
  } else {
    parts.push(detail.instructions, "");
  }

  // Humble capability/bundle summary (D14: what we noticed, never a "safe" verdict).
  const summary: string[] = ["## SkillForge summary"];
  summary.push(`- id: ${detail.id}    slug: ${detail.slug}`);
  summary.push(`- exec granted: ${detail.execAllowed ? "yes" : "no (run_skill_script will be refused until granted)"}`);
  // C4: a humble heads-up so the host understands the upcoming refusal (observability, not a gate).
  if (detail.mcpRunMuted) summary.push("- MCP runs currently muted by the owner (run_skill_script will be refused until re-enabled)");
  if (detail.capabilities) {
    const c = detail.capabilities;
    summary.push(`- capability flags (noticed, not a verdict): ${c.flags.length ? c.flags.join(", ") : "none"}`);
    if (c.scriptCount > 0) summary.push(`- scripts: ${c.scriptCount} (${c.interpreters.join(", ") || "?"})`);
    if (c.commands.length) summary.push(`- noticed commands: ${c.commands.join(", ")}`);
  }
  if (detail.bundle.scripts.length) summary.push(`- runnable scripts: ${detail.bundle.scripts.join(", ")}`);
  if (detail.bundle.references.length) summary.push(`- references (also available as MCP resources): ${detail.bundle.references.join(", ")}`);
  parts.push(summary.join("\n"));

  return textResult(parts.join("\n"));
}

async function runSkillScript(deps: McpServerDeps, args: Record<string, unknown>): Promise<ToolCallResult> {
  const idOrSlug = getString(args, "idOrSlug");
  const script = getString(args, "script");
  if (idOrSlug === undefined || idOrSlug === "") return errorResult("run_skill_script: a string `idOrSlug` argument is required.");
  if (script === undefined || script === "") return errorResult("run_skill_script: a string `script` argument is required.");
  const scriptArgs = getStringArray(args, "args");

  const outcome = await deps.runScript(idOrSlug, script, scriptArgs);
  if (!outcome.ok) {
    // VISIBLE, NAMED refusal (never a silent no-op). Include the hash drift when present.
    let msg = `run_skill_script refused: ${outcome.reason} — ${outcome.detail}`;
    if (outcome.grantedHash || outcome.currentHash) {
      msg += `\n(granted hash: ${outcome.grantedHash ?? "?"}; on-disk hash: ${outcome.currentHash ?? "?"})`;
    }
    return errorResult(msg);
  }

  const r = outcome.result;
  const lines: string[] = [
    `Ran ${script} for skill ${idOrSlug}${outcome.dryRun ? " (dry-run)" : ""}.`,
    `exit: ${r.exit === null ? "null" : r.exit}`,
    `durationMs: ${r.durationMs}`,
    `contentHash: ${r.contentHash}`,
    "",
    r.stdoutTail ? `--- stdout (tail) ---\n${r.stdoutTail}` : "(no stdout)",
    r.stderrTail ? `--- stderr (tail) ---\n${r.stderrTail}` : "(no stderr)",
  ];
  return textResult(lines.join("\n"));
}

/** Dispatch a tools/call by name. Returns a tool result, or undefined when the tool name is unknown
 *  (the dispatcher maps that to a JSON-RPC -32602). */
export async function callTool(
  deps: McpServerDeps,
  name: string,
  rawArgs: unknown,
): Promise<ToolCallResult | undefined> {
  const args = asRecord(rawArgs);
  switch (name) {
    case "list_skills":
      return listSkills(deps, args);
    case "load_skill":
      return loadSkill(deps, args);
    case "run_skill_script":
      return runSkillScript(deps, args);
    default:
      return undefined;
  }
}

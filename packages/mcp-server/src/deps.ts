// @skillforge/mcp-server/deps — the INJECTION SEAM between the MCP dispatcher and its data source.
//
// The dispatcher (server.ts), the tool impls (tools.ts) and the resource impls (resources.ts) operate
// EXCLUSIVELY over this interface — they never touch the filesystem or @skillforge/core directly. Two
// implementations satisfy it:
//   • createReadModelDeps(home) (catalog.ts) — the daemon-DOWN standalone path: reads the CLI-written
//     read-model (manifest.json + sources/) and runs exec through core.run(). Used by the stdio bin.
//   • Wave B (the daemon mount) supplies a LIVE-context implementation backed by the daemon's store +
//     RouteContext, so the SAME dispatcher serves MCP over Streamable HTTP with live data.
// Keeping the seam this narrow is what lets Wave B reuse every byte of the protocol/dispatch/tool code.

import type { ExecResult, SkillCapabilities } from "@skillforge/contracts";

/** A Tier-0 menu row for `list_skills` — name + description for one mcp-enabled skill. */
export interface McpMenuItem {
  id: string;
  slug: string;
  name: string;
  description: string;
}

/** Full detail for `load_skill`: the instructions body plus a humble capability/bundle summary. */
export interface McpSkillDetail {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** the SKILL.md body (frontmatter stripped). Empty + `instructionsError` set when it could not be read. */
  instructions: string;
  /** present (never silent) when the on-disk body could not be read (traversal/missing) — surfaced to the host. */
  instructionsError?: string;
  capabilities?: SkillCapabilities;
  /** whether exec is granted for this skill (hash-bound, D10) — shown so the host knows run_skill_script will work. */
  execAllowed: boolean;
  /** OWNER MCP RUN-MUTE (C4): when true, run_skill_script is refused for this skill (load/list unaffected).
   *  Surfaced so load_skill can give the host a humble heads-up about the upcoming refusal (never a gate). */
  mcpRunMuted?: boolean;
  /** per-kind bundle relPaths so the host sees what scripts/references exist without reading bytes. */
  bundle: { scripts: string[]; references: string[]; assets: string[] };
}

/** The result of a `run_skill_script` attempt — either a completed core.run() outcome or a NAMED refusal. */
export type McpRunOutcome =
  | { ok: true; result: ExecResult; dryRun: boolean }
  | { ok: false; reason: McpRefusalReason; detail: string; grantedHash?: string; currentHash?: string };

/** The named gate that refused a run (mirrors the daemon's RunSkillRefusal["reason"] + not-found). A
 *  refusal is ALWAYS surfaced as a visible MCP error result (isError), never a silent no-op. `suppressed`
 *  now covers the OWNER MCP RUN-MUTE (C4) — a human-set, persisted, non-rotatable per-skill pause of MCP runs
 *  — enforced on BOTH paths: the daemon's live /mcp chokepoint AND the daemon-down read-model path (catalog.ts)
 *  via the shared isMcpRunMuted predicate. (On the daemon path `suppressed` ALSO covers R1-B1 conversation
 *  suppression for the TRUSTED inject runtime, but the MCP run tool never supplies a conversationId — that
 *  scope is trusted-inject-only; the McpRunOutcome.detail distinguishes the two for the host.) */
export type McpRefusalReason =
  | "not-found"
  | "no-grant"
  | "hash-mismatch"
  | "path-escape"
  | "not-a-script"
  | "interpreter-unresolved"
  | "bundle-unreadable"
  | "bad-args"
  | "suppressed"
  | "audit-failed";

/** One MCP resource descriptor (a skill's reference file), `skillforge://<slug>/<relPath>`. */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** The bytes of one resource read (text only — references are human-readable docs). */
export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

/** A resource read can fail with a NAMED reason (mapped to a JSON-RPC error by the dispatcher). */
export type McpResourceOutcome =
  | { ok: true; contents: McpResourceContents }
  | { ok: false; reason: "not-found" | "invalid-uri" | "path-escape" | "not-a-reference" | "unreadable"; detail: string };

/**
 * Everything the MCP dispatcher needs from its data source. All methods MAY be async (the dispatcher
 * awaits) so a live-daemon implementation can do I/O. The read-model implementation is mostly sync.
 */
export interface McpServerDeps {
  /** server version reported in `initialize` → serverInfo.version. */
  readonly version: string;
  /** Tier-0 menu of mcp-enabled skills. When `query` is given the menu MAY be lexically re-ordered
   *  (the host still picks — MCP is host-driven, R1-B2); it is never filtered down to a single choice. */
  listSkills(query?: string): Promise<McpMenuItem[]> | McpMenuItem[];
  /** Full instructions + capability/bundle summary for a skill by id OR slug; undefined when not found
   *  (or not enabled for mcp). */
  loadSkill(idOrSlug: string): Promise<McpSkillDetail | undefined> | McpSkillDetail | undefined;
  /** Execute a skill's bundled script through the exec chokepoint (core.run). Enforces the hash-bound grant
   *  AND the owner MCP run-mute (C4) — a missing grant / hash mismatch / owner-mute / unresolved skill returns
   *  a NAMED refusal (never spawns). No conversationId param: the MCP run tool takes no caller conversation
   *  scope (it would be forgeable/rotatable); MCP run-gating is the owner's non-rotatable per-skill mute. */
  runScript(idOrSlug: string, script: string, args: string[]): Promise<McpRunOutcome>;
  /** All reference resources across mcp-enabled skills. */
  listResources(): Promise<McpResource[]> | McpResource[];
  /** Read one resource by its skillforge:// uri (containment-checked under home). */
  readResource(uri: string): Promise<McpResourceOutcome> | McpResourceOutcome;
}

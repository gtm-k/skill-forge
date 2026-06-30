// @skillforge/mcp-server/resources — expose each skill's bundle `reference` files as MCP resources.
//
// URI scheme: skillforge://<slug>/<relPath>. resources/list enumerates references across mcp-enabled
// skills; resources/read returns one reference's text. All reads go through the deps, which resolve them
// with core.resolveUnderRoot containment so a read can NEVER escape home (a traversal/symlink uri is a
// NAMED failure mapped to a JSON-RPC error here, never bytes from outside the skill tree).

import { JSON_RPC } from "./protocol.ts";
import type { McpServerDeps } from "./deps.ts";

/** resources/list → { resources: [...] }. */
export async function listResourcesResult(deps: McpServerDeps): Promise<{ resources: unknown[] }> {
  const resources = await deps.listResources();
  return { resources };
}

/** resources/read → either the contents body, or a JSON-RPC error (code + message) for a failed read. */
export async function readResourceResult(
  deps: McpServerDeps,
  uri: string,
): Promise<{ ok: true; body: { contents: unknown[] } } | { ok: false; code: number; message: string }> {
  const outcome = await deps.readResource(uri);
  if (outcome.ok) {
    return { ok: true, body: { contents: [outcome.contents] } };
  }
  // A malformed/unknown/escaping uri is INVALID PARAMS at the protocol layer — visible to the host,
  // naming the reason (invalid-uri / not-found / path-escape / unreadable).
  return { ok: false, code: JSON_RPC.INVALID_PARAMS, message: `resources/read failed: ${outcome.reason} — ${outcome.detail}` };
}

// @skillforge/daemon/server/static — serve the @skillforge/ui web/ console SINGLE-ORIGIN (PLAN §9, W5).
//
// The daemon hosts the visual manager from its OWN origin so every fetch the SPA makes is same-origin: the
// admission gate (http.ts) then sees a local Host + (browser-stamped) local Origin and admits it WITHOUT
// any CORS relaxation. Files resolve strictly UNDER the resolved web/ dir via core.resolveUnderRoot — a
// traversal that escapes web/ is a 404 (never a read outside the served tree), exactly like the ui
// precursor's serveStatic. This module reads STATIC ASSETS only; it never imports @skillforge/ui CODE
// (the §2 "no sibling-adapter import" rule is about runtime coupling, not serving its built console files).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUnderRoot, PathEscapeError } from "@skillforge/core";
import type { JsonResponse, ReqCtx, RouteDef } from "./http.ts";

/** Extension → content-type for the (small, fixed) set of assets the console ships. Unknown → octet. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Resolve the absolute path of the @skillforge/ui `web/` dir the console lives in. Precedence:
 *   1. an explicit override (DaemonOptions.webDir / config) — lets an integration harness point elsewhere;
 *   2. the package graph via import.meta.resolve (resolves through the zero-install node_modules junction);
 *   3. the monorepo layout relative to THIS module (packages/daemon/src/server → packages/ui/web).
 * Deterministic in dev (junctions are realpath'd on import), and never throws — the worst case is a webDir
 * that does not exist, which surfaces as a visible 404 per asset rather than a daemon-start crash.
 */
export function resolveWebDir(override?: string): string {
  if (override && override.length > 0) return override;
  try {
    const u = import.meta.resolve("@skillforge/ui/web/index.html");
    return path.dirname(fileURLToPath(u));
  } catch {
    // not resolvable as a package (e.g. junction missing) — fall back to the monorepo-relative layout.
    return path.join(import.meta.dirname, "..", "..", "..", "ui", "web");
  }
}

/**
 * Serve `relPath` from under `webDir`. Returns a JsonResponse on an error (so the router renders a typed
 * 404 — never a silent empty 200), or `undefined` after streaming the file (the handler took over the
 * socket). A traversal/escape and a missing/dir target both become 404 (containment is observable).
 */
function serveFile(webDir: string, relPath: string, res: ReqCtx["res"]): JsonResponse | undefined {
  let abs: string;
  try {
    abs = resolveUnderRoot(webDir, relPath); // a path escaping web/ throws → typed 404 below
  } catch (e) {
    if (e instanceof PathEscapeError) return { status: 404, body: { error: "not-found", relPath } };
    throw e;
  }
  let data: Buffer;
  try {
    data = fs.readFileSync(abs); // EISDIR (relPath was a dir) / ENOENT → 404
  } catch {
    return { status: 404, body: { error: "not-found", relPath } };
  }
  const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "x-content-type-options": "nosniff", // defense-in-depth: never sniff a served asset into another type
    "cache-control": "no-cache", // a local dev console must always reflect the latest hand-edited web/ file
  });
  res.end(data);
  return undefined; // socket handled
}

/**
 * The static routes that host the console: `/` → web/index.html and `/web/*` → the asset tree. Mounted
 * LAST in the route table so every daemon API path (/health, /skills, /sources, …) is matched first and a
 * future API route can never be shadowed by the static catch-all.
 */
export function staticRoutes(webDir: string): RouteDef[] {
  return [
    { method: "GET", pattern: "/", handler: (c: ReqCtx) => serveFile(webDir, "index.html", c.res) },
    { method: "GET", pattern: "/web/*", handler: (c: ReqCtx) => serveFile(webDir, c.params["*"] ?? "", c.res) },
  ];
}

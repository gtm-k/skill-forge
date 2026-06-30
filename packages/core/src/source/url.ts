// @skillforge/core/source/url — materialize an HTTPS url source into a FetchedTree (§5, D20, D24).
//
// HTTPS-ONLY, SSRF-guarded, BOUNDED fetch (reuse guards.ts). Sourcing EXECUTES NOTHING — fetch +
// gunzip + tar-walk are inert. Three payload shapes, sniffed by extension then content-type:
//   • raw .md / text/markdown      → a single-skill tree (dest/<slug>/SKILL.md)
//   • .tar.gz / application/gzip    → gunzip (node:zlib) + a minimal native USTAR/pax/GNU tar walk
//   • .zip / application/zip        → an INJECTED UnzipFn (core stays zero-dep); ABSENT → a typed
//                                     SourceResolveError, NEVER a silent skip
// SSRF DEFENCE IN DEPTH: the guard runs on ref.input AND on EVERY redirect hop — the default fetch uses
// redirect:"manual" and this module re-runs safeUrl on each Location before following (a public host can
// 30x to https://[::1]/ or http://169.254.169.254/). Archive contents are UNTRUSTED (D20): every
// extracted/returned entry path passes through resolveUnderRoot + assertNoSymlinkEscape, so a
// "../escape" / absolute / symlinked member is REJECTED rather than landing outside `dest`. Link/device
// members are skipped (and the skip is SURFACED, never dropped invisibly); both the compressed download
// and the decompressed output are byte-bounded.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { safeUrl } from "./guards.ts";
import { resolveUnderRoot, assertNoSymlinkEscape } from "../safe/index.ts";
import { shortId } from "../hash.ts";
import { walkSkillDirs } from "./folder.ts";
import type { FetchedTree, SourceRef, ValidationIssue } from "@skillforge/contracts";

/** Minimal fetch surface (a subset of the global `fetch`) so tests inject a local-fixture Response. */
export type UrlFetch = (url: string) => Promise<Response>;

/**
 * Extract a `.zip` archive into `dest`, RETURNING every path it wrote (absolute, or relative to
 * `dest`). INJECTED by the caller (CLI/daemon) — core carries no unzip dependency (zero-install).
 *
 * CONTRACT: containment is the implementation's HARD obligation — it must refuse zip-slip / symlink
 * members itself. core does NOT trust it: resolveUrl re-validates that EVERY returned path is
 * realpath-contained under `dest` and is not a symlink, and throws SourceResolveError otherwise. The
 * post-extraction skill-walk does NOT re-contain these writes (it only skips symlinks it happens to
 * see), so the returned-path validation is the load-bearing check. An absent UnzipFn is surfaced as a
 * typed error, never a silent no-op.
 */
export type UnzipFn = (archive: Uint8Array, dest: string) => Promise<string[]>;

export interface ResolveUrlOptions {
  /** unzip for `.zip` payloads; absent → SourceResolveError (the funnel refuses to skip silently). */
  unzip?: UnzipFn;
  /** fetch implementation for ONE hop; defaults to the global fetch with redirect:"manual". Tests
   *  inject a no-network fixture (and may return a 30x to assert redirect re-validation). */
  fetchImpl?: UrlFetch;
  /** max COMPRESSED bytes read off the response before aborting (runaway/oversized guard). */
  maxBytes?: number;
  /** max DECOMPRESSED bytes produced by tar.gz extraction (zip-bomb guard). */
  maxExtractedBytes?: number;
}

// Humble, owner-tunable ceilings: large enough for real skill bundles, small enough to refuse an
// accidental multi-GB download. NOT a security boundary — a containment + DoS backstop (D14 framing).
export const DEFAULT_MAX_FETCH_BYTES = 32 * 1024 * 1024; // 32 MiB compressed/raw
export const DEFAULT_MAX_EXTRACTED_BYTES = 128 * 1024 * 1024; // 128 MiB decompressed
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** A FetchedTree plus non-fatal notices (e.g. skipped link/device archive members). ADDITIVE over the
 *  frozen FetchedTree contract (which has no warnings field) — direct callers of resolveUrl read it for
 *  actor-observability; the dispatcher widens to FetchedTree. */
export interface UrlFetchedTree extends FetchedTree {
  warnings?: ValidationIssue[];
}

/**
 * A typed sourcing failure carrying a ValidationIssue. Thrown (never returned-empty) so a blocked,
 * unsupported, or oversized input is OBSERVABLE at the trust boundary (the never-silent invariant, §5).
 */
export class SourceResolveError extends Error {
  readonly issue: ValidationIssue;
  constructor(issue: ValidationIssue) {
    super(issue.msg);
    this.name = "SourceResolveError";
    this.issue = issue;
  }
}

function fail(msg: string, field = "url"): never {
  throw new SourceResolveError({ level: "error", field, msg });
}

/** safeUrl, but a rejection (non-https / blocked host) is re-thrown as a typed SourceResolveError so
 *  callers classifying via `instanceof SourceResolveError` see a validation issue, not a raw crash. */
function safeUrlTyped(input: string): URL {
  try {
    return safeUrl(input);
  } catch (e) {
    return fail((e as Error).message);
  }
}

type UrlPayload = "markdown" | "targz" | "zip" | "unknown";

/** Sniff the payload shape: extension first (most reliable here), then the content-type header. */
function sniffUrlPayload(url: URL, contentType: string | null): UrlPayload {
  const p = url.pathname.toLowerCase();
  if (/\.(tar\.gz|tgz)$/.test(p)) return "targz";
  if (/\.zip$/.test(p)) return "zip";
  if (/\.(md|markdown)$/.test(p)) return "markdown";

  const ct = (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (ct === "application/gzip" || ct === "application/x-gzip" || ct === "application/x-tar+gzip" || ct === "application/x-compressed-tar") return "targz";
  if (ct === "application/zip" || ct === "application/x-zip-compressed") return "zip";
  if (ct === "text/markdown" || ct === "text/x-markdown" || ct === "text/plain") return "markdown";
  return "unknown";
}

/** A filesystem-safe skill directory name from a url's last path segment (its basename = the slug). */
function deriveSkillDirName(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "skill";
  const base = last.replace(/\.(md|markdown)$/i, "");
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return safe || "skill";
}

/**
 * Fetch `startUrl`, following redirects MANUALLY and re-validating EVERY hop's Location with safeUrl
 * BEFORE following it. Bounded to MAX_REDIRECT_HOPS, then a typed error. This closes the SSRF redirect
 * hole: even when the first host is public, a 30x to an internal host is rejected before any connection
 * to it. The default fetch uses redirect:"manual" so undici returns the 30x for us to inspect.
 */
async function fetchFollowingSafeRedirects(startUrl: string, fetchImpl: UrlFetch): Promise<{ response: Response; finalUrl: URL }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const res = await fetchImpl(current);
    if (!REDIRECT_STATUS.has(res.status)) return { response: res, finalUrl: new URL(current) };
    const location = res.headers.get("location");
    try {
      await res.body?.cancel();
    } catch {
      /* discard the redirect body so the socket can be reused; best-effort */
    }
    if (!location) fail(`redirect (HTTP ${res.status}) without a Location header from ${JSON.stringify(current)}`);
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return fail(`redirect to a malformed Location ${JSON.stringify(location)}`);
    }
    safeUrlTyped(next); // re-validate https + non-blocked host BEFORE following (SSRF redirect guard)
    current = next;
  }
  return fail(`too many redirects (> ${MAX_REDIRECT_HOPS}) starting at ${JSON.stringify(startUrl)}`);
}

/** Read the response body into memory, aborting if it exceeds `maxBytes` (never trusts content-length). */
async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const body = res.body;
  if (!body) {
    // No stream to bound incrementally — refuse unless content-length proves it fits, then re-check.
    const len = res.headers.get("content-length");
    if (len === null) fail("response has no body stream and no content-length — refusing an unbounded read");
    const declared = Number(len);
    if (!Number.isFinite(declared) || declared > maxBytes) fail(`response content-length ${JSON.stringify(len)} exceeds the ${maxBytes}-byte cap`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) fail(`response exceeds the ${maxBytes}-byte cap`);
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      fail(`response exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// ── minimal native tar reader (USTAR + GNU long-name 'L' + pax 'x'/'g' path override) ──
const BLOCK = 512;

function readOctal(buf: Buffer, off: number, len: number): number {
  // GNU base-256 (high bit of the first byte set) for sizes > 8 GiB — handled defensively.
  if (((buf[off] ?? 0) & 0x80) !== 0) {
    let val = (buf[off] ?? 0) & 0x7f;
    for (let i = off + 1; i < off + len; i++) val = val * 256 + (buf[i] ?? 0);
    return val;
  }
  let s = "";
  for (let i = off; i < off + len; i++) {
    const c = buf[i] ?? 0;
    if (c === 0 || c === 0x20) {
      if (s) break;
      continue;
    }
    s += String.fromCharCode(c);
  }
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function readStr(buf: Buffer, off: number, len: number): string {
  let end = off;
  const max = off + len;
  while (end < max && (buf[end] ?? 0) !== 0) end++;
  return buf.subarray(off, end).toString("utf8");
}

/** pax extended-header records ("<len> key=value\n"); we only need a `path` override for the next entry. */
function paxPathOf(data: Buffer): string | undefined {
  const text = data.toString("utf8");
  const re = /\d+ ([^=]+)=([^\n]*)\n/g;
  let m: RegExpExecArray | null;
  let pathVal: string | undefined;
  while ((m = re.exec(text)) !== null) if (m[1] === "path") pathVal = m[2];
  return pathVal;
}

/**
 * Gunzip + walk a tar into `dest`. Each regular file is written through resolveUnderRoot +
 * assertNoSymlinkEscape, so any member resolving outside `dest` is REJECTED (PathEscapeError). Link
 * and device members are skipped (never recreated) and COUNTED so the caller can surface the skip.
 * Decompression is bounded via zlib maxOutputLength (zip-bomb guard). Returns the skipped count.
 */
function extractTarGz(gz: Uint8Array, dest: string, maxExtractedBytes: number): { skippedMembers: number } {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(gz, { maxOutputLength: maxExtractedBytes });
  } catch (e) {
    return fail(`failed to gunzip the .tar.gz (or it exceeds the ${maxExtractedBytes}-byte extraction cap): ${(e as Error).message}`);
  }
  let offset = 0;
  let skippedMembers = 0;
  let longName: string | undefined; // GNU 'L'
  let paxPath: string | undefined; // pax 'x'/'g' path=
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    let name = readStr(header, 0, 100);
    const prefix = readStr(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    offset += BLOCK;
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      const pp = paxPathOf(data);
      if (pp) paxPath = pp;
      continue;
    }

    const entryName = (paxPath ?? longName ?? name).replace(/\/+$/, "");
    longName = undefined;
    paxPath = undefined;
    if (!entryName || entryName === ".") continue;

    // Skip symlink (2), hardlink (1), char (3), block (4), fifo (6) members — never materialized (D20).
    if (typeflag === "1" || typeflag === "2" || typeflag === "3" || typeflag === "4" || typeflag === "6") {
      skippedMembers++;
      continue;
    }

    if (typeflag === "5") {
      const dir = resolveUnderRoot(dest, entryName); // throws PathEscapeError on escape
      assertNoSymlinkEscape(dest, entryName);
      fs.mkdirSync(dir, { recursive: true });
      continue;
    }

    // regular file ('0' or '\0')
    const target = resolveUnderRoot(dest, entryName); // containment (throws on escape — D20)
    assertNoSymlinkEscape(dest, entryName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  return { skippedMembers };
}

/**
 * Validate the paths an injected UnzipFn reports it wrote: each MUST realpath-resolve under `dest` and
 * MUST NOT be a symlink. A breach → SourceResolveError (we do NOT trust the injected extractor; zip-slip
 * and symlink escape are the classic archive vectors — D20).
 */
function validateUnzipPaths(dest: string, written: string[]): void {
  for (const p of written) {
    if (typeof p !== "string" || p === "") fail(`unzip returned an invalid path entry ${JSON.stringify(p)}`);
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(dest, p);
    const rel = path.relative(dest, abs);
    try {
      resolveUnderRoot(dest, rel); // realpath containment (throws PathEscapeError on escape)
      assertNoSymlinkEscape(dest, rel); // no symlink component escapes the root
    } catch (e) {
      fail(`unzip wrote a path escaping dest: ${JSON.stringify(p)} (${(e as Error).message})`);
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return fail(`unzip reported a path that is not on disk: ${JSON.stringify(p)}`);
    }
    if (st.isSymbolicLink()) fail(`unzip wrote a symlink, refused for an untrusted archive: ${JSON.stringify(p)}`);
  }
}

/**
 * Resolve an HTTPS url source into a FetchedTree. Guards (https-only + SSRF reject) run BEFORE any
 * network I/O and on EVERY redirect hop; the response is byte-bounded; the payload is materialized under
 * `dest` with full path-containment; then the tree is walked for SKILL.md exactly like a folder.
 * sourceId derives from the SourceRef identity (ref.input), stable across re-fetches.
 */
export async function resolveUrl(ref: SourceRef, dest: string, opts: ResolveUrlOptions = {}): Promise<UrlFetchedTree> {
  const url = safeUrlTyped(ref.input); // https-only + SSRF reject — typed throw (never silent), before any fetch
  const hopFetch: UrlFetch = opts.fetchImpl ?? ((u: string) => globalThis.fetch(u, { redirect: "manual" }));
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FETCH_BYTES;
  const maxExtractedBytes = opts.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;

  // The final URL (after any safe redirects) drives payload sniffing + slug derivation; a .md that 30x's
  // to a .tar.gz must be read as the tar. sourceId still keys on the user's ORIGINAL ref.input (stable).
  const { response: res, finalUrl } = await fetchFollowingSafeRedirects(url.toString(), hopFetch);
  if (!res.ok) fail(`fetch failed: HTTP ${res.status} for ${JSON.stringify(finalUrl.toString())}`);
  const bytes = await readBounded(res, maxBytes);
  const payload = sniffUrlPayload(finalUrl, res.headers.get("content-type"));

  fs.mkdirSync(dest, { recursive: true });
  const warnings: ValidationIssue[] = [];

  if (payload === "markdown") {
    const slug = deriveSkillDirName(finalUrl);
    const skillDir = resolveUnderRoot(dest, slug);
    assertNoSymlinkEscape(dest, slug);
    fs.mkdirSync(skillDir, { recursive: true });
    const mdTarget = resolveUnderRoot(skillDir, "SKILL.md");
    fs.writeFileSync(mdTarget, bytes);
  } else if (payload === "targz") {
    const { skippedMembers } = extractTarGz(bytes, dest, maxExtractedBytes);
    if (skippedMembers > 0) {
      warnings.push({ level: "warn", field: "url", msg: `skipped ${skippedMembers} link/device member(s) in the archive — not materialized (untrusted)` });
    }
  } else if (payload === "zip") {
    if (!opts.unzip) {
      fail("'.zip' source needs an injected UnzipFn — none was provided; refusing to skip the archive silently");
    }
    const written = await opts.unzip(bytes, dest);
    validateUnzipPaths(dest, written); // core re-verifies containment of what the extractor wrote (D20)
  } else {
    fail(
      `unsupported url payload (content-type ${JSON.stringify(res.headers.get("content-type"))}, path ${JSON.stringify(finalUrl.pathname)}) — expected a raw .md, a .tar.gz, or a .zip`,
    );
  }

  const root = resolveUnderRoot(dest, "."); // realpath(dest); each descent is contained by walkSkillDirs
  const skillDirs = await walkSkillDirs(root);
  const sourceId = shortId("url", ref.input);
  const tree: UrlFetchedTree = { sourceId, root, skillDirs, ref };
  if (warnings.length) tree.warnings = warnings;
  return tree;
}

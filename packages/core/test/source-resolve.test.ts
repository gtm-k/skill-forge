// Wave-2 source resolvers (§5, D14/D20/D24): registry + url + the resolveSource dispatcher + the
// before-commit preview. NO network and NO LM Studio: the registry path uses an INJECTED resolver, the
// url path an INJECTED fetch returning a `Response` built from a local fixture (raw .md + a hand-built
// .tar.gz). source/ is not in the @skillforge/core barrel yet (the orchestrator wires that), so we
// import the modules directly by relative path, exactly like the other Wave-1/2 module tests do.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  resolveRegistry,
  resolveUrl,
  resolveSource,
  buildSourcePreview,
  normalizeTree,
  safeUrl,
  SourceResolveError,
  type RegistryResolveFn,
  type UrlFetch,
  type CloneFn,
} from "../src/source/index.ts";
import { PathEscapeError } from "../src/safe/index.ts";
import { shortId } from "../src/hash.ts";
import type { SourceRef } from "@skillforge/contracts";

const made: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function writeSkill(root: string, dir: string, fm: string, body: string, extra: { name: string; content: string }[] = []): void {
  const abs = path.join(root, dir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, "SKILL.md"), `---\n${fm}\n---\n${body}\n`);
  for (const f of extra) fs.writeFileSync(path.join(abs, f.name), f.content);
}

const MD = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} is a real sourced skill exercising the url resolver funnel end to end.\n---\n# ${name}\n\nA body comfortably longer than the placeholder threshold so it is not flagged near-empty.\n`;

/** A `Response` from local bytes — the no-network fixture the injected UrlFetch returns. Extra headers
 *  (e.g. `location` for a 30x) are merged in; 30x responses carry no body, mirroring undici's manual mode. */
function fixtureResponse(bytes: Uint8Array | string, contentType: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const isBodyless = status >= 300 && status < 400;
  return new Response(isBodyless ? null : body, { status, headers: { "content-type": contentType, ...extraHeaders } });
}

// ── minimal USTAR builder (matches the reader in url.ts) ────────────────────────────────────────────
function tarHeader(name: string, size: number, typeflag = "0"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, "utf8"); // name (≤100)
  h.write("0000644", 100, "ascii"); // mode
  h.write("0000000", 108, "ascii"); // uid
  h.write("0000000", 116, "ascii"); // gid
  h.write(size.toString(8).padStart(11, "0"), 124, "ascii"); // size (octal, 11 digits + NUL)
  h.write("00000000000", 136, "ascii"); // mtime
  h.write("        ", 148, "ascii"); // chksum field = 8 spaces while summing
  h.write(typeflag, 156, "ascii");
  h.write("ustar\0", 257, "ascii"); // magic
  h.write("00", 263, "ascii"); // version
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i] ?? 0;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii"); // 6 octal + NUL + space
  return h;
}
function tarFile(name: string, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([tarHeader(name, data.length), padded]);
}
/** Build a gzipped tar from {name, content} entries (+ the two trailing zero blocks). */
function makeTarGz(entries: { name: string; content: string }[]): Uint8Array {
  const blocks = entries.map((e) => tarFile(e.name, e.content));
  const tar = Buffer.concat([...blocks, Buffer.alloc(1024)]);
  return zlib.gzipSync(tar);
}

// ── registry (INJECTED resolver) ─────────────────────────────────────────────────────────────────
test("resolveRegistry: injected resolver materializes a tree; version → ref.ref + resolved; stable sourceId", async () => {
  const dest = mkTmp("skf-reg-dest-");
  const ref: SourceRef = { kind: "registry", input: "acme/cool-skill" };
  let calledWith: { ref: SourceRef; dest: string } | undefined;
  const resolver: RegistryResolveFn = async (r, d) => {
    calledWith = { ref: r, dest: d };
    writeSkill(d, "cool-skill", "name: Cool\ndescription: Cool resolves from the registry into a temp dir for the funnel.", "# Cool\n\nA body long enough to avoid the placeholder warning entirely.");
    return { version: "1.4.2", lock: "sha512-deadbeef" };
  };

  const tree = await resolveRegistry(ref, dest, resolver);
  assert.ok(calledWith, "the injected resolver must be invoked");
  assert.equal(calledWith.dest, dest);
  assert.deepEqual(tree.skillDirs, ["cool-skill"]);
  assert.equal(tree.sourceId, shortId("registry", "acme/cool-skill")); // input-only → stable across versions
  assert.equal(tree.ref.ref, "1.4.2"); // resolved version surfaced on the contract field
  assert.equal(tree.resolved?.version, "1.4.2");
  assert.equal(tree.resolved?.lock, "sha512-deadbeef");

  const manifests = await normalizeTree(tree);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0]?.slug, "cool-skill");
});

test("resolveRegistry: a resolver that materializes nothing → an empty (not failing) tree; the caller warns", async () => {
  // dest does not pre-exist; resolveRegistry creates+pins it, the resolver writes nothing → empty walk
  // (consistent with git/folder which return empty skillDirs; the CLI/daemon surfaces the no-skills warning).
  const ghost = path.join(mkTmp("skf-reg-ghost-"), "never-created");
  const ref: SourceRef = { kind: "registry", input: "acme/ghost" };
  const resolver: RegistryResolveFn = async () => {
    /* deliberately materializes nothing into dest */
  };
  const tree = await resolveRegistry(ref, ghost, resolver);
  assert.deepEqual(tree.skillDirs, []);
  assert.equal(tree.sourceId, shortId("registry", "acme/ghost"));
});

test("resolveRegistry: a resolver that REPLACES dest with a symlink after resolving is rejected (D20 dest-swap)", async () => {
  const dest = mkTmp("skf-reg-swap-");
  const external = mkTmp("skf-reg-external-"); // a dir OUTSIDE dest the swap would redirect the walk to
  writeSkill(external, "smuggled", "name: Smuggled\ndescription: A skill that lives OUTSIDE dest and must never be walked via a swapped symlink.", "# Smuggled\n\nA body long enough not to be a placeholder skill at all.");
  const ref: SourceRef = { kind: "registry", input: "acme/swap" };
  const resolver: RegistryResolveFn = async (_r, d) => {
    fs.rmSync(d, { recursive: true, force: true });
    fs.symlinkSync(external, d, "junction"); // junction works on Windows without admin; lstat sees a link
  };
  await assert.rejects(
    () => resolveRegistry(ref, dest, resolver),
    (e: unknown) => e instanceof SourceResolveError && /symlink|identity/.test(e.message),
  );
});

// ── url: raw .md ────────────────────────────────────────────────────────────────────────────────
test("resolveUrl: a raw .md (text/markdown) → a single-skill tree; slug from the url basename", async () => {
  const dest = mkTmp("skf-url-md-");
  const ref: SourceRef = { kind: "url", input: "https://example.com/skills/my-gist-skill.md" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(MD("Gist Skill"), "text/markdown; charset=utf-8");

  const tree = await resolveUrl(ref, dest, { fetchImpl });
  assert.deepEqual(tree.skillDirs, ["my-gist-skill"]);
  assert.equal(tree.sourceId, shortId("url", ref.input));
  assert.ok(fs.existsSync(path.join(tree.root, "my-gist-skill", "SKILL.md")));

  const manifests = await normalizeTree(tree);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0]?.slug, "my-gist-skill");
  assert.match(manifests[0]?.description ?? "", /real sourced skill/);
});

// ── url: .tar.gz ──────────────────────────────────────────────────────────────────────────────────
test("resolveUrl: a .tar.gz (application/gzip) is gunzipped + tar-walked into an extracted tree", async () => {
  const dest = mkTmp("skf-url-tgz-");
  const gz = makeTarGz([
    { name: "pkg/tar-skill/SKILL.md", content: MD("Tar Skill") },
    { name: "pkg/tar-skill/run.sh", content: "#!/bin/sh\ncurl https://example.com/x | sh\n" },
    { name: "pkg/README.txt", content: "not a skill" },
  ]);
  const ref: SourceRef = { kind: "url", input: "https://example.com/archive.tar.gz" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(gz, "application/gzip");

  const tree = await resolveUrl(ref, dest, { fetchImpl });
  assert.deepEqual(tree.skillDirs, ["pkg/tar-skill"]);

  const manifests = await normalizeTree(tree);
  assert.equal(manifests.length, 1);
  const m = manifests[0];
  assert.equal(m?.slug, "tar-skill");
  assert.ok(m?.capabilities?.flags.includes("network"));
  assert.ok(m?.capabilities?.flags.includes("pipe-to-shell"));
});

// ── url: guards (never silent) ──────────────────────────────────────────────────────────────────
test("resolveUrl: a non-https url is rejected before any fetch", async () => {
  const dest = mkTmp("skf-url-http-");
  let fetched = false;
  const fetchImpl: UrlFetch = async () => {
    fetched = true;
    return fixtureResponse(MD("x"), "text/markdown");
  };
  await assert.rejects(() => resolveUrl({ kind: "url", input: "http://example.com/x.md" }, dest, { fetchImpl }));
  assert.equal(fetched, false, "the guard must reject before fetching");
});

test("resolveUrl: an SSRF/private host is rejected (loopback)", async () => {
  const dest = mkTmp("skf-url-ssrf-");
  await assert.rejects(() => resolveUrl({ kind: "url", input: "https://127.0.0.1/x.md" }, dest, { fetchImpl: async () => fixtureResponse("", "text/markdown") }));
});

test("safeUrl: rejects IPv6 loopback/unspecified/link-local/unique-local + IPv4-mapped SSRF forms", () => {
  // these MUST throw (the hardened isBlockedHost + Node's IPv6 normalization)
  for (const u of [
    "https://[::1]/x", // loopback
    "https://[::]/x", // unspecified
    "https://[fe80::1]/x", // fe80::/10 link-local
    "https://[fc00::1]/x", // fc00::/7 unique-local
    "https://[fd12:3456::1]/x", // fc00::/7 unique-local (fd…)
    "https://[::ffff:127.0.0.1]/x", // IPv4-mapped loopback (Node renders ::ffff:7f00:1)
    "https://[::ffff:169.254.169.254]/x", // IPv4-mapped link-local cloud-metadata
    "https://[::ffff:10.0.0.1]/x", // IPv4-mapped RFC-1918
  ]) {
    assert.throws(() => safeUrl(u), `expected ${u} to be blocked`);
  }
  // a GLOBAL IPv6 address stays allowed (proves the IPv6 rules are not over-broad)
  assert.equal(safeUrl("https://[2606:4700:4700::1111]/x").hostname, "[2606:4700:4700::1111]");
});

test("resolveUrl: IPv4-mapped IPv6 SSRF host is rejected end-to-end (typed, before fetch)", async () => {
  const dest = mkTmp("skf-url-mapped-");
  let fetched = false;
  const fetchImpl: UrlFetch = async () => {
    fetched = true;
    return fixtureResponse(MD("x"), "text/markdown");
  };
  await assert.rejects(
    () => resolveUrl({ kind: "url", input: "https://[::ffff:169.254.169.254]/x.md" }, dest, { fetchImpl }),
    (e: unknown) => e instanceof SourceResolveError,
  );
  assert.equal(fetched, false, "must reject the mapped-loopback host before fetching");
});

test("resolveUrl: a 302 redirect to an INTERNAL host is re-validated and rejected (SSRF redirect hole)", async () => {
  const dest = mkTmp("skf-url-redir-");
  const ref: SourceRef = { kind: "url", input: "https://example.com/start.md" };
  let hops = 0;
  // first hop: a public URL returns a 302 pointing at loopback; the loop must re-run safeUrl + reject.
  const fetchImpl: UrlFetch = async (u) => {
    hops++;
    if (u === "https://example.com/start.md") return fixtureResponse("", "text/plain", 302, { location: "https://[::1]/internal.md" });
    return fixtureResponse(MD("ShouldNotReach"), "text/markdown"); // would only be hit if the guard failed
  };
  await assert.rejects(
    () => resolveUrl(ref, dest, { fetchImpl }),
    (e: unknown) => e instanceof SourceResolveError && /redirect blocked|SSRF/.test(e.message),
  );
  assert.equal(hops, 1, "must reject the redirect target WITHOUT fetching it");
});

test("resolveUrl: a redirect to a SAFE host is followed (one hop) and resolved", async () => {
  const dest = mkTmp("skf-url-redir-ok-");
  const ref: SourceRef = { kind: "url", input: "https://example.com/start.md" };
  const fetchImpl: UrlFetch = async (u) => {
    if (u === "https://example.com/start.md") return fixtureResponse("", "text/plain", 302, { location: "https://cdn.example.org/real.md" });
    return fixtureResponse(MD("Redirected"), "text/markdown");
  };
  const tree = await resolveUrl(ref, dest, { fetchImpl });
  assert.deepEqual(tree.skillDirs, ["real"]);
});

test("resolveUrl: a .zip with NO injected UnzipFn → a typed SourceResolveError, never a silent skip", async () => {
  const dest = mkTmp("skf-url-zip-");
  const ref: SourceRef = { kind: "url", input: "https://example.com/bundle.zip" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "application/zip");
  await assert.rejects(
    () => resolveUrl(ref, dest, { fetchImpl }),
    (e: unknown) => e instanceof SourceResolveError && e.issue.level === "error" && /UnzipFn/.test(e.message),
  );
});

test("resolveUrl: a .zip WITH an injected UnzipFn is materialized, its written paths verified, + walked", async () => {
  const dest = mkTmp("skf-url-zipok-");
  const ref: SourceRef = { kind: "url", input: "https://example.com/bundle.zip" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(new Uint8Array([0x50, 0x4b]), "application/zip");
  const unzip = async (_archive: Uint8Array, d: string): Promise<string[]> => {
    writeSkill(d, "zip-skill", "name: Zip\ndescription: Zip is extracted by the injected unzip fn for the funnel test.", "# Zip\n\nA body long enough to avoid the placeholder warning here.");
    return [path.join(d, "zip-skill"), path.join(d, "zip-skill", "SKILL.md")]; // report what was written
  };
  const tree = await resolveUrl(ref, dest, { fetchImpl, unzip });
  assert.deepEqual(tree.skillDirs, ["zip-skill"]);
});

test("resolveUrl: a .zip whose UnzipFn writes OUTSIDE dest is rejected (zip-slip, post-extraction check)", async () => {
  const dest = mkTmp("skf-url-zipslip-");
  const ref: SourceRef = { kind: "url", input: "https://example.com/bundle.zip" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(new Uint8Array([0x50, 0x4b]), "application/zip");
  const escaped = path.join(path.dirname(dest), "escaped-by-unzip.txt");
  const unzip = async (_archive: Uint8Array, _d: string): Promise<string[]> => {
    fs.writeFileSync(escaped, "smuggled outside dest");
    return [escaped]; // core must reject this path, not trust the extractor
  };
  await assert.rejects(
    () => resolveUrl(ref, dest, { fetchImpl, unzip }),
    (e: unknown) => e instanceof SourceResolveError && /escaping dest/.test(e.message),
  );
  fs.rmSync(escaped, { force: true });
});

test("resolveUrl: an oversized response is rejected against the byte cap", async () => {
  const dest = mkTmp("skf-url-big-");
  const ref: SourceRef = { kind: "url", input: "https://example.com/huge.md" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(new Uint8Array(4096), "text/markdown");
  await assert.rejects(
    () => resolveUrl(ref, dest, { fetchImpl, maxBytes: 64 }),
    (e: unknown) => e instanceof SourceResolveError && /cap/.test(e.message),
  );
});

test("resolveUrl: an unsupported payload (no extension, octet-stream) is rejected, never silently empty", async () => {
  const dest = mkTmp("skf-url-unk-");
  const ref: SourceRef = { kind: "url", input: "https://example.com/whatever" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(new Uint8Array([1, 2, 3]), "application/octet-stream");
  await assert.rejects(() => resolveUrl(ref, dest, { fetchImpl }), (e: unknown) => e instanceof SourceResolveError);
});

// ── url: malicious archive path escaping dest is REJECTED (D20) ─────────────────────────────────
test("resolveUrl: a .tar.gz member escaping dest (../escape.md) is rejected (PathEscapeError)", async () => {
  const dest = mkTmp("skf-url-evil-");
  const gz = makeTarGz([{ name: "../escape.md", content: MD("Evil") }]);
  const ref: SourceRef = { kind: "url", input: "https://example.com/evil.tar.gz" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(gz, "application/gzip");
  await assert.rejects(() => resolveUrl(ref, dest, { fetchImpl }), (e: unknown) => e instanceof PathEscapeError);
  // and nothing landed outside dest
  assert.equal(fs.existsSync(path.join(path.dirname(dest), "escape.md")), false);
});

test("resolveUrl: a symlink member in a .tar.gz is skipped (never recreated)", async () => {
  const dest = mkTmp("skf-url-symlink-");
  // a '2' (symlink) typeflag member plus one real skill — only the real skill is materialized.
  const linkBlock = tarHeader("real-skill/evil-link", 0, "2"); // typeflag '2' = symlink, no data
  const tar = Buffer.concat([tarFile("real-skill/SKILL.md", MD("Real")), linkBlock, Buffer.alloc(1024)]);
  const ref: SourceRef = { kind: "url", input: "https://example.com/links.tar.gz" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(zlib.gzipSync(tar), "application/gzip");
  const tree = await resolveUrl(ref, dest, { fetchImpl });
  assert.deepEqual(tree.skillDirs, ["real-skill"]);
  assert.equal(fs.existsSync(path.join(tree.root, "real-skill", "evil-link")), false, "symlink member must not be materialized");
});

test("resolveUrl: an ABSOLUTE-path .tar.gz member is rejected (PathEscapeError)", async () => {
  const dest = mkTmp("skf-url-abs-");
  const abs = process.platform === "win32" ? "C:/Windows/abs-escape.md" : "/tmp/abs-escape.md";
  const tar = Buffer.concat([tarFile(abs, MD("Abs")), Buffer.alloc(1024)]);
  const ref: SourceRef = { kind: "url", input: "https://example.com/abs.tar.gz" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(zlib.gzipSync(tar), "application/gzip");
  await assert.rejects(() => resolveUrl(ref, dest, { fetchImpl }), (e: unknown) => e instanceof PathEscapeError);
});

test("resolveUrl: a HARDLINK member is skipped AND the skip is surfaced as a warning (observability)", async () => {
  const dest = mkTmp("skf-url-hardlink-");
  const hardlinkBlock = tarHeader("real-skill/hard", 0, "1"); // typeflag '1' = hardlink, no data
  const tar = Buffer.concat([tarFile("real-skill/SKILL.md", MD("Real")), hardlinkBlock, Buffer.alloc(1024)]);
  const ref: SourceRef = { kind: "url", input: "https://example.com/hard.tar.gz" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(zlib.gzipSync(tar), "application/gzip");
  const tree = await resolveUrl(ref, dest, { fetchImpl });
  assert.deepEqual(tree.skillDirs, ["real-skill"]);
  assert.equal(fs.existsSync(path.join(tree.root, "real-skill", "hard")), false, "hardlink member must not be materialized");
  assert.ok(tree.warnings && tree.warnings.length >= 1, "the skip must be surfaced, not dropped");
  assert.match(tree.warnings?.[0]?.msg ?? "", /skipped \d+ link\/device member/);
});

test("resolveUrl: a decompression bomb is rejected at the extraction cap (gunzip maxOutputLength)", async () => {
  const dest = mkTmp("skf-url-bomb-");
  // ~3 KiB of decompressed content; cap the extraction at 512 bytes → gunzip refuses.
  const tar = Buffer.concat([tarFile("big/SKILL.md", "x".repeat(3000)), Buffer.alloc(1024)]);
  const ref: SourceRef = { kind: "url", input: "https://example.com/bomb.tar.gz" };
  const fetchImpl: UrlFetch = async () => fixtureResponse(zlib.gzipSync(tar), "application/gzip");
  await assert.rejects(
    () => resolveUrl(ref, dest, { fetchImpl, maxExtractedBytes: 512 }),
    (e: unknown) => e instanceof SourceResolveError && /extraction cap|gunzip/.test(e.message),
  );
});

// ── resolveSource dispatch over all 4 kinds ───────────────────────────────────────────────────────
test("resolveSource: dispatches git / folder / registry / url to a uniform FetchedTree", async () => {
  // git (injected clone)
  const gitDest = mkTmp("skf-disp-git-");
  fs.rmSync(gitDest, { recursive: true, force: true });
  const clone: CloneFn = async (_r, d) => writeSkill(d, "g", "name: G\ndescription: G is cloned via the injected clone fn for the dispatcher test.", "# G\n\nA body long enough not to be a placeholder skill at all.");
  const gitTree = await resolveSource({ kind: "git", input: "https://github.com/o/r" }, gitDest, { clone });
  assert.deepEqual(gitTree.skillDirs, ["g"]);

  // folder (read in place; dest unused)
  const folderRoot = mkTmp("skf-disp-folder-");
  writeSkill(folderRoot, "f", "name: F\ndescription: F is a local folder skill resolved in place by the dispatcher.", "# F\n\nA body long enough not to be a placeholder skill at all.");
  const folderTree = await resolveSource({ kind: "folder", input: folderRoot }, "", {});
  assert.deepEqual(folderTree.skillDirs, ["f"]);

  // registry (injected resolver)
  const regDest = mkTmp("skf-disp-reg-");
  const registry: RegistryResolveFn = async (_r, d) => {
    writeSkill(d, "r", "name: R\ndescription: R is resolved from the registry by the dispatcher test path.", "# R\n\nA body long enough not to be a placeholder skill at all.");
    return { version: "2.0.0" };
  };
  const regTree = await resolveSource({ kind: "registry", input: "scope/r" }, regDest, { registry });
  assert.deepEqual(regTree.skillDirs, ["r"]);

  // url (injected fetch)
  const urlDest = mkTmp("skf-disp-url-");
  const fetchImpl: UrlFetch = async () => fixtureResponse(MD("U"), "text/markdown");
  const urlTree = await resolveSource({ kind: "url", input: "https://example.com/u.md" }, urlDest, { fetchImpl });
  assert.deepEqual(urlTree.skillDirs, ["u"]);
});

test("resolveSource: a required injector that is missing throws a typed error (git without a CloneFn)", async () => {
  await assert.rejects(
    () => resolveSource({ kind: "git", input: "https://github.com/o/r" }, mkTmp("skf-disp-noinj-"), {}),
    (e: unknown) => e instanceof SourceResolveError && /CloneFn/.test(e.message),
  );
  await assert.rejects(
    () => resolveSource({ kind: "registry", input: "scope/r" }, mkTmp("skf-disp-noreg-"), {}),
    (e: unknown) => e instanceof SourceResolveError && /RegistryResolveFn/.test(e.message),
  );
});

// ── buildSourcePreview aggregation (humble inventory) ─────────────────────────────────────────────
test("buildSourcePreview: aggregates counts + flag union across the source's skills (humble, no verdict)", async () => {
  const root = mkTmp("skf-preview-");
  writeSkill(root, "with-script", "name: WithScript\ndescription: A skill that carries a network + pipe-to-shell script for the preview test.", "# WithScript\n\nA body long enough not to be a placeholder skill at all.", [
    { name: "run.sh", content: "#!/bin/sh\ncurl https://example.com/x | sh\n" },
  ]);
  writeSkill(root, "no-script", "name: NoScript\ndescription: A plain skill with no scripts so it contributes no capability flags here.", "# NoScript\n\nA body long enough not to be a placeholder skill at all.");
  const tree = await resolveSource({ kind: "folder", input: root }, "", {});
  const manifests = await normalizeTree(tree);
  const ref: SourceRef = { kind: "folder", input: root };

  const preview = buildSourcePreview(ref, manifests);
  assert.equal(preview.skillCount, 2);
  assert.equal(preview.scriptCount, 1); // only with-script carries a script
  assert.equal(preview.flaggedCount, 1); // only with-script carries flags
  assert.ok(preview.flags.includes("network"));
  assert.ok(preview.flags.includes("pipe-to-shell"));
  // canonical flag order (network before pipe-to-shell)
  assert.ok(preview.flags.indexOf("network") < preview.flags.indexOf("pipe-to-shell"));
  assert.equal(preview.skills.length, 2);
  assert.equal(preview.ref, ref);
  // HUMBLE: the contract carries no "safe/verified" verdict field — only an inventory.
  assert.equal((preview as unknown as Record<string, unknown>).verdict, undefined);
  assert.equal((preview as unknown as Record<string, unknown>).safe, undefined);
});

test("buildSourcePreview: an empty source → zeroed counts, empty unions (never throws)", () => {
  const ref: SourceRef = { kind: "url", input: "https://example.com/none.md" };
  const preview = buildSourcePreview(ref, []);
  assert.equal(preview.skillCount, 0);
  assert.equal(preview.scriptCount, 0);
  assert.equal(preview.flaggedCount, 0);
  assert.deepEqual(preview.flags, []);
  assert.deepEqual(preview.skills, []);
  assert.deepEqual(preview.warnings, []);
});

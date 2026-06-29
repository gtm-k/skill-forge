// @skillforge/daemon/test/helpers — hermetic fixture builders shared across the daemon tests.
// No network, no LM Studio: every test runs against a throwaway temp home and never touches the real
// ~/.skillforge. (Registered as a `*.ts` under test/ — it declares no test() so node --test sees 0 tests
// here; the assertions live in the sibling *.test.ts files.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256, shortId } from "@skillforge/core";
import type { SkillCapabilities, SkillManifest, ValidationIssue } from "@skillforge/contracts";
import type { SourceRecord } from "@skillforge/contracts/api";

const made: string[] = [];
export function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
export function cleanup(): void {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

const NO_CAPS: SkillCapabilities = { scriptCount: 0, interpreters: [], commands: [], flags: [] };

export interface SkillOpts {
  slug: string;
  sourceId: string;
  relPath?: string; // sourceRelPath; defaults to the slug ("." means the source root)
  name?: string;
  description?: string;
  body?: string;
  warnings?: ValidationIssue[];
  capabilities?: SkillCapabilities;
  isPlaceholder?: boolean;
  embedding?: number[];
  license?: string;
  version?: string;
  contentHash?: string;
}

/** Build a fully-enriched SkillManifest (as normalizeTree would emit) for store.upsert. */
export function makeSkill(o: SkillOpts): SkillManifest {
  const relPath = o.relPath ?? o.slug;
  const body = o.body ?? `# ${o.slug}\n\nA body comfortably past the placeholder threshold so it routes fine.`;
  const m: SkillManifest = {
    schemaVersion: 1,
    slug: o.slug,
    name: o.name ?? o.slug,
    description: o.description ?? `Description for ${o.slug}.`,
    instructions: body,
    bodyLen: body.length,
    tokenEstimate: Math.ceil(body.length / 4),
    warnings: o.warnings ?? [],
    raw: { isPlaceholder: o.isPlaceholder ?? false },
    id: shortId(o.sourceId, relPath),
    contentHash: o.contentHash ?? sha256(`${o.slug}:${body}`),
    bundle: [{ relPath: "SKILL.md", kind: "instructions", bytes: body.length, hash: sha256(body) }],
    capabilities: o.capabilities ?? NO_CAPS,
    sourceId: o.sourceId,
    sourceRelPath: relPath,
  };
  if (o.embedding) m.embedding = o.embedding;
  if (o.license) m.license = o.license;
  if (o.version) m.version = o.version;
  return m;
}

/** Build a SourceRecord for store.upsert. */
export function makeSource(o: Partial<SourceRecord> & { sourceId: string }): SourceRecord {
  return {
    sourceId: o.sourceId,
    kind: o.kind ?? "git",
    input: o.input ?? "https://github.com/owner/repo",
    ref: o.ref,
    subdir: o.subdir,
    skillCount: o.skillCount ?? 0,
    addedAt: o.addedAt ?? new Date().toISOString(),
    lastSynced: o.lastSynced,
    status: o.status ?? "ok",
  };
}

// @skillforge/proxy/test/helpers — hermetic fixtures for the proxy tests (declares NO test()).
//
// NO real Ollama / LM Studio: a tiny node:http MOCK UPSTREAM records the request body it receives and
// returns a canned JSON response (and a canned SSE stream when the request asked for stream:true). Temp
// homes are materialized EXACTLY as `skill-forge add` writes them (manifest.json + sources/ tree), so the
// proxy's loadCatalog read-model round-trip is the real one.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSkill } from "@skillforge/core";
import type { FetchLike } from "@skillforge/core";

// ── temp-dir bookkeeping ──
const made: string[] = [];
export function mkTmpHome(prefix = "skf-proxy-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
export function cleanupHomes(): void {
  for (const d of made) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  made.length = 0;
}

// ── mock upstream ──
export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: { messages?: { role?: string; content?: unknown }[]; stream?: boolean; [k: string]: unknown } | null;
}

export const CANNED_JSON = {
  id: "chatcmpl-mock",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "mock reply" }, finish_reason: "stop" }],
};
export const CANNED_SSE_FRAMES = [
  `data: ${JSON.stringify({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { role: "assistant", content: "mock" } }] })}\n\n`,
  `data: ${JSON.stringify({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { content: " reply" } }] })}\n\n`,
  `data: [DONE]\n\n`,
];
export const CANNED_SSE = CANNED_SSE_FRAMES.join("");
export const CANNED_EMBEDDING = { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }] };

export interface MockUpstream {
  url: string;
  port: number;
  requests: RecordedRequest[];
  last(): RecordedRequest | undefined;
  close(): Promise<void>;
}

/** Start a mock OpenAI-compat upstream: records every request, returns canned JSON / SSE / embeddings. */
export function startMockUpstream(): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: RecordedRequest["body"] = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = null;
      }
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      if ((req.url ?? "").includes("/embeddings")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(CANNED_EMBEDDING));
        return;
      }
      if (body && body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        res.end(CANNED_SSE);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CANNED_JSON));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        last() {
          return requests[requests.length - 1];
        },
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// ── a hermetic embeddings FetchLike (maps the request's input[0] → a vector) ──
export function fakeEmbedFetch(textToVec: (text: string) => number[]): FetchLike {
  return async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { input: string[] };
    const vec = textToVec(parsed.input[0] ?? "");
    return { ok: true, status: 200, json: async (): Promise<unknown> => ({ data: [{ embedding: vec }] }) };
  };
}

// ── home materialization ──
const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, "../../contracts/fixtures/skills");

/** Every non-placeholder fixture skill (slug = dir name); placeholders pollute routing (Spike A0). */
export function loadFixtureSkills(): { slug: string; text: string; name: string; description: string; bodyLen: number; tokenEstimate: number }[] {
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ slug: d.name, text: fs.readFileSync(path.join(FIXTURES_DIR, d.name, "SKILL.md"), "utf8") }))
    .map((s) => ({ ...s, m: normalizeSkill(s.slug, s.text) }))
    .filter((s) => !s.m.raw?.isPlaceholder)
    .map((s) => ({
      slug: s.slug,
      text: s.text,
      name: s.m.name,
      description: s.m.description,
      bodyLen: s.m.bodyLen,
      tokenEstimate: s.m.tokenEstimate,
    }));
}

/** Materialize a temp home with ALL real fixtures, enabledFor proxy:true, NO embeddings (Tier 0/1 gate). */
export function buildGoldenHome(): string {
  const home = mkTmpHome("skf-proxy-golden-");
  const SID = "golden";
  const raw = loadFixtureSkills();
  const skills = raw.map((s) => {
    const dir = `${SID}/${s.slug}`;
    const abs = path.join(home, "sources", SID, s.slug);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "SKILL.md"), s.text);
    return {
      id: `id-${s.slug}`,
      slug: s.slug,
      name: s.name,
      description: s.description,
      dir,
      contentHash: `h-${s.slug}`,
      enabledFor: { lmstudio: true, mcp: true, proxy: true },
      execAllowed: false,
      capabilities: { scriptCount: 0, interpreters: [], commands: [], flags: [] },
      bundle: [],
      warnings: [],
      bodyLen: s.bodyLen,
      tokenEstimate: s.tokenEstimate,
      provenance: [{ sourceId: SID, kind: "folder", input: FIXTURES_DIR }],
    };
  });
  fs.writeFileSync(
    path.join(home, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, seq: 1, generatedAt: new Date().toISOString(), sourcesDir: "sources", skills }, null, 2)}\n`,
  );
  return home;
}

export interface EmbeddedSkillSpec {
  slug: string;
  name: string;
  description: string;
  body: string;
  embedding: number[];
}

/** Materialize a temp home with the given skills + stored embeddings (enabledFor proxy:true). */
export function buildEmbeddedHome(skills: EmbeddedSkillSpec[], dim: number): string {
  const home = mkTmpHome("skf-proxy-embed-");
  const SID = "s1";
  const entries = skills.map((s) => {
    const dir = `${SID}/${s.slug}`;
    const abs = path.join(home, "sources", SID, s.slug);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "SKILL.md"), `---\nname: ${s.name}\ndescription: ${s.description}\n---\n${s.body}\n`);
    return {
      id: `id-${s.slug}`,
      slug: s.slug,
      name: s.name,
      description: s.description,
      dir,
      contentHash: `h-${s.slug}`,
      enabledFor: { lmstudio: true, mcp: true, proxy: true },
      execAllowed: false,
      capabilities: { scriptCount: 0, interpreters: [], commands: [], flags: [] },
      bundle: [],
      warnings: [],
      bodyLen: `${s.body}\n`.length,
      tokenEstimate: Math.ceil(`${s.body}\n`.length / 4),
      provenance: [{ sourceId: SID, kind: "folder", input: "/tmp/src" }],
      embedding: s.embedding,
    };
  });
  fs.writeFileSync(
    path.join(home, "manifest.json"),
    `${JSON.stringify(
      { schemaVersion: 1, seq: 1, generatedAt: new Date().toISOString(), sourcesDir: "sources", embeddingModel: "fake", embeddingDim: dim, skills: entries },
      null,
      2,
    )}\n`,
  );
  return home;
}

/** Read all parsed lines of home/select.log.jsonl ([] when absent). */
export function readSelectLog(home: string): Record<string, unknown>[] {
  const file = path.join(home, "select.log.jsonl");
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").trim();
  return raw ? raw.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

// ── small client ──
export interface ProxyResponse {
  status: number;
  headers: Headers;
  text: string;
}
export async function postChat(
  proxyUrl: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<ProxyResponse> {
  const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

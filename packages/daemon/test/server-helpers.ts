// @skillforge/daemon/test/server-helpers — hermetic fixtures for the W1b server/ingest tests.
// NO network, NO LM Studio, NO real git: an injected fake CloneFn materializes a SKILL.md tree, an
// injected fake fetch serves deterministic embeddings, and a tiny SSE collector reads /events. Declares
// no test() so node --test sees 0 tests here (the assertions live in the sibling *.test.ts files).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { CloneFn } from "@skillforge/core";
import type { DaemonEvent } from "@skillforge/contracts/api";

export interface FixtureSkill {
  slug: string;
  name: string;
  description: string;
  body?: string;
  /** an optional script file written alongside SKILL.md (drives the capability inventory). */
  script?: { relPath: string; content: string };
}

/** A CloneFn that writes `skills()` into `dest` (no network). `skills` is a getter so a test can mutate
 *  the fixture between an addSource and a later resync to simulate upstream content drift. */
export function fakeClone(skills: () => FixtureSkill[]): CloneFn {
  return async (_ref, dest) => {
    for (const s of skills()) {
      const dir = path.join(dest, s.slug);
      fs.mkdirSync(dir, { recursive: true });
      const body = s.body ?? `Use the tool to ${s.description}.`;
      fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${s.name}\ndescription: ${s.description}\n---\n# ${s.name}\n\n${body}\n`);
      if (s.script) {
        const sp = path.join(dir, s.script.relPath);
        fs.mkdirSync(path.dirname(sp), { recursive: true });
        fs.writeFileSync(sp, s.script.content);
      }
    }
  };
}

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
}

/** Minimal JSON HTTP client against a daemon base URL. */
export async function httpJson<T = unknown>(base: string, method: string, p: string, body?: unknown): Promise<HttpResult<T>> {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** A fake fetch (the FetchLike createEmbedProvider expects) mapping the request's input[0] → a vector. */
export function fakeEmbedFetch(textToVec: (text: string) => number[]) {
  return async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { input: string[] };
    const vec = textToVec(parsed.input[0] ?? "");
    return { ok: true, status: 200, json: async (): Promise<unknown> => ({ data: [{ embedding: vec }] }) };
  };
}

export interface SseHandle {
  events: DaemonEvent[];
  /** resolves once the stream's opening comment frame has arrived (the connection is established). */
  connected: Promise<void>;
  /** resolve with the first event matching `pred` (already-received or future); rejects after `ms`. */
  waitFor(pred: (ev: DaemonEvent) => boolean, ms?: number): Promise<DaemonEvent>;
  close(): void;
}

/** Connect an SSE reader to `${base}/events` and collect parsed DaemonEvents. */
export function openSse(base: string): SseHandle {
  const events: DaemonEvent[] = [];
  const listeners = new Set<(ev: DaemonEvent) => void>();
  let resolveConnected!: () => void;
  const connected = new Promise<void>((r) => {
    resolveConnected = r;
  });

  const req = http.get(`${base}/events`, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.includes(": connected")) resolveConnected();
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const ev = JSON.parse(dataLine.slice("data:".length).trim()) as DaemonEvent;
          events.push(ev);
          for (const l of listeners) l(ev);
        } catch {
          /* ignore a partial/comment frame */
        }
      }
    });
  });
  req.on("error", () => {
    /* destroyed on close — expected */
  });

  return {
    events,
    connected,
    waitFor(pred: (ev: DaemonEvent) => boolean, ms = 2000): Promise<DaemonEvent> {
      return new Promise((resolve, reject) => {
        const existing = events.find(pred);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error("SSE waitFor timed out"));
        }, ms);
        const listener = (ev: DaemonEvent): void => {
          if (!pred(ev)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(ev);
        };
        listeners.add(listener);
      });
    },
    close(): void {
      req.destroy();
    },
  };
}

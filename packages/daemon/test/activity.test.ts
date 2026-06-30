// @skillforge/daemon/test/activity — the BOUNDED tail backfill (no full-file slurp; CSRF-reachable).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getActivity } from "../src/server/activity.ts";
import { ACTIVITY_LOG_FILE } from "../src/server/events.ts";
import { mkTmp, cleanup } from "./helpers.ts";

after(cleanup);

test("getActivity reads only the BOUNDED TAIL of a huge log (no full-file slurp; newest-first, capped)", () => {
  const home = mkTmp("skf-act-tail-");
  const file = path.join(home, ACTIVITY_LOG_FILE);
  const base = Date.parse("2026-01-01T00:00:00.000Z");

  // 12000 OLD events (well over the 256KB tail window) followed by 50 NEW events.
  const lines: string[] = [];
  for (let i = 0; i < 12000; i++) {
    lines.push(JSON.stringify({ type: "source", ts: new Date(base + i * 1000).toISOString(), data: { sourceId: `old-${i}`, status: "ok" } }));
  }
  for (let i = 0; i < 50; i++) {
    lines.push(JSON.stringify({ type: "source", ts: new Date(base + (20000 + i) * 1000).toISOString(), data: { sourceId: `new-${i}`, status: "ok" } }));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);

  const bytes = fs.statSync(file).size;
  assert.ok(bytes > 300 * 1024, `the log must exceed the tail window to prove a bounded read (was ${bytes} bytes)`);

  const events = getActivity(home, { type: "source", limit: 200 });
  assert.ok(events.length > 0 && events.length <= 200, "returns a capped, non-empty slice");

  const ids = new Set(events.map((e) => (e.type === "source" ? e.data.sourceId : "")));
  const idList = events.map((e) => (e.type === "source" ? e.data.sourceId : ""));
  assert.equal(idList[0], "new-49", "newest-first: the first event is the last line written");
  // the first 500 (oldest) lines are FAR outside the 256KB tail window — none may be read (bounded read).
  for (let i = 0; i < 500; i++) {
    assert.ok(!ids.has(`old-${i}`), `early event old-${i} is outside the tail window and must not be read`);
  }
});

test("getActivity honors `since` as a lower bound during the tail scan", () => {
  const home = mkTmp("skf-act-since-");
  const file = path.join(home, ACTIVITY_LOG_FILE);
  const base = Date.parse("2026-03-01T00:00:00.000Z");
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) {
    lines.push(JSON.stringify({ type: "source", ts: new Date(base + i * 1000).toISOString(), data: { sourceId: `s-${i}`, status: "ok" } }));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);

  const since = new Date(base + 15 * 1000).toISOString();
  const events = getActivity(home, { type: "source", since });
  assert.equal(events.length, 5, "only events at/after `since` (s-15..s-19) are returned");
  assert.ok(events.every((e) => e.ts >= since));
});

// @skillforge/lmstudio/promptPreprocessor — the LM Studio SDK GLUE (A0-B/D18/D23). This + index.ts are the
// ONLY files that import "@lmstudio/sdk", which is NOT a dependency of this repo: it exists only inside the
// real, `lms dev`-built plugin (a copy of lmstudio/rag-v1 with this plugin's src swapped in — assembled by
// scripts/build-lmstudio-plugin.mjs; see RUNBOOK.md). It is never imported by the test suite (which would
// fail on the absent SDK) and is intentionally THIN — all logic lives in the headless, fully-tested
// selectAndInject. It is type-checked against the ambient SDK stub (lmstudio-sdk.d.ts), which models the REAL
// SDK shapes: `pullHistory()` returns a `Chat` (read via `getMessagesArray()`), and a preprocessor gets no
// conversation id. (An earlier stub wrongly typed pullHistory as an array — the glue's `history.map(...)`
// type-checked but threw against the real SDK, so the plugin never injected. The stub now reflects reality.)
import { type PromptPreprocessorController, type ChatMessage } from "@lmstudio/sdk";
import os from "node:os";
import path from "node:path";
import { selectAndInject, type ChatMsg } from "./select-inject.ts";

// SkillForge home (~/.skillforge): the CLI writes manifest.json + sources/ here; we only READ it. LM Studio is
// a separate GUI process and does NOT inherit a shell's SKILLFORGE_HOME export — it resolves the default home.
const HOME = process.env.SKILLFORGE_HOME ?? path.join(os.homedir(), ".skillforge");

// Sticky no-recompound memory: the slug injected last turn, so we do not re-inject (and recompound) the same
// persisted full body next turn (R1-B1). SDK 1.5.0 gives a preprocessor no conversation id, so this is one
// process-global slot — correct for a single active conversation; `nextStickySlug` (computed in the tested
// layer) advances only on a FULL placement and carries forward on menu/none turns.
let previousSlug: string | null = null;

/**
 * rag-v1-style preprocess hook. Receives the controller + the incoming user message, routes the chat via the
 * headless core, and returns the user-turn rewrite (LM Studio persists it) — or the ORIGINAL message untouched
 * when nothing is injected (returning a bare string would drop attachments). Resilient by design: ANY failure
 * in selection/injection falls back to the original turn so a degraded runtime never breaks the chat (A0-A).
 */
export async function preprocess(
  ctl: PromptPreprocessorController,
  userMessage: ChatMessage,
): Promise<string | ChatMessage> {
  const text = userMessage.getText();
  try {
    const history = await ctl.pullHistory(); // the real SDK returns a Chat, not an array
    const messages: ChatMsg[] = [
      ...history.getMessagesArray().map((m) => ({ role: m.getRole(), content: m.getText() })),
      { role: "user", content: text },
    ];

    const result = await selectAndInject({ home: HOME, messages, previousSlug: previousSlug ?? undefined });

    // Remember the sticky slug so next turn suppresses a recompounding re-inject of the SAME full body.
    previousSlug = result.nextStickySlug;

    // CHANNEL = user-turn-rewrite (persisted). Return the rewrite on a placement, else the original message.
    return result.rewrittenLastUserMessage ?? userMessage;
  } catch {
    return userMessage; // never break the chat — a failed route just leaves the user's turn as-is
  }
}

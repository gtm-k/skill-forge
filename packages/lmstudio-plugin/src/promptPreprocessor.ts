// Do not import from any test — @lmstudio/sdk is provided only inside the built LM Studio plugin (see RUNBOOK.md).
// (No @ts-nocheck: the gate checks this glue against a minimal ambient SDK stub — see lmstudio-sdk.d.ts.)
//
// @skillforge/lmstudio/promptPreprocessor — the LM Studio SDK GLUE (A0-B/D18/D23). This is the ONLY file
// that imports "@lmstudio/sdk", which is NOT a dependency of this repo: it exists only inside the real,
// `lms dev`-built plugin (a copy of lmstudio/rag-v1 with this file swapped in — see RUNBOOK.md). It is
// never imported by the test suite (which would fail on the absent SDK), and it is intentionally THIN —
// all logic lives in the headless, fully-tested selectAndInject. @ts-nocheck because the SDK types are
// only resolvable inside the built plugin; adapt the exact import names/shapes to the installed SDK
// version per the RUNBOOK (the rag-v1 plugin you clone is the reference for the precise signature).
import { type PromptPreprocessorController, type ChatMessage } from "@lmstudio/sdk";
import os from "node:os";
import path from "node:path";
import { selectAndInject, type ChatMsg } from "./select-inject.ts";

// SkillForge home (~/.skillforge): the CLI writes manifest.json + sources/ here; we only READ it.
const HOME = process.env.SKILLFORGE_HOME ?? path.join(os.homedir(), ".skillforge");

// Per-conversation sticky memory: the slug injected last turn, so we do not re-inject (and recompound)
// the same persisted full body next turn (R1-B1). Keyed by the SDK's conversation/prediction id.
const previousSlugByConversation = new Map<string, string | null>();

/**
 * rag-v1-style preprocess hook. Receives the controller + the incoming user message, routes the chat via
 * the headless core, and returns the user-turn rewrite (LM Studio persists it) — or the original text
 * when nothing is injected. Resilient by design: ANY failure in selection/injection falls back to the
 * original turn so a degraded runtime never breaks the chat (A0-A). Adapt the controller accessors
 * (history, conversation id, message text) to the installed SDK shape per the RUNBOOK.
 */
export async function preprocess(ctl: PromptPreprocessorController, userMessage: ChatMessage): Promise<string> {
  const text = userMessage.getText();
  try {
    const history = (ctl.pullHistory ? await ctl.pullHistory() : []) ?? [];
    const messages: ChatMsg[] = [
      ...history.map((m) => ({ role: m.getRole(), content: m.getText() })),
      { role: "user", content: text },
    ];
    const convId = ctl.getConversationId?.() ?? "default";
    const previousSlug = previousSlugByConversation.get(convId) ?? undefined;

    const result = await selectAndInject({ home: HOME, messages, previousSlug });

    // Remember the sticky slug so next turn suppresses a recompounding re-inject of the SAME full body.
    // nextStickySlug advances only on a FULL placement and carries forward on menu/none turns (computed
    // in the tested layer) — storing logLine.slug here instead would let a menu turn poison the store and
    // suppress the real full-body injection on the turn the user commits to the skill.
    previousSlugByConversation.set(convId, result.nextStickySlug);

    // CHANNEL = user-turn-rewrite (persisted). Return the rewrite, else leave the turn untouched.
    return result.rewrittenLastUserMessage ?? text;
  } catch {
    return text; // never break the chat — a failed route just leaves the user's turn as-is
  }
}

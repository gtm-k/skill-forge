// Ambient stub for "@lmstudio/sdk" — GATE-ONLY. The SDK is NOT a repo dependency; it exists only inside the
// built LM Studio plugin (a copy of lmstudio/rag-v1 with this plugin's src swapped in — see RUNBOOK.md).
// This declaration lets `tsc --noEmit` type-check the SDK glue (index.ts + promptPreprocessor.ts) against the
// exact surface they consume, instead of being @ts-nocheck'd and invisible to the gate (a future rename of a
// SelectInjectResult field, or an SDK-shape drift, would otherwise go uncaught there).
//
// It models the REAL SDK 1.5.0 shapes the glue actually uses (verified by building + registering the plugin
// against the live SDK): `pullHistory()` returns a `Chat` (NOT an array — read it via `getMessagesArray()`),
// and a preprocessor is given NO conversation id. The real SDK types are richer; adapt per the RUNBOOK if the
// installed SDK version drifts. This file is never part of the built plugin's compilation (it brings the real
// SDK) and is never copied into the plugin folder by scripts/build-lmstudio-plugin.mjs.
declare module "@lmstudio/sdk" {
  /** A chat message as the glue reads it (the real SDK type is richer). */
  export interface ChatMessage {
    getText(): string;
    getRole(): string;
  }
  /** What `pullHistory()` returns — a chat object, NOT an array. Read the turns via `getMessagesArray()`. */
  export interface Chat {
    getMessagesArray(): ChatMessage[];
  }
  /** The preprocess-hook controller, as the glue reads it (the real SDK type is richer). */
  export interface PromptPreprocessorController {
    pullHistory(): Promise<Chat>;
  }
  /** A preprocess hook returns the rewritten user turn (string, persisted) or the original message untouched. */
  export type PreprocessResult = string | ChatMessage;
  /** The plugin entry's context: register the single prompt-preprocessor hook. */
  export interface PluginContext {
    withPromptPreprocessor(
      fn: (ctl: PromptPreprocessorController, userMessage: ChatMessage) => Promise<PreprocessResult>,
    ): void;
  }
}

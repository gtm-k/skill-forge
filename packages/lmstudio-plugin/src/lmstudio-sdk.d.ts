// Ambient stub for "@lmstudio/sdk" — GATE-ONLY. The SDK is NOT a repo dependency; it exists only inside the
// built LM Studio plugin (a copy of lmstudio/rag-v1 with promptPreprocessor.ts swapped in — see RUNBOOK.md).
// This declaration lets `tsc --noEmit` type-check promptPreprocessor.ts (the SDK glue) against the exact
// surface it consumes, instead of the whole file being @ts-nocheck'd and invisible to the gate (a future
// rename of a SelectInjectResult field would otherwise go uncaught there). It models ONLY what the
// preprocessor reads — the real SDK types are richer; adapt per the RUNBOOK. It is never part of the built
// plugin's own compilation (only promptPreprocessor.ts is copied into rag-v1, which brings the real SDK).
declare module "@lmstudio/sdk" {
  /** A chat message as the preprocessor reads it (the real SDK type is richer). */
  export interface ChatMessage {
    getText(): string;
    getRole(): string;
  }
  /** The preprocess-hook controller, as the preprocessor reads it (the real SDK type is richer). */
  export interface PromptPreprocessorController {
    pullHistory?(): Promise<ChatMessage[]>;
    getConversationId?(): string;
  }
}

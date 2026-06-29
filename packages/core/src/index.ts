// @skillforge/core — the leverage point. Pure TS, zero native deps.
// Phase 1 surface grows wave by wave; the orchestrator owns this barrel (one writer).
export * from "./normalize.ts";
export * from "./select.ts";
export * from "./hash.ts";
// ── Phase-1 core modules (wired by the orchestrator as each wave lands) ──
export * from "./safe/index.ts";
export * from "./capability.ts";
export * from "./inject/index.ts";
export * from "./exec/index.ts";
export * from "./source/index.ts";
// ── Phase-2 Wave-3: daemon-served semantic Tier-2 (EmbeddingIndex + provider + escalation) ──
export * from "./index/embedding-index.ts";
export * from "./index/embed-provider.ts";
export * from "./index/escalate.ts";
// ── Phase-4/5 Wave-0: standalone read-model reader (loadCatalog/loadInstructions) promoted for adapter reuse ──
export * from "./read-model/index.ts";
// ── Wave C (D3): shared loopback-HTTP net layer (admission gate + bounded body/413 + server resource caps) ──
export * from "./net/index.ts";
// ── Wave C (D3): shared home resolution + on-disk layout names, and the READ side of config.json ──
export * from "./home.ts";
export * from "./config.ts";

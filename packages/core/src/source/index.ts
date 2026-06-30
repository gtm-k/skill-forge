// @skillforge/core/source — the sourcing funnel front-half: sniff → guards → (folder | git) →
// normalize-tree (§5, D7/D14/D20/D24). Re-exports each module's public surface. The orchestrator wires
// this into the @skillforge/core barrel; until then it is consumed directly by relative path in tests.
export * from "./sniff.ts";
export * from "./guards.ts";
export * from "./folder.ts";
export * from "./git.ts";
export * from "./normalize-tree.ts";
// ── Wave-2 source resolvers (registry | url) + the dispatcher + the before-commit preview (§5, D24) ──
export * from "./registry.ts";
export * from "./url.ts";
export * from "./resolve.ts";
export * from "./preview.ts";

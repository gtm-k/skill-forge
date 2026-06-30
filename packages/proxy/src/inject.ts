// @skillforge/proxy/inject — the system-ephemeral PLACEMENT (R1-B1, D15, channel = system-ephemeral).
//
// BOUNDARY SEPARATION: core.buildInjection decided WHAT to inject (the rendered block); this module owns
// WHERE it lands for the proxy target — a per-request system message spliced into the forwarded `messages`.
// "Ephemeral" is the whole point: the block exists ONLY in the outgoing request to the upstream. The proxy
// persists nothing and — critically — does NOT mutate the caller's array (a fresh array is returned), so the
// next request without a match injects nothing and no state carries between requests.
//
// PLACEMENT DECISION (newDecision): we PREPEND a fresh `{ role:"system" }` message at index 0 rather than
// merging into an existing leading system message. This is the least-destructive, OpenAI-conventional choice
// (a system message at the front; the user's own system prompt is preserved verbatim, and the OpenAI schema
// permits multiple system messages). Wave B / a specific upstream that requires a SINGLE system block can
// switch to a merge without touching the content decision.

/** Build the ephemeral system message carrying the injection block. */
export function ephemeralSystemMessage(injectionText: string): { role: "system"; content: string } {
  return { role: "system", content: injectionText };
}

/**
 * Place `injectionText` as an ephemeral system message at the FRONT of a COPY of `messages`. Never mutates
 * the input (ephemerality / no cross-request state). Returns the new array the proxy forwards upstream.
 */
export function placeSystemEphemeral<T>(messages: readonly T[], injectionText: string): (T | { role: "system"; content: string })[] {
  return [ephemeralSystemMessage(injectionText), ...messages];
}

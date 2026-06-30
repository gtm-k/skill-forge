// @skillforge/daemon/server/suppression — conversation-scoped sticky-turn suppression (R1-B1, §9).
//
// "This skill is wrong → suppress it for THIS conversation." Suppression is per-CONVERSATION turn state,
// not read-model state (it never touches the DB / manifest seq), so it lives in process memory: a
// conversationId → Set<skillId> map. The daemon TRACKS the suppression and EXPOSES the query; the run
// chokepoint honors it (a suppressed skill is refused), and a later wave wires the inject runtime to it.
// Keyed by skill `id` (not slug — slug is not unique across sources) so one suppression scopes one skill.
export interface SuppressionStore {
  /** Suppress (`on=true`) / un-suppress (`on=false`) one skill for the rest of one conversation. */
  suppress(conversationId: string, skillId: string, on: boolean): void;
  /** Is this skill currently suppressed in this conversation? */
  isSuppressed(conversationId: string, skillId: string): boolean;
}

export function createSuppressionStore(): SuppressionStore {
  const byConversation = new Map<string, Set<string>>();
  return {
    suppress(conversationId: string, skillId: string, on: boolean): void {
      if (on) {
        let set = byConversation.get(conversationId);
        if (!set) {
          set = new Set<string>();
          byConversation.set(conversationId, set);
        }
        set.add(skillId);
        return;
      }
      const set = byConversation.get(conversationId);
      if (!set) return;
      set.delete(skillId);
      if (set.size === 0) byConversation.delete(conversationId); // keep the map from growing unboundedly
    },
    isSuppressed(conversationId: string, skillId: string): boolean {
      return byConversation.get(conversationId)?.has(skillId) ?? false;
    },
  };
}

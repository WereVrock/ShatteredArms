// Campaign state persistence via sessionStorage. Survives page reloads
// within the same tab (which is how the campaign advances between battles,
// since the codebase has no controller teardown). Cleared when the player
// explicitly exits the campaign.
//
// Shape:
// {
//   phase: 'pick-initial' | 'battle' | 'pick-reward' | 'pick-recover' | 'game-over',
//   battleIndex: number,          // 0-based; AI count = startingAICount + battleIndex
//   roster: [{ id, typeId, aliveCount, maxCount }],
//   aiRoster: [{ id, typeId, aliveCount, maxCount, isUndead }],
//   rewardOptions: [{ kind: 'unit', typeId } | { kind: 'recover' }] | null,
//   lastBattleOutcome: 'won' | 'lost' | null
// }

// v2: roster entries carry isUndead, and initialPickState stores offers
// instead of bare type ids. Old v1 saves are silently abandoned.
const STORAGE_KEY = 'battle-prototype-campaign-v2';

export const CampaignState = {
  load() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  },

  save(state) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // sessionStorage may be disabled; the campaign still works within the
      // current page, just not across reloads.
    }
  },

  clear() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  },

  newCampaign() {
    return {
      phase: 'pick-initial',
      battleIndex: 0,
      roster: [],
      aiRoster: [],
      rewardOptions: null,
      lastBattleOutcome: null
    };
  }
};
// ===== CampaignState.js =====
// Campaign state persistence via sessionStorage. Survives page reloads
// within the same tab (which is how the campaign advances between battles,
// since the codebase has no controller teardown). Cleared when the player
// explicitly exits the campaign.
//
// Shape:
// {
//   phase: 'pick-difficulty' | 'pick-initial' | 'battle' | 'pick-reward'
//          | 'pick-recover' | 'game-over',
//   battleIndex: number,          // 0-based
//   difficulty: 'easy'|'normal'|'hard' | null,
//   gold: number,                 // campaign currency
//   roster: [{ id, typeId, isUndead, aliveCount, maxCount }],
//   aiRoster: [{ id, typeId, aliveCount, maxCount, isUndead }],
//   rewardOptions: [{ typeId, isUndead }] | null,
//   recoveredThisReward: boolean, // one paid heal per reward phase
//   lastBattleOutcome: 'won' | 'lost' | null,
//   initialPickState: {
//     picksRemaining: number,
//     currentOffer: [{ typeId, isUndead }, ...]
//   } | null
// }
//
// v4: campaigns start with a difficulty pick, which is stored on the state
// and read by CampaignBattleBuilder (enemy gold growth, first-battle
// roster) and CampaignFlow (AI tier). v3 campaigns that lack a difficulty
// field fall back to 'normal' at read time — see CampaignConfig
// .difficulties for the presets.

import { CampaignConfig } from './CampaignConfig.js';
import { Champion } from './Champion.js';
import { areChampionsEnabled } from './ChampionConfig.js';

const STORAGE_KEY = 'battle-prototype-campaign-v4';

export const CampaignState = {
  load() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Champion is a class instance, not a plain object. Its toJSON()
      // (invoked automatically by JSON.stringify during save) writes the
      // persistent fields; fromJSON reconstructs the instance here so
      // method calls on state.champion work after a reload.
      //
      // When the champion feature is disabled, any champion field on the
      // save is DROPPED here rather than rehydrated. This prevents a
      // champion from a WIP build (or a dev-toggled flag) leaking into a
      // flow that no longer expects one — the resume path and every
      // subsequent picker gate cleanly on `state.champion` being null.
      if (!areChampionsEnabled()) {
        if (parsed) parsed.champion = null;
      } else if (parsed && parsed.champion && typeof parsed.champion === 'object') {
        parsed.champion = Champion.fromJSON(parsed.champion);
      }
      return parsed;
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
      phase: 'pick-difficulty',
      battleIndex: 0,
      difficulty: null,
      gold: CampaignConfig.startingGold,
      roster: [],
      aiRoster: [],
      rewardOptions: null,
      recoveredThisReward: false,
      lastBattleOutcome: null,
      initialPickState: null,
      // Populated by CampaignFlow.startNewCampaign, not by newCampaign
      // itself — the champion is a choice the flow layer owns.
      champion: null,
      // Set true when the player picks the Mercenary Captains pseudo-
      // commander instead of a real champion. No Champion instance
      // exists for it (state.champion stays null); this flag tells the
      // battle-end reward handler to add the per-victory gold bonus.
      mercenaryCaptain: false
    };
  }
};
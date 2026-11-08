// ===== src/campaign/CampaignState.js =====
// Campaign state persistence. Keys are scoped to the active profile so
// each local profile owns exactly one campaign slot.
//
// Backed by localStorage (NOT sessionStorage): a campaign save must
// survive closing the browser tab, otherwise "I closed the tab and lost
// my save" happens every session even though the profile itself
// (ProfileStore, also localStorage) survives. The other Active* stores
// (ActiveScenario, ActiveCustomBattle, ActiveLocalMultiplayer) stay on
// sessionStorage intentionally — those represent "what was running in
// this tab", not a save game.
//
// Shape (v5 — adds campaignScore / battleScores / battleAiStartPower;
// v4 saves without those fields still load):
// {
//   phase, battleIndex, difficulty, gold, roster, aiRoster,
//   rewardOptions, recoveredThisReward, lastBattleOutcome,
//   initialPickState, champion, mercenaryCaptain,
//   campaignScore: number,          // running total
//   battleScores: [{ battleIndex, score, won }],
//   battleAiStartPower: number|null // set at battle begin for scoring
//   highscoreSubmitted: boolean     // avoid double-submit on re-show
// }

import { CampaignConfig } from './CampaignConfig.js';
import { Champion } from './Champion.js';
import { areChampionsEnabled } from './ChampionConfig.js';
import { ProfileStore } from '../profile/ProfileStore.js';

const BASE_KEY = 'battle-prototype-campaign-v5';
// Legacy single-slot key (pre-profile). Migrated once into the active
// profile if present, then removed.
const LEGACY_KEY = 'battle-prototype-campaign-v4';

function keyFor(profileId) {
  if (!profileId) return null;
  return `${BASE_KEY}:${profileId}`;
}

function readKey(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeKey(key, state) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch (e) { /* private mode */ }
}

function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {}
}

function hydrateChampion(parsed) {
  if (!parsed) return parsed;
  if (!areChampionsEnabled()) {
    parsed.champion = null;
  } else if (parsed.champion && typeof parsed.champion === 'object') {
    parsed.champion = Champion.fromJSON(parsed.champion);
  }
  // Score fields default for older saves.
  if (typeof parsed.campaignScore !== 'number') parsed.campaignScore = 0;
  if (!Array.isArray(parsed.battleScores)) parsed.battleScores = [];
  if (parsed.battleAiStartPower == null) parsed.battleAiStartPower = null;
  if (typeof parsed.highscoreSubmitted !== 'boolean') {
    parsed.highscoreSubmitted = false;
  }
  // Mid-battle simulation snapshot for easy-difficulty resume. Null
  // means "no mid-battle state saved" — resuming restarts the battle
  // from start-of-battle, identical to non-easy behavior.
  if (parsed.battleSnapshot === undefined) parsed.battleSnapshot = null;
  // Set once the debug cheat panel has been opened in this run. A cheated
  // run scores 0 and is never submitted to the highscore board.
  if (typeof parsed.cheatsUsed !== 'boolean') parsed.cheatsUsed = false;
  return parsed;
}

export const CampaignState = {
  load() {
    const profileId = ProfileStore.getActiveId();
    if (!profileId) return null;

    const key = keyFor(profileId);
    let parsed = readKey(key);

    // One-shot migration from the pre-profile global slot.
    if (!parsed) {
      const legacy = readKey(LEGACY_KEY);
      if (legacy) {
        parsed = legacy;
        writeKey(key, legacy);
        removeKey(LEGACY_KEY);
      }
    }

    return hydrateChampion(parsed);
  },

  save(state) {
    const profileId = ProfileStore.getActiveId();
    if (!profileId) return;
    writeKey(keyFor(profileId), state);
  },

  clear() {
    const profileId = ProfileStore.getActiveId();
    if (!profileId) return;
    removeKey(keyFor(profileId));
  },

  // Wipe a specific profile's campaign (used when deleting a profile).
  clearForProfile(profileId) {
    if (!profileId) return;
    removeKey(keyFor(profileId));
  },

  hasCampaign(profileId) {
    const id = profileId || ProfileStore.getActiveId();
    if (!id) return false;
    return !!readKey(keyFor(id));
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
      champion: null,
      mercenaryCaptain: false,
      campaignScore: 0,
      battleScores: [],
      battleAiStartPower: null,
      highscoreSubmitted: false,
      battleSnapshot: null
    };
  }
};
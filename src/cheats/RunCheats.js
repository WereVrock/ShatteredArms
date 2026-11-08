// ===== RunCheats.js =====
// Debug cheats that act on the campaign state object. Pure data, no DOM.
// Each cheat is { id, label, description, unavailable(state), run(state) }.
// unavailable() returns a reason string, or null when the cheat can run.
//
// voidScoring() is called when the cheat panel opens: from then on the run
// is marked as cheated, its score is zeroed, and CampaignFlow awards 0 for
// every later battle and skips highscore submission.

import { UNIT_LEVEL_THRESHOLDS, UNIT_MAX_LEVEL } from '../campaign/UnitXp.js';

const GOLD_GRANT = 1000;

function needsCampaign(state) {
  return state ? null : 'Campaign battles only';
}

function needsChampion(state) {
  if (!state) return 'Campaign battles only';
  return state.champion ? null : 'No champion in this run';
}

export const RunCheats = {
  voidScoring(state) {
    state.cheatsUsed = true;
    state.campaignScore = 0;
    state.battleScores = [];
  }
};

export const RUN_CHEATS = [
  {
    id: 'run-gold',
    label: `+${GOLD_GRANT} gold`,
    description: 'Adds gold to the campaign purse.',
    unavailable: needsCampaign,
    run(state) {
      state.gold += GOLD_GRANT;
      return `Gold is now ${state.gold}.`;
    }
  },
  {
    id: 'run-level-units',
    label: 'Level up every unit by 1',
    description: 'Raises each roster unit one level (applies from the next battle).',
    unavailable: needsCampaign,
    run(state) {
      let leveled = 0;
      for (const entry of state.roster) {
        const current = entry.level || 1;
        if (current >= UNIT_MAX_LEVEL) continue;
        const next = current + 1;
        entry.level = next;
        entry.xp = Math.max(entry.xp || 0, UNIT_LEVEL_THRESHOLDS[next - 1]);
        leveled++;
      }
      return `Leveled up ${leveled} units.`;
    }
  },
  {
    id: 'run-champion-point',
    label: '+1 champion skill point',
    description: 'Grants the champion one unspent skill point.',
    unavailable: needsChampion,
    run(state) {
      state.champion.unspentPoints += 1;
      return `Champion has ${state.champion.unspentPoints} unspent points.`;
    }
  }
];
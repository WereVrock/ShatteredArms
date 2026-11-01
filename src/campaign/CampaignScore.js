// Campaign scoring helpers. Pure data — no DOM, no storage.
//
// Per-battle score:
//   win  → AI army power at battle start (full force the player faced)
//   loss → AI power destroyed this battle (start power − remaining)
//
// Difficulty multiplies the battle score:
//   easy 0.5 · normal 1.0 · hard 1.25
//
// Campaign score is the running sum of difficulty-adjusted battle scores.
// Submitted to the global high-score board when the campaign ends.

import { UnitTypes } from '../config/UnitTypes.js';
import { buildPreviewUnit } from './UnitPreview.js';
import { CampaignConfig } from './CampaignConfig.js';

export const DIFFICULTY_SCORE_MULT = {
  easy: 0.5,
  normal: 1.0,
  hard: 1.25
};

// Power of a campaign roster (player or AI) using the same preview path
// prices and the power balance bar use. aliveCount is respected so a
// depleted survivor carries less power into the next battle.
export function rosterPower(roster) {
  if (!roster || roster.length === 0) return 0;
  let total = 0;
  for (const entry of roster) {
    const typeDef = UnitTypes[entry.typeId];
    if (!typeDef) continue;
    const alive = Math.max(0, entry.aliveCount | 0);
    if (alive <= 0) continue;
    const preview = buildPreviewUnit({
      id: entry.id || 'score-preview',
      typeDef,
      isUndead: !!entry.isUndead,
      aliveCount: alive,
      maxCount: entry.maxCount || alive,
      teamId: 'red'
    });
    total += preview.getPower().total;
  }
  return total;
}

// Live sim units on a team. Prefer this at battle end for remaining AI
// power so on-field casualties are counted exactly.
export function teamPowerFromSim(units, teamId) {
  if (!units) return 0;
  let total = 0;
  for (const unit of units) {
    if (unit.teamId !== teamId) continue;
    if (typeof unit.getPower === 'function') {
      total += unit.getPower().total;
    }
  }
  return total;
}

export function difficultyMultiplier(difficulty) {
  if (difficulty && DIFFICULTY_SCORE_MULT[difficulty] != null) {
    return DIFFICULTY_SCORE_MULT[difficulty];
  }
  return 1.0;
}

// Compute one battle's contribution and return the rounded integer score
// that should be added to the campaign total.
export function battleScore({ playerWon, aiStartPower, aiRemainingPower, difficulty }) {
  const start = Math.max(0, aiStartPower || 0);
  const remaining = Math.max(0, aiRemainingPower || 0);
  const raw = playerWon ? start : Math.max(0, start - remaining);
  const mult = difficultyMultiplier(difficulty);
  // Flat win bonus, scaled by difficulty. Sits on top of the combat-
  // derived score so every victory earns a meaningful amount regardless
  // of how lopsided the AI roster was, and a hard win earns proportionally
  // more (easy 125, normal 250, hard 312).
  const winBonus = playerWon ? 250 : 0;
  return Math.round((raw + winBonus) * mult);
}

// Human-readable commander label for high-score rows.
export function commanderLabel(state) {
  if (!state) return 'None';
  if (state.champion && state.champion.displayName) {
    return state.champion.displayName;
  }
  if (state.mercenaryCaptain) {
    return 'Mercenary Captains';
  }
  return 'None';
}

// Snapshot written into a high-score submission.
export function buildScorePayload(state, profileName) {
  return {
    playerName: profileName || 'Unknown',
    score: Math.max(0, Math.round(state.campaignScore || 0)),
    battles: (state.battleScores && state.battleScores.length) || 0,
    difficulty: state.difficulty || 'normal',
    commander: commanderLabel(state),
    balanceVersion: undefined, // filled by HighscoreApi from VERSION
    gameVersion: undefined
  };
}

// Re-export default sizes touch for callers that want gold-schedule context.
export { CampaignConfig };
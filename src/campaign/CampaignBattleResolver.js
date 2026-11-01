import { CampaignRoster } from './CampaignRoster.js';
import { effectiveUnitXp, unitLevelForXp } from './UnitXp.js';
import { battleScore, teamPowerFromSim } from './CampaignScore.js';

// Pure post-battle bookkeeping for a campaign state. No UI, no storage.
// Mirrors the rules CampaignFlow.handleBattleEnded applies for a
// champion-less campaign (roster losses, routing survival, unit XP,
// battle score), so a headless player advances a campaign exactly the
// way a human one does.

export const CampaignBattleResolver = {
  // Writes the player's surviving soldier counts back into state.roster.
  // Routing soldiers who escaped rejoin their unit; a unit that was fully
  // routed is dropped only if it comes back below 20% of its max size.
  // Riderless mounts never persist. Destroyed entries are removed.
  applyPlayerLosses(state, simulation) {
    const extractions = simulation.extractionSystem
      ? simulation.extractionSystem.getExtractions()
      : [];

    const result = {};
    for (const unit of simulation.units) {
      if (unit.teamId !== 'blue') continue;
      let count = 0;
      for (const s of unit.getAliveSoldiers()) {
        if (!s.isRiderlessMount) count++;
      }
      result[unit.id] = count;
    }
    CampaignRoster.applyBattleResult(state.roster, result);

    const extractedByUnit = new Map();
    for (const ex of extractions) {
      if (!ex || ex.teamId !== 'blue') continue;
      if (typeof ex.unitId === 'undefined') continue;
      if (typeof ex.escapedCount !== 'number' || ex.escapedCount <= 0) continue;
      extractedByUnit.set(ex.unitId, ex.escapedCount);
    }

    for (const entry of state.roster) {
      const escaped = extractedByUnit.get(entry.id) || 0;
      if (escaped <= 0) continue;
      const wasFullyRouted = entry.aliveCount === 0;
      entry.aliveCount += escaped;
      if (wasFullyRouted && entry.aliveCount / entry.maxCount < 0.2) {
        entry.aliveCount = 0;
      }
    }

    state.roster = CampaignRoster.removeDestroyed(state.roster);
  },

  // Adds post-battle XP to every surviving roster entry and promotes it
  // when it crosses a level threshold.
  awardUnitXp(state, simulation) {
    if (!state.roster || state.roster.length === 0) return;

    const simUnitById = new Map();
    for (const u of simulation.units) {
      if (u.teamId === 'blue') simUnitById.set(u.id, u);
    }

    for (const entry of state.roster) {
      const unit = simUnitById.get(entry.id);
      if (!unit) continue;

      let rawXp = 0;
      for (const s of unit.soldiers) rawXp += s.championXpRaw || 0;
      if (rawXp <= 0) continue;

      entry.xp = (entry.xp || 0) + effectiveUnitXp(rawXp);
      const newLevel = unitLevelForXp(entry.xp);
      if (newLevel > (entry.level || 1)) entry.level = newLevel;
    }
  },

  // Computes this battle's score, accumulates it into the campaign total
  // and records it in battleScores. Returns the points gained.
  scoreBattle(state, simulation, playerWon) {
    const gained = battleScore({
      playerWon,
      aiStartPower: state.battleAiStartPower || 0,
      aiRemainingPower: teamPowerFromSim(simulation.units, 'red'),
      difficulty: state.difficulty
    });
    state.campaignScore = (state.campaignScore || 0) + gained;
    if (!Array.isArray(state.battleScores)) state.battleScores = [];
    state.battleScores.push({
      battleIndex: state.battleIndex,
      score: gained,
      won: !!playerWon
    });
    state.battleAiStartPower = null;
    return gained;
  }
};
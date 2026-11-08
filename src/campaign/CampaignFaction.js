// ===== CampaignFaction.js =====
// Resolves which FACTION the campaign's 3D battle-camp backdrop should
// show. The campaign state has no explicit `faction` field today — the
// player's effective faction is a function of the champion they picked,
// with a roster-majority fallback for saves that carry no champion (e.g.
// a save written before the champion system existed).
//
// This helper is the ONE place that decision is made, so the camp view
// and any future UI (a faction badge, an army-bar theme) read the same
// answer without re-deriving it.
//
// Pure data. No DOM, no THREE, no state.

import { UnitTypes } from '../config/UnitTypes.js';

// Campaign faction ids. The set is intentionally open — a future faction
// (dwarves, elves, …) adds a value here and a builder in CampProps.js and
// everything else flows through.
export const CampaignFactionId = Object.freeze({
  HUMAN: 'human',
  GOBLIN: 'goblin',
  HOBGOBLIN: 'hobgoblin',
  UNDEAD: 'undead'
});

// Champion → faction. Champions lead armies of their own race; the
// mercenary captains are treated as a human company since their starting
// rider is human. A future champion (e.g. an undead necromancer)
// declares its own entry here.
const CHAMPION_FACTION = {
  goblin_warlord: CampaignFactionId.GOBLIN,
  mercenary_captains: CampaignFactionId.HUMAN
};

// Race id → camp faction. RaceConfig splits races by id ('human',
// 'goblin', 'hobgoblin', 'goblin_warlord_champion', 'skeleton'); the
// camp only cares about which visual identity the race belongs to.
function factionForRace(raceId) {
  if (!raceId) return null;
  if (raceId === 'hobgoblin') return CampaignFactionId.HOBGOBLIN;
  if (raceId === 'skeleton') return CampaignFactionId.UNDEAD;
  if (raceId.includes('goblin')) return CampaignFactionId.GOBLIN;
  if (raceId === 'human') return CampaignFactionId.HUMAN;
  return null;
}

export const CampaignFaction = {
  ids: CampaignFactionId,

  // Resolve the faction for a campaign state. Precedence:
  //   1. state.faction (explicit override; no current code path sets
  //      this, but reserved for a future "play as faction X" feature)
  //   2. the champion's declared faction (see CHAMPION_FACTION)
  //   3. the majority race of the roster (covers a save with no champion
  //      system, or a champion whose def declares no faction)
  //   4. human (safest default — never breaks the view)
  forState(state) {
    if (!state) return CampaignFactionId.HUMAN;

    if (typeof state.faction === 'string'
        && CampaignFactionId[state.faction.toUpperCase()] === state.faction) {
      return state.faction;
    }

    const championDefId = state.champion && state.champion.defId;
    if (championDefId && CHAMPION_FACTION[championDefId]) {
      return CHAMPION_FACTION[championDefId];
    }

    return this.majorityRaceOfRoster(state.roster) || CampaignFactionId.HUMAN;
  },

  // Majority race of a roster. Undead win outright if they are at least
  // half the roster — a half-skeleton army reads as a skeleton army, not
  // a human one with a skeleton problem.
  majorityRaceOfRoster(roster) {
    if (!Array.isArray(roster) || roster.length === 0) return null;

    let undead = 0;
    const tally = new Map();

    for (const entry of roster) {
      if (!entry || !entry.typeId) continue;
      if (entry.isUndead) { undead++; continue; }
      const typeDef = UnitTypes[entry.typeId];
      if (!typeDef) continue;
      const faction = factionForRace(typeDef.race || 'human');
      if (!faction) continue;
      tally.set(faction, (tally.get(faction) || 0) + 1);
    }

    if (undead > 0 && undead * 2 >= roster.length) {
      return CampaignFactionId.UNDEAD;
    }

    let best = null;
    let bestN = 0;
    for (const [factionId, n] of tally) {
      if (n > bestN) { best = factionId; bestN = n; }
    }
    return best;
  }
};
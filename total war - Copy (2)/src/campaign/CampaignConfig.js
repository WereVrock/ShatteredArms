// Tunable campaign numbers. No logic here, only data.
//
// Unit sizes mirror the existing scenario defaults in PlayableScenarios.js:
//   infantry 3x5 = 15, archers 3x4 = 12, cavalry 3x5 = 15.
// The initial pool / pick counts and the AI growth schedule are the campaign
// shape; adjust here without touching flow code.

export const CampaignConfig = {
  initialPoolSize: 8,
  initialPickCount: 5,

  // AI unit count by 0-based battle index. Battles past the end of the
  // schedule grow linearly by aiCountGrowthPerBattle from the last
  // scheduled value. The schedule gives a handcrafted early-game ramp;
  // the tail is uniform growth.
  aiCountSchedule: [3, 5, 6, 8, 10],
  aiCountGrowthPerBattle: 1,

  // Chance that an offered pair of units is the shielded variant of its
  // family. Applied once per pair — both cards share the roll, so an offer
  // is either "both shielded" or "both unshielded," never a mix. Archers
  // ignore the result (no shield variant exists).
  shieldedOfferChance: 0.3,

  // Independent chance that any single offered unit is a skeleton-bodied
  // version of its type. Rolled per card, not per pair — so a pair can
  // offer one living and one undead unit. Skeletons are mechanically
  // identical to their living counterparts except for the isUndead flag,
  // which suppresses rout (see MoraleSystem) and applies certain weapon
  // matchup modifiers.
  skeletonOfferChance: 0.3,

  // Whole-formation skeleton chance for AI units. 0 disables skeletons
  // entirely on the AI side.
  aiUndeadChance: 0.25,

  // Default recruitment size per type id.
  defaultSizes: {
    spearman: 15,
    spearmanNoShield: 15,
    swordsman: 15,
    swordsmanNoShield: 15,
    archer: 12,
    horsemen: 15,
    horsemenNoShield: 15
  },

  // Battlefield layout. Player at negative Z facing south, AI at positive Z
  // facing north, matching the existing scenarios' facing convention.
  playerBaseZ: -16,
  aiBaseZ: 16,
  unitSpacing: 4.5,
  rankSpacing: 4.0,
  maxUnitsPerRank: 6,
  formationSpacing: 0.7
};
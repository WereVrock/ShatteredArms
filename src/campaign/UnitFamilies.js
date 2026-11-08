// ===== UnitFamilies.js =====
// Family classification for unit types, plus the offer-rolling logic used
// by the campaign's initial picker, between-battle rewards, and AI roster
// generator.
//
// The FAMILIES tables are still used elsewhere (Custom Battle palette
// grouping, family-of lookups), but the CAMPAIGN offer roller no longer
// uses them: campaign offers are drawn from a flat pool of every type id
// (human + goblin, shielded + unshielded) with NO pairing rules.
// Duplicates are allowed, shielded/unshielded variants are independent
// draws, and goblin types are eligible in the campaign.
//
// Campaign availability. A unit type can opt out of the campaign per side
// with two optional bools on its UnitTypes entry (absent = available):
//   campaignPlayerAvailable: false  -> never offered to / sold to the player
//   campaignAiAvailable: false      -> never fielded by campaign enemies
// The pool getters take an optional `side` ('player' | 'ai'). With no side
// they return the unfiltered list, which is what Custom Battle and
// multiplayer want. The offer rollers default to the 'player' side; the AI
// roster generator passes 'ai' explicitly.
//
// `isUndead` is a UNIT-level trait, not a type variant. Rolls therefore
// produce { typeId, isUndead } offers rather than bare type ids. The
// skeleton roll is per card. RaceConfig.supportsUndead decides whether a
// given type can carry the flag, so a goblin offer never comes out undead
// even if the caller asked for one.
//
// Pure data + pure functions, no state.

import { raceSupportsUndead } from '../config/RaceConfig.js';
import { UnitTypes } from '../config/UnitTypes.js';

const FAMILIES = {
  spear:    { shielded: 'spearman',   unshielded: 'spearmanNoShield' },
  sword:    { shielded: 'swordsman',  unshielded: 'swordsmanNoShield' },
  archer:   { shielded: 'archer',     unshielded: 'archer' },
  horsemen: { shielded: 'horsemen',   unshielded: 'horsemenNoShield' }
};

const TYPE_TO_FAMILY = {};
for (const family of Object.keys(FAMILIES)) {
  const entry = FAMILIES[family];
  TYPE_TO_FAMILY[entry.shielded] = family;
  TYPE_TO_FAMILY[entry.unshielded] = family;
}

// Goblin type ids. Kept as a separate list so the campaign roller, the AI
// roster generator, and the Custom Battle palette can all ask for "the
// goblin types" without duplicating the enumeration.
const GOBLIN_TYPE_IDS = [
  'goblinSwordsman',
  'goblinSwordsmanNoShield',
  'eliteGoblinSwordsman',
  // Slave sits with the swordsman family — it is a goblin swordsman
  // stripped to half HP, no shield, no attack-speed bonus, and the
  // WORTHLESS property instead of DIRTY_FIGHTING. Placed here rather
  // than with the archers so the pool reads in family order: sword
  // block, then spear block, then ranged.
  'goblinSlave',
  'goblinSpearman',
  'goblinSpearmanNoShield',
  'goblinArcher'
];

// Campaign sides and the UnitTypes flag that gates each one.
const SIDE_FLAG = {
  player: 'campaignPlayerAvailable',
  ai: 'campaignAiAvailable'
};

// True when the type may appear on `side`. No side (or an unknown side)
// means no filtering. A missing type def counts as available so a stale id
// is handled by the caller's own size/def checks rather than silently
// vanishing from the pool here.
function isAvailableForSide(typeId, side) {
  if (!side) return true;
  const flag = SIDE_FLAG[side];
  if (!flag) return true;
  const typeDef = UnitTypes[typeId];
  if (!typeDef) return true;
  return typeDef[flag] !== false;
}

function filterForSide(typeIds, side) {
  return typeIds.filter(id => isAvailableForSide(id, side));
}

// Resolves the isUndead flag against the type's race. A goblin (or any
// other race with supportsUndead === false) always comes back living.
function resolveUndead(typeId, wantUndead) {
  if (!wantUndead) return false;
  const typeDef = UnitTypes[typeId];
  return !!typeDef && raceSupportsUndead(typeDef);
}

export const UnitFamilies = {
  familyOf(typeId) {
    return TYPE_TO_FAMILY[typeId] || typeId;
  },

  // Human type ids. Optional `side` filters by campaign availability.
  allTypeIds(side = null) {
    return filterForSide(Object.keys(TYPE_TO_FAMILY), side);
  },

  allFamilyNames() {
    return Object.keys(FAMILIES);
  },

  // Goblin type ids. Optional `side` filters by campaign availability.
  goblinTypeIds(side = null) {
    return filterForSide(GOBLIN_TYPE_IDS, side);
  },

  isGoblinTypeId(typeId) {
    return GOBLIN_TYPE_IDS.includes(typeId);
  },

  // True when the type may appear in the campaign on `side`.
  isCampaignAvailable(typeId, side) {
    return isAvailableForSide(typeId, side);
  },

  // Flat pool used by the campaign's offer rollers and the AI roster
  // generator: every human family variant plus every goblin variant.
  // Optional `side` filters by campaign availability; with no side the
  // full pool comes back (Custom Battle relies on this).
  campaignPoolTypeIds(side = null) {
    return filterForSide(
      [...Object.keys(TYPE_TO_FAMILY), ...GOBLIN_TYPE_IDS],
      side
    );
  },

  // Palette type ids for the Custom Battle setup screen. Always the full,
  // unfiltered pool: campaign availability flags do not apply there.
  customBattlePaletteTypeIds() {
    return this.campaignPoolTypeIds();
  },

  // True when a and b are the same type, or shielded/unshielded variants
  // of the same base unit.
  sameFamily(a, b) {
    return this.familyOf(a) === this.familyOf(b);
  },

  // Type id for a family, resolved against the desired shield state.
  // Archers have no shield variant; the request is silently ignored for
  // them. Kept as a utility even though the campaign roller no longer
  // pairs cards by family.
  typeForFamily(familyName, wantShield) {
    const entry = FAMILIES[familyName];
    if (!entry) return null;
    return wantShield ? entry.shielded : entry.unshielded;
  },

  // Random unit offer from the campaign pool for `side` (default
  // 'player'). No pairing rules, no family exclusion, duplicates allowed.
  // The isUndead flag is resolved against the type's race (see
  // resolveUndead): a goblin type always comes back living.
  randomOffer({ skeletonChance = 0, side = 'player' } = {}) {
    const pool = this.campaignPoolTypeIds(side);
    const typeId = pool[Math.floor(Math.random() * pool.length)];
    return {
      typeId,
      isUndead: resolveUndead(typeId, Math.random() < skeletonChance)
    };
  },

  // Random goblin-only offer for `side` (default 'player'). Used by the
  // reward roller's guaranteed-goblin slot.
  randomGoblinOffer({ skeletonChance = 0, side = 'player' } = {}) {
    const pool = this.goblinTypeIds(side);
    const typeId = pool[Math.floor(Math.random() * pool.length)];
    return {
      typeId,
      isUndead: resolveUndead(typeId, Math.random() < skeletonChance)
    };
  }
};
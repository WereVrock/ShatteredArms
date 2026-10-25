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
  'goblinSpearman',
  'goblinSpearmanNoShield',
  'goblinArcher'
];

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

  allTypeIds() {
    return Object.keys(TYPE_TO_FAMILY);
  },

  allFamilyNames() {
    return Object.keys(FAMILIES);
  },

  goblinTypeIds() {
    return GOBLIN_TYPE_IDS.slice();
  },

  isGoblinTypeId(typeId) {
    return GOBLIN_TYPE_IDS.includes(typeId);
  },

  // Flat pool used by the campaign's offer rollers and the AI roster
  // generator: every human family variant plus every goblin variant.
  campaignPoolTypeIds() {
    return [...this.allTypeIds(), ...GOBLIN_TYPE_IDS];
  },

  // Palette type ids for the Custom Battle setup screen. Kept for API
  // compatibility with existing callers; the campaign now uses the same
  // pool, so this is a straight alias.
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

  // Random unit offer from the full campaign pool. No pairing rules, no
  // family exclusion, duplicates allowed. The isUndead flag is resolved
  // against the type's race (see resolveUndead): a goblin type always
  // comes back living.
  randomOffer({ skeletonChance = 0 } = {}) {
    const pool = this.campaignPoolTypeIds();
    const typeId = pool[Math.floor(Math.random() * pool.length)];
    return {
      typeId,
      isUndead: resolveUndead(typeId, Math.random() < skeletonChance)
    };
  },

  // Random goblin-only offer. Used by the reward roller's guaranteed-
  // goblin slot.
  randomGoblinOffer({ skeletonChance = 0 } = {}) {
    const pool = GOBLIN_TYPE_IDS;
    const typeId = pool[Math.floor(Math.random() * pool.length)];
    return {
      typeId,
      isUndead: resolveUndead(typeId, Math.random() < skeletonChance)
    };
  }
};
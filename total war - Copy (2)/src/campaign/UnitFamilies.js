// Family classification for unit types, plus the offer-rolling logic used by
// both the initial picker and between-battle rewards. Each family has at
// most one shielded and one unshielded variant. Archers have no shielded
// variant, so both lookups resolve to 'archer' — the shield roll is a silent
// no-op for them.
//
// `isUndead` is a UNIT-level trait, not a type variant: a "skeleton
// spearman" is a spearman with isUndead=true, not a distinct type id. Rolls
// therefore produce { typeId, isUndead } offers rather than bare type ids.
// The skeleton roll is per card (independent), unlike the shield roll which
// is per pair. Pure data + pure functions, no state.

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

  // True when a and b are the same type, or shielded/unshielded variants of
  // the same base unit.
  sameFamily(a, b) {
    return this.familyOf(a) === this.familyOf(b);
  },

  // Type id for a family, resolved against the desired shield state.
  // Archers have no shield variant; the request is silently ignored for them.
  typeForFamily(familyName, wantShield) {
    const entry = FAMILIES[familyName];
    if (!entry) return null;
    return wantShield ? entry.shielded : entry.unshielded;
  },

  // Two unit offers from two different families. Both cards share ONE shield
  // roll (a pair is either both shielded or both unshielded, never a mix).
  // Skeleton is rolled independently per card. Returns:
  //   [{ typeId, isUndead }, { typeId, isUndead }]
  pickTwoOffers({ shieldedChance, skeletonChance }) {
    const wantShield = Math.random() < shieldedChance;
    const families = this.allFamilyNames();

    for (let i = families.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [families[i], families[j]] = [families[j], families[i]];
    }

    return [
      {
        typeId: this.typeForFamily(families[0], wantShield),
        isUndead: Math.random() < skeletonChance
      },
      {
        typeId: this.typeForFamily(families[1], wantShield),
        isUndead: Math.random() < skeletonChance
      }
    ];
  }
};
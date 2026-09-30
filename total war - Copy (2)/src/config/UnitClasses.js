// AI-facing classification of unit types. The AI reasons about unit CLASS
// (spearmen, swordsmen, ranged, cavalry) rather than concrete unit type id,
// so adding a new unit type — horse archer, cataphract, elk rider — only
// requires declaring its class list in UnitTypes.js. Every AI behavior that
// filters by class picks it up automatically; no behavior branches on
// concrete type ids.
//
// A unit type may belong to more than one class. A horse archer would
// declare ['cavalry', 'ranged'] and each AI behavior reads whichever class
// lens is relevant for the decision it is making (a cavalry-flank behavior
// sees it as cavalry, a focus-fire behavior sees it as ranged). The list is
// unordered — consumers must not assume entry 0 is "primary".
//
// UnitTypes.js is the sole source of truth for which classes a concrete
// type belongs to. This module only holds the constants and the pure
// helper predicates. No state, no side effects.

export const UnitClass = {
  SPEARMEN: 'spearmen',
  SWORDSMEN: 'swordsmen',
  RANGED: 'ranged',
  CAVALRY: 'cavalry'
};

export const ALL_UNIT_CLASSES = [
  UnitClass.SPEARMEN,
  UnitClass.SWORDSMEN,
  UnitClass.RANGED,
  UnitClass.CAVALRY
];

// True when the unit type belongs to `className`. Defensive: a missing
// unitTypeDef, or a type that predates the class system, returns false
// rather than throwing — callers should be able to probe a possibly-empty
// definition without a null check of their own.
export function unitHasClass(unitTypeDef, className) {
  if (!unitTypeDef) return false;
  const classes = unitTypeDef.unitClasses;
  if (!classes) return false;
  return classes.includes(className);
}

export function isCavalry(unitTypeDef) {
  return unitHasClass(unitTypeDef, UnitClass.CAVALRY);
}

export function isRanged(unitTypeDef) {
  return unitHasClass(unitTypeDef, UnitClass.RANGED);
}

export function isSpearmen(unitTypeDef) {
  return unitHasClass(unitTypeDef, UnitClass.SPEARMEN);
}

export function isSwordsmen(unitTypeDef) {
  return unitHasClass(unitTypeDef, UnitClass.SWORDSMEN);
}
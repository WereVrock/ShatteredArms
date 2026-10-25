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

import { CombatConfig } from './CombatConfig.js';

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

// True when a unit type rides a mount for movement and rendering, whether
// or not it carries the CAVALRY class.
//
// isCavalry is a TACTICAL classification: the AI's flanker behaviour,
// the charge readiness checks, and the spear-vs-cavalry damage table all
// key on it. isMounted is a PHYSICAL fact: this soldier is on a beast's
// back, so the composer should build a mount and the view should drive
// a trot cycle.
//
// A mounted-but-not-cavalry type — the Goblin Warlord's beast-riders —
// sets `mounted: true` without adding the CAVALRY class. The result is a
// unit that visually rides a beast, moves with a trot animation, and
// still behaves as ordinary infantry in every sim system: no flanker
// roles, no charge interaction, no anti-cavalry spear bonus against it.
//
// Renderers and the model composer should use isMounted to decide whether
// to build a mount. Every other consumer keeps using isCavalry.
//
// Defensive: a missing unitTypeDef returns false, matching the sibling
// predicates in this module.
export function isMounted(unitTypeDef) {
  if (!unitTypeDef) return false;
  return isCavalry(unitTypeDef) || unitTypeDef.mounted === true;
}

// Extended cavalry predicate, used ONLY by the AI's cavalry-vs-cavalry
// checks. A unit type counts as cavalry for AI purposes when it is
// actually classed CAVALRY, OR when it carries the per-type flag
// `countsAsCavalry`.
//
// The flag exists because some units are physically dangerous to slow
// formations — a mounted champion rides a beast and closes on archers
// like a horseman — but are deliberately NOT classed CAVALRY because
// the sim's charge path, brace counters, and spear-vs-cavalry damage
// table would then treat them as true cavalry, which they are not.
//
// This predicate is the AI's read of "should I treat this unit as a
// cavalry threat for cover and support purposes." It deliberately does
// NOT affect targeting, bracing, or damage — those keep using
// isCavalry and are unchanged.
export function isCavalryForAI(unitTypeDef) {
  if (!unitTypeDef) return false;
  if (isCavalry(unitTypeDef)) return true;
  return unitTypeDef.countsAsCavalry === true;
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

// Effective ranged range for a unit type. A type may declare its own
// `rangedRange` (goblin archers field shorter-ranged volleys than human
// archers); when the field is absent, the global CombatConfig.rangedRange
// is used, so every existing type keeps its current behaviour unchanged.
//
// This is the single resolver for "how far can this unit shoot." Every
// consumer — TargetingSystem's ranged search radius, RangedCombatSystem's
// fire-range gate, and the render-side range circle — reads through here
// so a future ranged unit with an unusual range is a unit-type data change,
// not a set of code changes scattered across the sim and render layers.
//
// Defensive on a missing unitTypeDef: returns the global range rather than
// throwing, matching the contract used by unitHasClass and its siblings.
export function getRangedRange(unitTypeDef) {
  if (!unitTypeDef) return CombatConfig.rangedRange;
  return unitTypeDef.rangedRange ?? CombatConfig.rangedRange;
}
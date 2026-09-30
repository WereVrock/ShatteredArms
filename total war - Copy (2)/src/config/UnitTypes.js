// ===== UnitTypes.js =====
// Data-driven unit definitions. New units/variants are new entries here.
//
// unitClasses tags each type with the AI-facing class(es) it belongs to —
// see UnitClasses.js. The AI reasons about classes ("send the cavalry",
// "screen the ranged units") rather than concrete type ids, so a new
// cavalry-class unit (horse archer, cataphract) slots into existing AI
// behaviors without AI changes. A type may belong to more than one class —
// a horse archer would be ['cavalry', 'ranged'].
//
// isUndead marks a unit as skeleton-bodied at the UNIT level (whole formation),
// not per-soldier — set by FormationFactory, not randomly per soldier.
//
// Shieldless variants share every stat with their base unit except
// hasShield/shieldSide and helmetType, which withoutShield() overrides. Because
// all damage / behaviour tables are keyed on weapon type and class
// membership, the variants automatically inherit the correct matchup
// behaviour — a shieldless spearman still gets the spear-vs-cavalry bonus,
// still braces, still punishes a frontal sword attack.
//
// helmetType is a data field, consumed by HelmetFactory (see
// src/render/HelmetFactory.js) — each human unit type gets a distinct
// silhouette. Skeletons ignore helmetType entirely; createSkeletonBody builds
// a skull head directly.

import { UnitClass } from './UnitClasses.js';

// breakoffRange: world-units distance from the block's live march target
// (destination point for a move order, enemy unit center for an attack
// order) at which a soldier is released from formation-following and
// switches to individually walking/chasing its own personal target. Higher
// discipline holds the block together longer (short leash — stays formed
// until very close); lower discipline peels off earlier (long leash). See
// Unit._advanceMarch / Unit.update.
const spearman = {
  id: 'spearman',
  displayName: 'Spearman',
  baseHp: 40,
  baseMoveSpeed: 1.2,
  mass: 1.0,
  weaponType: 'spear',
  raisesPolearmOnTurn: true,
  hasShield: true,
  shieldSide: 'left',
  spriteColor: '#c9a24b',
  discipline: 'normal',
  breakoffRange: 6.0,
  unitClasses: [UnitClass.SPEARMEN],
  helmetType: 'conicalHelm'
};

const swordsman = {
  id: 'swordsman',
  displayName: 'Swordsman',
  baseHp: 42,
  baseMoveSpeed: 1.25,
  mass: 1.0,
  weaponType: 'sword',
  hasShield: true,
  shieldSide: 'left',
  spriteColor: '#a8624b',
  discipline: 'normal',
  breakoffRange: 7.0,
  attackSpeedMultiplier: 1.2,
  unitClasses: [UnitClass.SWORDSMEN],
  helmetType: 'nasalHelm'
};

const archer = {
  id: 'archer',
  displayName: 'Archer',
  baseHp: 28,
  baseMoveSpeed: 1.1,
  mass: 0.9,
  weaponType: 'bow',
  hasShield: false,
  shieldSide: null,
  spriteColor: '#5a8a4b',
  discipline: 'normal',
  breakoffRange: 10.0,
  unitClasses: [UnitClass.RANGED],
  helmetType: 'hood',
  // Scatter radius (world units) around the target unit's center for
  // each arrow this unit fires. Arrows land at a random point inside
  // this disc; wider = more misses and more stray friendly fire, tighter
  // = more concentrated volleys. Consumed by RangedCombatSystem when
  // picking each shot's target point, and by ProjectileSystem's collision
  // model for damage resolution. See CombatConfig.arrow.
  rangedAccuracy: 1.8,
  // Wide, shallow formation: 2 rows, however many columns that implies
  // for the deployed count. Archers want frontage to fire over, not
  // depth — a 3-deep block just means the back rank has no line of
  // sight. Consumed by FormationFactory.createUnitWithCount; the
  // grid-factory path (PlayableScenarios) passes rows/cols explicitly.
  preferredRows: 2
};

const horsemen = {
  id: 'horsemen',
  displayName: 'Horsemen',
  baseHp: 55,
  baseMoveSpeed: 2.6,
  mass: 4.5,
  weaponType: 'lance',
  raisesPolearmOnTurn: true,
  hasShield: true,
  shieldSide: 'left',
  spriteColor: '#3a3a6e',
  discipline: 'high',
  breakoffRange: 3.0,
  unitClasses: [UnitClass.CAVALRY],
  collisionRadius: 0.5,
  formationSpacing: 1.2,
  helmetType: 'plumedHelm'
};

function withoutShield(base, id, displayName, helmetType) {
  return {
    ...base,
    id,
    displayName,
    hasShield: false,
    shieldSide: null,
    helmetType
  };
}

export const UnitTypes = {
  spearman,
  spearmanNoShield: withoutShield(spearman, 'spearmanNoShield', 'Spearman (No Shield)', 'roundCap'),

  swordsman,
  swordsmanNoShield: withoutShield(swordsman, 'swordsmanNoShield', 'Swordsman (No Shield)', 'bandedHelm'),

  archer,

  horsemen,
  horsemenNoShield: withoutShield(horsemen, 'horsemenNoShield', 'Horsemen (No Shield)', 'crestedHelm')
};
// ===== UnitTypes.js =====
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
// race tags each type with the physical body archetype it belongs to —
// see RaceConfig.js. Race drives cross-cutting physical modifiers
// (outgoing damage, move speed, incoming damage by weapon, unit size).
// Human is the default when the field is absent, but every entry below
// declares it explicitly so the pattern is obvious for the next race.
//
// isUndead marks a unit as skeleton-bodied at the UNIT level (whole formation),
// not per-soldier — set by FormationFactory, not randomly per soldier.
//
// bodyVariant is an optional override for the visual body model. When
// absent, bodyVariant is derived from race (skeleton for undead, goblin
// for race 'goblin', blob otherwise). Set it when a unit type should
// render with a body model that does not match its race — e.g. a
// hobgoblin, which shares the goblin RaceConfig entry's physical
// modifiers (race: 'goblin') but renders with the armored hobgoblin
// body model (bodyVariant: 'hobgoblin'). Race drives sim mechanics;
// bodyVariant drives the render-only mesh selection. See Soldier.js
// for the resolution order.
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
// a skull head directly. There are no goblin-specific meshes yet, so the
// goblin types below reuse human helmet silhouettes.

import { UnitClass } from './UnitClasses.js';
import { Property } from './Properties.js';

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
  race: 'human',
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
  helmetType: 'conicalHelm',
  // Player-facing tactical note. Rendered verbatim in the UnitInfoPanel's
  // Notes section. Race-agnostic by design — a goblin spearman and a
  // skeleton spearman share the same tactical summary, because the
  // mechanics it describes are properties of the weapon and formation,
  // not the body. Race-specific behaviour lives in the Traits section
  // (dirty fighting, expendable, undead) which is derived from
  // RaceConfig and Properties, not from this field.
  description: 'Braces against charging cavalry to negate the charge and strike back hard. A directional fighter — poorly suited to melee that surrounds him on multiple sides.'
};

const swordsman = {
  id: 'swordsman',
  displayName: 'Swordsman',
  race: 'human',
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
  helmetType: 'nasalHelm',
  // Player-facing tactical note. See spearman for the race-agnostic
  // contract — a goblin swordsman reads the same summary, with the
  // race-specific behaviour supplied by the Traits section instead.
  description: 'Fast attacks and devastating against skeletons — a flanking strike kills outright. A frontal attack on a braced spear wall wastes the speed advantage and deals reduced damage.'
};

const archer = {
  id: 'archer',
  displayName: 'Archer',
  race: 'human',
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
  preferredRows: 2,
  // Player-facing tactical note. See spearman for the race-agnostic
  // contract.
  description: 'Volleys from long range, effective against unshielded targets and skeletons. Helpless in melee and vulnerable to cavalry if left unscreened.'
};

const horsemen = {
  id: 'horsemen',
  displayName: 'Horsemen',
  race: 'human',
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
  helmetType: 'plumedHelm',
  // Player-facing tactical note. See spearman for the race-agnostic
  // contract.
  description: 'Heavy cavalry, devastating on the charge against unbraced infantry. A braced spear wall will kill them instead. Best used to flank a pinned line, hunt routers, or run down exposed archers.'
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

// Goblin counterpart helper. Produces a copy of `base` tagged with the
// goblin race. Every race-specific physical stat (outgoing damage, move
// speed, incoming damage, unit size) lives in RaceConfig.js and is applied
// by the sim at the point of use — it is NOT redeclared here. Adding a
// goblin counterpart to any existing type is one call to this helper.
//
// The goblin-green spriteColor is a placeholder for a future renderer
// change that reads spriteColor; the live soldier model currently uses
// the team colour for the body, so it has no visible effect yet.
// Goblins are lighter than the human archetype they mirror, and lighter
// than a skeleton body of the same type. Mass scales linearly with bulk,
// so this single multiplier feeds knockback distance, melee shove, and
// charge-resolution in CombatResolutionSystem without any per-unit
// override. Applied here rather than in RaceConfig because mass is not a
// race-layer field in this codebase — RaceConfig carries damage, speed,
// HP, morale, fatigue and unit size, but not mass. Skeleton mass is set
// the same way, by CombatConfig.skeleton.massMult (0.6), so goblins at
// 0.5 deliberately come in below skeletons: a goblin gets thrown further
// by the same cavalry impact than a skeleton would. Callers can still
// override mass explicitly through the `overrides` arg — that spread
// runs last and wins.
const GOBLIN_MASS_MULTIPLIER = 0.5;

function goblinOf(base, id, displayName, overrides = {}) {
  return {
    ...base,
    id,
    displayName,
    race: 'goblin',
    mass: (base.mass ?? 1.0) * GOBLIN_MASS_MULTIPLIER,
    spriteColor: '#6a8a3a',
    ...overrides
  };
}

// Goblin counterparts are declared as standalone consts, same as the human
// bases above, so a derived variant can reference its base by variable name.
// (An object-literal property is NOT a variable in scope — referencing a
// sibling property key inside the same literal throws ReferenceError.)
//
// displayName is RACE-AGNOSTIC and matches the human base exactly. Race is
// carried by the `race` field ('goblin') and any consumer that wants to
// show the race in a label prepends it — a "Swordsman" with race 'goblin'
// reads as "Goblin Swordsman" in the UI, and the same entry at race
// 'human' reads as "Human Swordsman". Hard-coding "Goblin" into displayName
// would double up the prefix in any display layer that also prepends race.
const goblinSwordsman = goblinOf(swordsman, 'goblinSwordsman', 'Swordsman', {
  discipline: 'low'
});

// Derived from goblinSwordsman, not from swordsmanNoShield, to mirror the
// human pattern (swordsmanNoShield is derived from swordsman). Race and
// all race-side modifiers propagate from the shielded goblin entry, so a
// future stat change to goblinSwordsman flows to both variants.
const goblinSwordsmanNoShield = withoutShield(
  goblinSwordsman,
  'goblinSwordsmanNoShield',
  'Swordsman (No Shield)',
  'bandedHelm'
);

// Goblin spearman. Same weapon mechanics as the human spearman — the race
// layer supplies the fragility (hpMultiplier 0.7), swarm size
// (unitSizeMultiplier 2.0), morale ceiling (0.7), and fatigue drain
// (1.5x). A goblin spear unit therefore braces against cavalry, punishes
// frontal sword attacks, and takes the spear-vs-cavalry bonus through the
// same tables the human one does. No new combat code; the type is pure
// data, exactly as the design intends.
//
// No-shield variant mirrors the goblin sword pattern: derived from the
// shielded entry so race and all race-side modifiers propagate together.
const goblinSpearman = goblinOf(spearman, 'goblinSpearman', 'Spearman', {
  discipline: 'low'
});

const goblinSpearmanNoShield = withoutShield(
  goblinSpearman,
  'goblinSpearmanNoShield',
  'Spearman (No Shield)',
  'roundCap'
);

// Goblin archer. Short-ranged and loose by design: the race fields twice
// the bodies per unit, so each arrow is cheaper and lands wider, and the
// shorter range forces the swarm to close before it can shoot — the same
// "cheap bodies, real weaknesses" identity as the HP and morale cuts.
//
//   rangedAccuracy — scatter radius in world units around the target
//                    unit's centre. Higher = wider spread. Human archer
//                    is 1.8; 3.6 doubles the miss envelope and roughly
//                    doubles stray friendly-fire footprint.
//   rangedRange    — per-unit override of CombatConfig.rangedRange.
//                    Human archer's effective range is 21; 12 keeps the
//                    goblin archer well inside counter-battery distance
//                    and inside most enemy ranged range.
const goblinArcher = goblinOf(archer, 'goblinArcher', 'Archer', {
  discipline: 'low',
  rangedAccuracy: 3.6,
  rangedRange: 12.0,
  // DIRTY_FIGHTING is a melee-arc property — its numeric tuning
  // (RaceConfig.goblin.dirtyFighting) is applied only inside
  // CombatResolutionSystem._resolveAttack, after the flank/frontal
  // geometry split. Arrows resolve in ProjectileSystem, which never
  // reads the property, so an archer carrying the flag would be
  // advertised as having a melee-flank bonus it cannot use.
  //
  // Declared as a per-type exclusion rather than a change to the
  // goblin race entry, so goblin swordsmen and spearmen keep the
  // property and their existing flank damage. Honored centrally by
  // raceHasProperty (see RaceConfig.js), so the UI trait list and any
  // future consumer pick this up automatically.
  excludesProperties: [Property.DIRTY_FIGHTING]
});

// Hobgoblin swordsman. A goblin body pushed toward the human template:
// full human mass, human-equivalent HP (60 × race hpMultiplier 0.7 = 42),
// high discipline, and none of the goblin race's soft weaknesses —
// no EXPENDABLE, no FAST_TIRING, no spear resistance, normal fatigue drain.
// Races as 'goblin' so the goblin RaceConfig modifiers (HP, morale,
// fatigue) apply, but renders with the hobgoblin body model via the
// bodyVariant override — see the file header for the race/bodyVariant
// split. Still fights dirty (DIRTY_FIGHTING is kept).
//
// Used by the Goblin Warlord champion's bodyguard unit.
const hobgoblinSwordsman = {
  ...swordsman,
  id: 'hobgoblinSwordsman',
  displayName: 'Hobgoblin Swordsman',
  race: 'goblin',
  bodyVariant: 'hobgoblin',

  // --- mount movement ---
  // The beast is faster than a foot soldier and slower than a horse.
  // Effective values after the shield penalty (×0.95): 2.185 sim units
  // vs. a shielded swordsman's 1.1875 and a horseman's 2.47. Fast enough
  // to close, not fast enough to outrun pursuit like real cavalry.
  //
  // Mass 3.0 is the beast's bulk — well above a foot soldier's 1.0, well
  // below a horseman's 4.5. Since the unit is NOT classed CAVALRY, the
  // charge path in CombatResolutionSystem never fires for it (that path
  // requires isCavalry), so the mass affects only the non-charge shove
  // and morale outnumbered math. It does NOT grant charge knockback.
  baseMoveSpeed: 2.3,
  mass: 3.0,

  baseHp: 60,
  discipline: 'high',
  spriteColor: '#6a8a3a',

  // --- mount ----------------------------------------------------------
  // The hobgoblin rides a BEAST but is NOT a CAVALRY-class unit. The AI
  // therefore treats it as ordinary shielded swordsmen — no flanker
  // behavior, no charge interaction, no anti-cavalry spear bonus against
  // it. `mounted: true` is the render-and-movement flag that tells the
  // composer to build a mount and the view to drive a trot cycle;
  // `mountType: 'beast'` selects the placeholder beast builder (see
  // BeastMountBuilder.js).
  //
  // The champion's retinue (goblinWarlordRetinue) spreads this entry, so
  // the champion rides a beast on the same mount path.
  //
  // Sim-side changes (mass 3.0, baseMoveSpeed 2.3, spear-counter tuning)
  // are NOT wired here. This is only the mount visual; the balance
  // changes are a separate pass.
  mounted: true,
  mountType: 'beast',

  // Formation spacing widened from the infantry default (0.7) to match
  // the horse's, since a beast's body is wider than a foot soldier's
  // footprint. Without this the mounts visibly interpenetrate in the
  // retinue's two-row formation.
  formationSpacing: 1.2,

  // Override the goblin race's spear resistance. Hobgoblins take full
  // spear damage. See CombatResolutionSystem._resolveAttack — the
  // per-type table (when present, even as {}) replaces the race table.
  incomingDamageMultipliers: {},
  // Override the goblin race's 1.5× fatigue drain. Hobgoblins tire at the
  // normal rate.
  fatigueDrainMultiplier: 1.0,
  // Exclude the goblin race's soft properties. Honoured by raceHasProperty.
  excludesProperties: [Property.EXPENDABLE, Property.FAST_TIRING],
  // Hobgoblins in the retinue share the swordsman's helmet silhouette so
  // they read as the same discipline tier at a glance.
  helmetType: 'nasalHelm',
};

// The Goblin Warlord's personal unit. Mechanically identical to a
// hobgoblin swordsman — a distinct type only so the campaign battle
// builder can unambiguously identify the unit it must post-process into a
// champion unit (see CampaignBattleBuilder.buildChampionUnit).
//
// preferredRows: 2 puts the seven-soldier start into a compact 4-wide
// front rank and 3-wide back rank, so the champion reads as a surrounded
// commander rather than a figure at the end of a thin file. A one-row
// line looked right at four soldiers; at seven it stretches the retinue
// into an awkward width and leaves the champion exposed at one edge.
const goblinWarlordRetinue = {
  ...hobgoblinSwordsman,
  id: 'goblinWarlordRetinue',
  displayName: 'Hobgoblin Retinue',
  preferredRows: 2,
  // Champion-specific body model. The campaign battle builder flags
  // soldiers[0] as isChampion (see CampaignBattleBuilder.buildChampionUnit);
  // Soldier.setChampion re-resolves that soldier's bodyVariant to this
  // value, so the champion renders as the Goblin Warlord while the rest
  // of the retinue keeps the hobgoblin body. Types without this field
  // render their champion with the same body as the rank and file.
  championBodyVariant: 'goblinWarlord',
  // AI-facing tag: this unit rides a beast and closes on slow
  // formations the way real cavalry does. It is not classed CAVALRY —
  // the sim's charge path, brace counters, and spear-vs-cavalry
  // damage table must NOT apply to it — but the AI's cavalry-vs-
  // cavalry cover checks should count it, so archers treat the
  // Warlord as a threat and the team's own cavalry treat it as a
  // viable intercept. Read only via isCavalryForAI (see UnitClasses).
  countsAsCavalry: true,
};

export const UnitTypes = {
  spearman,
  spearmanNoShield: withoutShield(spearman, 'spearmanNoShield', 'Spearman (No Shield)', 'roundCap'),

  swordsman,
  swordsmanNoShield: withoutShield(swordsman, 'swordsmanNoShield', 'Swordsman (No Shield)', 'bandedHelm'),
  goblinSwordsman,
  goblinSwordsmanNoShield,

  goblinSpearman,
  goblinSpearmanNoShield,

  hobgoblinSwordsman,
  goblinWarlordRetinue,

  archer,
  goblinArcher,

  horsemen,
  horsemenNoShield: withoutShield(horsemen, 'horsemenNoShield', 'Horsemen (No Shield)', 'crestedHelm')
};
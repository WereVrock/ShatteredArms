// ===== RaceConfig.js =====
// Race-level physical modifiers. A race is orthogonal to a UnitClass:
// UnitClass classifies a type's TACTICAL ROLE (spear line, skirmisher,
// cavalry) for the AI; race classifies its PHYSICAL BODY (goblin, human)
// and drives cross-cutting numeric modifiers that apply to every weapon
// and every unit archetype of that race.
//
// Why a separate module rather than per-type overrides:
//   Adding a goblin counterpart to an existing type is a one-line call
//   to the goblinOf() helper in UnitTypes.js. If race modifiers lived
//   per-type, every goblin unit added later would re-declare the same
//   "0.6 damage, 0.8 speed, 2x unit size" numbers, and balancing the
//   race would mean editing every entry. Here, balance lives in one
//   place and adding a new goblin type changes nothing in this file.
//
// What a race does NOT do:
//   - It does not change the WeaponMatchup table. Weapon damage is a
//     property of the WEAPON; a race scales it multiplicatively. This
//     keeps the matchup table authoritative for base numbers and lets
//     race balance live in one place.
//   - It does not change unitClasses. A goblin swordsman is still a
//     swordsman class for AI purposes; the AI never reads race.
//   - It does not override per-type stats. A goblin archer and a goblin
//     spearman share the race's damage multiplier but keep their own
//     baseHp, weapon, etc. — race is a cross-cutting layer, not a
//     replacement for per-type data.
//
// Fields:
//   id                        — canonical id, matches UnitType.race
//   displayName               — UI / debug
//   damageMultiplier          — outgoing damage multiplier, applied to
//                               base weapon damage in melee
//                               (CombatResolutionSystem._resolveAttack)
//                               and (via the same pattern, threaded
//                               through Projectile) in ranged resolution.
//                               1.0 = no change.
//   moveSpeedMultiplier       — multiplies Soldier.effectiveMoveSpeed,
//                               applied AFTER equipment penalties so it
//                               stacks cleanly (a shielded goblin
//                               spearman carries all three modifiers).
//   unitSizeMultiplier        — multiplies the soldier count of a unit
//                               built from a scenario's rows/cols
//                               template. Read by
//                               FormationFactory.createGridUnit. NOT
//                               applied to createUnitWithCount, where
//                               the scenario passes an explicit
//                               surviving soldier count.
//   incomingDamageMultipliers — { weaponType: multiplier } applied when a
//                               soldier of this race is the DEFENDER.
//                               Keys are the attacker's weaponType.
//                               Missing keys default to 1.0 (no change).
//   defaultHelmetType         — reserved for a future race-level helmet
//                               default; not consumed today.
import { Property } from './Properties.js';

export const Races = {
  human: {
    id: 'human',
    displayName: 'Human',
    damageMultiplier: 1.0,
    moveSpeedMultiplier: 1.0,
    unitSizeMultiplier: 1.0,
    // HP applied to every unit of this race, multiplying unitTypeDef.baseHp
    // in the Soldier constructor. 1.0 = no change; goblins go below 1.0.
    hpMultiplier: 1.0,
    // Morale ceiling, multiplying MoraleConfig.maxMorale. The Soldier
    // constructor sets maxMorale and the starting morale from this;
    // MoraleSystem is responsible for respecting the per-soldier ceiling
    // at regen time — see the note on that field in MoraleSystem.
    maxMoraleMultiplier: 1.0,
    // Multiplies fatigue DRAIN per action (attack, block-attempt, charge).
    // Does not affect regen. Above 1.0 = the race tires faster.
    fatigueDrainMultiplier: 1.0,
    incomingDamageMultipliers: {},

    // Skeleton-bodied variants of this race's units exist (see
    // SkeletonBodyBuilder). Goblins set this false — see that entry.
    supportsUndead: true,

    // Qualitative trait flags. See Properties.js. Human units carry none —
    // the empty list is declared explicitly so the field exists on every
    // race record and callers can read it without a null check.
    properties: []
  },

  goblin: {
    id: 'goblin',
    displayName: 'Goblin',

    // No skeleton-bodied goblin variant exists — GoblinBodyBuilder is the
    // only goblin body, and a "skeleton goblin" would need its own
    // bone-mesh with goblin proportions. Until that exists, the race is
    // declared undead-incapable: Soldier coerces isUndead to false, and
    // CustomBattleSetup skips the skeleton toggle for goblin entries. See
    // raceSupportsUndead at the bottom of this file.
    supportsUndead: false,

    // Lower damage per soldier. A goblin unit has twice as many bodies
    // (unitSizeMultiplier 2.0), so per-UNIT output is 2 * 0.6 = 1.2x a
    // human unit — a swarm that is dangerous collectively while each
    // individual goblin hits softer. Tune down to 0.5 for an exactly even
    // per-unit damage trade; tune up to make the swarm more threatening.
    damageMultiplier: 0.6,

    // No move-speed penalty. The original goblin design slowed the race
    // on the theory that a swarm should not also be fast; in playtest
    // that stacked with the shield and spear penalties and left goblins
    // unable to reach a fight before it was decided. Slender and quick
    // reads better than small and slow. Stacks on top of equipment
    // penalties the unit type already carries, same as before.
    moveSpeedMultiplier: 1.0,

    // Fragile bodies: 30% less HP than the same unit type at human
    // proportions. Combined with 2x unit size, a goblin unit is a mass
    // of cheap bodies — each dies quickly, the swarm endures. Tune down
    // toward 0.6 for a glassier swarm; tune up toward 0.9 for one that
    // survives a charge.
    hpMultiplier: 0.7,

    // Lower morale ceiling: 70% of the standard maximum. A goblin soldier
    // starts at this value, not 100, and routs earlier under pressure.
    // Tune down toward 0.5 for a race that breaks on first contact;
    // tune up toward 0.9 for one that stands about as long as a human.
    maxMoraleMultiplier: 0.7,

    // Tires faster: 1.5x fatigue drain per action. Swings and blocks
    // cost half again as much of the fatigue bar as a human's do, so a
    // prolonged melee degrades goblins faster — the same "cheap bodies"
    // identity as the HP cut, expressed as time-to-exhaustion rather
    // than time-to-death. Regen is unchanged.
    fatigueDrainMultiplier: 1.5,

    // Twice the soldiers per unit. Read by FormationFactory.createGridUnit
    // — see that method for how rows/cols are expanded.
    unitSizeMultiplier: 2.0,

    // 10% less damage from spears. Other weapon types default to 1.0 —
    // the incoming-damage table is a spot modifier, not a full armour
    // profile. A goblin cavalry added later will still take the cavalry
    // category modifier (DefenderCategoryDamageModifiers.cavalry) on top
    // of this, because race and category are separate layers.
    incomingDamageMultipliers: {
      spear: 0.9
    },

    // Qualitative trait flags. See Properties.js for the concept and the
    // list of consumers. A goblin is a dirty, expendable fighter: it
    // does its damage from the flank and the rear, and its rout does not
    // spread panic through the rest of the army.
    properties: [
      Property.DIRTY_FIGHTING,
      Property.EXPENDABLE,
      Property.FAST_TIRING
    ],

    // DIRTY_FIGHTING numeric tuning. Read by CombatResolutionSystem
    // immediately after the standard flank multiplier is applied, so a
    // goblin's flank strike stacks this bonus on top of the side/rear
    // multiplier, and a goblin's frontal strike stacks this penalty on
    // top of its base damage.
    //
    // Deliberately gated on the property: the numbers only take effect if
    // the race declares Property.DIRTY_FIGHTING above.
    dirtyFighting: {
      // Bonus when the hit lands in the side or rear arc. Multiplies on
      // top of CombatConfig.flank.sideDamageMult (1.25) and
      // rearDamageMult (1.5).
      flankDamageMult: 1.5,
      // Penalty when the hit lands in the frontal arc — the price of the
      // flank bonus, and the mechanical reason a goblin cannot win a
      // straight push against a formed line.
      frontalDamageMult: 0.75
    },

    // FAST_TIRING numeric tuning. Read by UnitPower._staminaDurabilityMultiplier
    // as a flat multiplier on the final power total. Deliberately gated
    // on the property: the value only takes effect if the race declares
    // Property.FAST_TIRING above, matching the DIRTY_FIGHTING contract.
    //
    // This does NOT change the sim. The sim already drains a goblin at
    // fatigueDrainMultiplier (1.5) per action, walking tick, and volley;
    // that is the real effect. This number is the SCORING-SIDE estimate
    // of that effect's cumulative cost over a battle — the answer to
    // "given that a goblin unit will be measurably more tired than an
    // equivalent human unit by mid-battle, how much is its sustained
    // combat value actually reduced?"
    //
    // 0.92 = an 8% reduction on the final power score. This makes the
    // AI and the preview cards treat a goblin unit as roughly 92% of
    // what its raw stats suggest — a modest, defensible correction.
    // Raise toward 1.0 for a subtler penalty (0.97 reads as barely
    // there); lower toward 0.85 for a strong signal that goblins are a
    // short-fight race. Tune here, not in UnitPower — the constant in
    // that file is only a fallback.
    fastTiring: {
      powerMultiplier: 0.92
    }
  }
};

export const DEFAULT_RACE = 'human';

// Resolve a race record by id. Missing / unknown ids fall back to the
// default race — the same defensive convention UnitClasses.js uses for a
// missing unitTypeDef. Every code path that reads a race should go through
// this (or raceOf) rather than indexing Races directly, so a new unit
// type that forgets to declare a race still works.
export function getRace(raceId) {
  if (!raceId) return Races[DEFAULT_RACE];
  return Races[raceId] || Races[DEFAULT_RACE];
}

// Resolve the race record for a UnitType. Defensive: a missing type or a
// type with no `race` field is treated as the default race.
export function raceOf(unitTypeDef) {
  if (!unitTypeDef) return Races[DEFAULT_RACE];
  return getRace(unitTypeDef.race);
}

// True when a race can field skeleton-bodied units. Races that opt out
// (currently only goblin) still appear in the campaign and Custom Battle,
// but never as undead — the skeleton toggle skips them, and Soldier coerces
// any isUndead request to false. Centralized here so adding or removing a
// race from undead support is a one-field change, not a set of scattered
// guard conditions.
export function raceSupportsUndead(unitTypeDef) {
  return raceOf(unitTypeDef).supportsUndead !== false;
}

// True when the race of `unitTypeDef` carries the given Property (see
// Properties.js). A missing unitTypeDef, a race with no `properties` list,
// or a list without the queried id all read as false rather than throwing —
// the same defensive contract getRace / raceOf already use, so a new unit
// type that forgets to declare a race still works.
//
// Callers should use this rather than reading raceOf(...).properties
// directly, so a future change to how properties are stored stays a
// single-site change.
export function raceHasProperty(unitTypeDef, property) {
  // Per-type exclusion. A race declares its properties once (see Races
  // above), but a specific unit type of that race may opt out of a
  // property that has no meaning for it — the canonical case is a
  // goblin archer, which inherits DIRTY_FIGHTING from the goblin race
  // entry but has no melee flank to fight dirty from. Declared as data
  // on the unit type (UnitTypes.js) rather than hardcoded here, so this
  // helper stays property-agnostic and future exclusions need no code
  // change.
  if (unitTypeDef && Array.isArray(unitTypeDef.excludesProperties)
      && unitTypeDef.excludesProperties.includes(property)) {
    return false;
  }
  const race = raceOf(unitTypeDef);
  return Array.isArray(race.properties) && race.properties.includes(property);
}
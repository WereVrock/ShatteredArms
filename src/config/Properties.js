// ===== Properties.js =====
// Qualitative trait flags a race can declare. A "property" is a boolean
// capability, not a number: a system checks whether a race HAS the property
// and branches into property-specific logic. This is deliberately distinct
// from the numeric race modifiers in RaceConfig.js (damageMultiplier,
// moveSpeedMultiplier, incomingDamageMultipliers, …) which always apply and
// are read as multipliers.
//
// Why a separate concept:
//   Numeric modifiers scale a value; properties select a code path. A race
//   either "fights dirty" or it doesn't — there is no half-dirty-fighting
//   race that just has a smaller multiplier. Expressing this as a boolean
//   trait (rather than, say, a damageMultiplier keyed on flank state) keeps
//   the branch explicit at the consumer and keeps race balance data in one
//   place.
//
// Contract for adding a new property:
//   1. Add its string id here.
//   2. Declare it on any race that should carry it (see RaceConfig.js).
//   3. Wire at least one CONSUMER — a system that reads the property via
//      raceHasProperty(unitTypeDef, Property.X) and does something
//      different. A property with no consumer is inert; the flag alone
//      changes nothing.
//
// Current properties and their consumers:
//
//   DIRTY_FIGHTING — CombatResolutionSystem._resolveAttack.
//     A race with this property trades frontal damage for flank damage.
//     Bonus applies on side/rear hits (stacking on top of the standard
//     flank multiplier); penalty applies on any frontal hit. Numeric
//     tuning lives on the race entry (RaceConfig.goblin.dirtyFighting).
//
//   EXPENDABLE — MoraleSystem._updateSoldier.
//     When a soldier of this race routs, nearby allies take a reduced or
//     zero ally-rout morale penalty: an expendable is not worth panicking
//     over. Non-expendable observers take ZERO penalty from an expendable
//     rout; other expendables take a halved penalty. Tuning lives in
//     MoraleConfig.expendableAllyRoutPenaltyMult.
//
//   FAST_TIRING — UnitPower.compute.
//     A race with this property drains stamina faster in the sim (see
//     RaceConfig.goblin.fatigueDrainMultiplier). The fatigueFactor term
//     already reflects a unit's CURRENT average stamina, so a winded
//     unit reads lower in the score. This property adds a FORWARD-LOOKING
//     correction on top: a race that will be winded sooner has a lower
//     sustained-combat ceiling than its fresh stats imply, even at the
//     moment it is still fresh. Applied as a flat multiplier on the final
//     power total. Numeric tuning lives on the race entry
//     (RaceConfig.goblin.fastTiring.powerMultiplier).
export const Property = {
  // Special case: UNDEAD is a per-SOLDIER trait rather than a per-RACE
  // one. A race record has no UNDEAD flag — being undead is a property
  // of the specific unit that was built with isUndead = true, not of the
  // race it was built from (a Human race fields both living and skeleton
  // units). Declared here so it can appear in the unified trait list a
  // UI reads alongside race properties, and so a future consumer that
  // wants to branch on "is this soldier undead" has a canonical id.
  //
  // Consumer today: UnitInfoPanel — renders it as a trait chip. The
  // mechanical effect it describes is already enforced in
  // MoraleSystem.update: an undead soldier is forced to max morale every
  // tick and can never enter the 'routing' state. No numeric modifier
  // lives behind this property.
  UNDEAD: 'undead',

  DIRTY_FIGHTING: 'dirtyFighting',
  EXPENDABLE: 'expendable',
  FAST_TIRING: 'fastTiring'
};
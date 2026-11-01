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
//
//   WORTHLESS — MoraleSystem._updateSoldier.
//     A worthless unit is SILENT to any other unit, both when it
//     routs and when it is wiped out. Both are the CROSS-UNIT panic
//     paths, and worthlessness suppresses both:
//
//       allyRout penalty   — a routing worthless ally contributes
//                            ZERO to either the expendable or the
//                            non-expendable rout bucket, so no
//                            observer takes anything from it.
//       adjacentUnitWiped  — a worthless unit being wiped out on a
//         shock              given tick generates no shock in any
//                            adjacent friendly of its team.
//
//     This is STRONGER than EXPENDABLE (which still half-panics other
//     expendables and still inflicts the wipe shock) and SUPERSEDES it
//     when a unit carries both: worthlessness wins at both detection
//     sites, so the net outward panic from a unit that is both
//     properties is exactly nil on both paths.
//
//     NOT covered, by design:
//       casualtyLossPenaltyPerSoldier — a worthless soldier dying
//         still panics the OTHER soldiers IN ITS OWN UNIT. That is
//         intra-unit cohesion, not cross-unit panic. Without it, a
//         slave unit could never break at all (its members would see
//         comrades fall and feel nothing). Worthlessness is "my panic
//         does not spread to OTHER units," not "my death does not
//         matter."
//       _autoShatterFullyRoutedTeams — an all-worthless army that has
//         fully routed is still a broken army and shatters. Silence to
//         allies is not indestructibility.
//
//     INCOMING counterpart — the worthless observer PANICS HARDER, not
//     softer, from an expendable rout. MoraleSystem's ally-rout bucket
//     splits observers three ways:
//
//       worthless observer  → full penalty (allyRoutPenaltyPerTick)
//       expendable observer → half penalty (× expendableAllyRoutPenaltyMult)
//       everyone else       → zero penalty
//
//     So a slave watching a neighbouring goblin break takes the SAME
//     hit a human would take watching another human break — the
//     opposite of the zero an ordinary non-expendable observer takes
//     from an expendable rout. Worthlessness is silence OUTWARD; it
//     does not dull reactions INWARD. Design intent: chaff with no
//     cohesion breaks harder, not gentler, when the chaff next to it
//     breaks. See MoraleSystem._updateSoldier for the code.
//
//     ALSO CONSUMED BY UnitPower.compute (scoring-only): the unit's
//     final power total is multiplied by WORTHLESS_POWER_MULT (0.5).
//     The AI and the preview badges therefore read a worthless unit
//     at roughly half of an equivalent-stat non-worthless unit — the
//     score-side counterpart to the morale-side "nobody depends on
//     this unit" reading. See the constant's own comment in
//     UnitPower.js for the rationale and how to retune. Does NOT
//     touch the sim.
//
//     Declared as a per-TYPE addition (UnitTypes.extraProperties)
//     rather than a race-level property: the goblin race carries
//     EXPENDABLE (weaker), and a slave needs WORTHLESS in place of it
//     — declared on the type as a WORTHLESS addition plus an
//     excludesProperties entry for EXPENDABLE — without inflicting
//     that stronger property on every goblin in the army. See
//     RaceConfig.raceHasProperty for how both lists are honoured.
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
  // Stronger sibling of EXPENDABLE. An expendable rout half-panics other
  // expendables; a worthless rout panics no one. Both properties on the
  // same soldier is legal — worthlessness is checked first at the
  // rout-detection site and wins. See the consumer comment above for
  // the exact scope (ally-rout panic only, not casualty shock or
  // adjacent-unit-wipe shock).
  WORTHLESS: 'worthless',
  FAST_TIRING: 'fastTiring'
};
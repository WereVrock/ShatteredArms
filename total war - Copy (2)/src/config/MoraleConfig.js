// Morale tuning. Morale is per-soldier, 0..maxMorale. Sources that reduce
// morale: own HP loss, unit casualties, being outnumbered locally, being
// flanked, and seeing allies rout nearby. Sources that raise it: passively
// over time, killing enemies, and seeing enemy units rout nearby.
//
// At morale <= 0 the soldier enters 'routing' and flees. They only stop
// routing (and rejoin the fight) once morale recovers to rallyThreshold.
export const MoraleConfig = {
  startingMorale: 100,
  maxMorale: 100,
  // Raised from 85 to 92. At 85 a router regenerates (0.4 + 0.4 = 0.8/tick)
  // back to fighting strength in ~106 ticks, then immediately re-breaks and
  // routes again — observed as rout/rally ping-pong in scenario 07, which
  // timed out at 1200 ticks with routTicks=6492, and in scenario 01, which
  // timed out with routTicks=21555. At 92 the recovery window is ~115 ticks,
  // which combined with a smaller adjacent-wipe shock (below) slows the
  // churn enough that broken units can actually be finished off.
  rallyThreshold: 92,

  // Passive recovery per sim tick. Routing soldiers get an extra bonus on
  // top — they are actively getting away from the fight, so they calm faster.
  regenPerTick: 0.4,
  routingRegenBonus: 0.4,

  // Own HP below 50% drains morale, scaled by how far below 50% the soldier is.
  // Bumped from 0.3: at 25% HP the old value produced only -0.15/tick, which
  // the regen rate (0.4/tick pre-gate) more than erased. See note at top of
  // this file on the regen gate.
  hpPenaltyMaxPerTick: 0.6,

  // Unit casualties have two effects:
  //  - a residual drain proportional to the fraction of the unit already lost,
  //    QUADRATIC past 50% losses (see MoraleSystem._updateSoldier)
  //  - a one-shot hit per soldier lost THIS tick (event-like, bigger)
  //
  // The 0.8 rate applies linearly up to 50% losses, then accelerates.
  // Rationale: symmetric line fights (scenario 07) produced zero routs
  // because at 1:1 local odds the only active drains were hp + casualty
  // ratio, both small, and soldiers were killed in ~60 ticks — well
  // before morale could walk to 0. Historical line battles resolve
  // around 25-40% losses for the loser, not 90%+, because a unit that
  // has seen half its friends fall breaks. The quadratic term encodes
  // that: at 50% losses the drain is 0.8/tick, at 75% losses it's 1.8,
  // at 90% losses it's 2.6. Combined with the hp penalty, a battered
  // unit now crosses 0 in ~40 ticks of continued pressure — long enough
  // to feel earned, short enough that the unit breaks before being
  // wiped to the last man.
  casualtyRatioPenaltyPerTick: 1.5,
  casualtyLossPenaltyPerSoldier: 10.0,

  // One-shot morale hit applied to every soldier of a friendly unit
  // when an ADJACENT friendly unit (any soldier of it within
  // routCheckRadius) transitions from >0 alive to 0 alive on the same
  // tick. Watches a unit get wiped is a distinct experience from
  // watching it rout — the existing allyRoutPenaltyPerTick does not
  // fire, because a wiped unit never had routing soldiers.
  //
  // Reduced from 15 to 4. At 15 this was the dominant drain in a
  // symmetric fight — a fresh unit at full morale whose neighbour was
  // wiped on the same tick got instantly routed by the shock alone
  // (scenario 07 log line: components summing to -1.23 with a total of
  // -16.23, i.e. the shock was -15 of the -16 total). That's not a
  // "push a fragile unit over" event, it's a universal opener that
  // breaks healthy units and starts the rout cascade prematurely. 4 is
  // enough to finish a soldier already under pressure without one-shot
  // routing a full-morale one. See also the morale<50 gate on this
  // drain in MoraleSystem._updateSoldier.
  adjacentUnitWipedShock: 4.0,

  // --- Local outnumberedness ---
  // Modelled after Total War: a DISCRETE TIER picked from the ratio of local
  // effective combat strength, not a linear drain per extra enemy head. The
  // previous implementation scaled linearly with raw enemy count inside the
  // spatial query radius, which at 44 enemies within ±10 units produced
  // -8.6 morale per tick and collapsed any soldier who approached a massed
  // formation in under a second.
  //
  // Effective strength is per-soldier effectiveMass (see Soldier.effectiveMass),
  // which already weights cavalry (mass 4.5) above infantry (mass 1.0) and
  // discounts skeleton bodies (×0.6). Using mass rather than raw headcount
  // means a lone heavy cavalryman facing 10 archers is correctly read as
  // "outnumbered but dangerous", not as a suicidal 1:10.
  //
  // Tiers are checked TOP-DOWN; the first tier whose ratio is met wins. No
  // penalty below 2:1 — being slightly outnumbered is normal and modelling
  // it just adds noise to every rout line.
  //
  // Penalty magnitudes are per-tick drains at the tick rate set by
  // CombatConfig.tickRateHz (15 Hz). Chosen so that a full-morale soldier
  // with NO other active drains survives roughly:
  //   2:1  → ~44s   (mild pressure)
  //   3:1  → ~22s   (noticeable, still fighting)
  //   5:1  → ~15s   (serious)
  //   10:1 → ~10s   (capped, surrounded, still swings back)
  // With flank (−0.8/tick) and casualty-loss bursts (−3.0 per death) stacked
  // on top, a genuinely losing soldier breaks in ~5-10s, matching the TW read.
  // Magnitudes re-tuned after observing scenario 16 (Rout: small unit
  // pincered): a full-morale unit losing 3/4 of its soldiers in ~45 ticks
  // of combat never routed because the top tier's 0.65/tick needed ~150
  // ticks to walk morale down from 100. Combat is lethal enough that most
  // losing fights resolve faster than that, so the tiers below are roughly
  // 3x the previous magnitudes — a genuinely surrounded soldier now breaks
  // in 40-60 ticks, which matches observed fight durations.
  outnumbered: {
    tiers: [
      { ratio: 10.0, penaltyPerTick: 2.00 },
      { ratio: 5.0,  penaltyPerTick: 1.30 },
      { ratio: 3.0,  penaltyPerTick: 0.80 },
      { ratio: 2.0,  penaltyPerTick: 0.40 }
    ]
  },

  // Flanked: any enemy within flankCheckRadius at greater than flankAngleDeg
  // off the soldier's facing drains morale.
  flankCheckRadius: 2.0,
  flankAngleDeg: 90,
  // Bumped from 0.8 for two reasons: (1) the flank check itself was fixed
  // to test any nearby enemy instead of only the nearest, so this drain
  // now fires far more often than before; (2) re-tuned against the new
  // outnumbered tiers so flanking remains the single strongest per-tick
  // drain, which is the intended design.
  flankPenaltyPerTick: 1.5,

  // Rout perception.
  routCheckRadius: 6.0,
  allyRoutPenaltyPerTick: 0.6,
  enemyRoutBonusPerTick: 0.4,

  // Combat events.
  killBonus: 3.0,

  // --- Shatter ---
  // Shatter is a terminal routing state: a shattered soldier flees to the
  // map edge and can NEVER rally back. The extraction record treats
  // routed and shattered escapees identically; the distinction only
  // exists during the battle.
  //
  // Shatter triggers (any one):
  //   1. Second rout in the same battle → 30% rout / 70% shatter roll.
  //   2. Third-or-later rout in the same battle → 100% shatter.
  //   3. Unit strength drops below the faction threshold while routing
  //      (continuous check every tick a soldier is in 'routing').
  //
  // Strength is measured as alive / deployed against `unit.soldiers.length`
  // (the count the unit was built with at battle start), not against a
  // roster maximum — a campaign unit deployed at 12/15 has a starting
  // strength of 12, so its threshold is measured against 12.
  shatter: {
    // Fraction of deployed strength below which a routing soldier shatters.
    // Applied continuously while routing, and again at the moment of a
    // fresh rout.
    enemyStrengthThreshold: 0.20,
    playerStrengthThreshold: 0.10,

    // Chance that a SECOND rout in the same battle is a rout (not a
    // shatter). Third-and-later routs always shatter regardless.
    secondRoutRoutChance: 0.30
  }
};
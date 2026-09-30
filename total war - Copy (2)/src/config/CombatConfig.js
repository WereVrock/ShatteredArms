// Tunable combat numbers. No logic here, only data.
//
// SPEED-SPACE CONTRACT — every value in this file whose meaning is a
// world-units-per-second speed is written in DESIGN space: the speed the
// thing would move at if movement.globalSpeedScale were 1.0. Live soldier
// speeds (`soldier.currentSpeed`) are in SIM space (design speed ×
// globalSpeedScale). Any comparison between a soldier's current speed and
// a threshold in this file MUST route through SpeedScale.toSimSpeed()
// before comparing, or the threshold becomes unreachable whenever
// globalSpeedScale < 1. See src/config/SpeedScale.js for the full story
// and the concrete failure mode this contract prevents.

export const CombatConfig = {
  tickRateHz: 15,

  // --- Map bounds ---
  // The single authoritative map edge, in world units, centered on origin.
  //
  // Two rules read this object, and they read the SAME numbers by
  // construction so the visible edge and the sim edge can never drift:
  //
  //   BoundsSystem (sim) — every non-routing, non-shattered soldier is
  //     clamped inside this box at the end of every tick. No marching,
  //     charging, engaged, or thrown soldier can leave the field.
  //
  //   SceneSetup._addFieldEdge (render) — draws the yellow border strips
  //     directly on minX/maxX/minZ/maxZ.
  //
  // Routing and shattered soldiers are EXEMPT from the clamp: they must
  // be able to cross the boundary so RoutingExtractionSystem can record
  // their escape. In campaign play, extracted units have a chance to
  // return in later battles at reduced strength; in standalone scenarios
  // they simply count as lost.
  //
  // ±200 is 5× the original ±40. The larger box gives the battle room to
  // maneuver without units visibly pressing against the border, while
  // still being a hard, enforced edge rather than a decorative one.
  // When a proper MapConfig exists, this can move there and be overridden
  // per scenario.
  mapBounds: {
    minX: -200,
    maxX: 200,
    minZ: -200,
    maxZ: 200
  },

  engagementRange: 1.6,
  targetSearchRadius: 6,
  chargeSpotRange: 3.5,

  rangedRange: 21,
  rangedMinRange: 3.6,
  rangedCooldownTicks: 20,
  projectileSpeed: 9,

  // --- Arrow ballistics (sim-authoritative) ---
  // Every fired arrow is a real sim object: ProjectileSystem advances it
  // along its parabolic arc each tick and checks collision against every
  // living soldier in range — friend, foe, or stray target. Damage and
  // shield-block resolution happen at collision, not at launch, so a fast
  // unit that has moved out of the target area between launch and impact
  // is simply not hit.
  //
  // The target area for each shot is a disc centered on the target unit's
  // center, radius = the archer unit type's `rangedAccuracy` (world units).
  // A tighter radius means a tighter volley; a wider radius means more
  // misses and more stray friendly fire.
  arrow: {
    // Vertical band (world units above ground) within which a soldier's
    // body can be struck. Below bodyMinY the arrow is at ground level;
    // above bodyMaxY it flies clean over. Roughly a standing silhouette.
    bodyMinY: 0.1,
    bodyMaxY: 1.7,
    // Effective hit radius (world units, XZ plane) around a soldier for
    // arrow collision. Wider than the physical collision radius (0.25) so
    // a descending arrow has a realistic chance to strike a body rather
    // than slipping between two soldiers in the same rank.
    hitRadius: 0.5,
    // Out-of-bounds cull: an arrow whose position leaves the map box by
    // this margin is discarded without further collision checks.
    cullMargin: 5.0,
    // Fallback accuracy radius when a ranged unit type does not declare
    // its own `rangedAccuracy`. Kept in sync with the archer default so
    // a future ranged variant without the field still behaves sanely.
    defaultAccuracy: 1.8,
    // Distance-scaled spread. Each shot's scatter radius is the archer's
    // rangedAccuracy multiplied by a factor that interpolates linearly
    // from accuracyAtMinRangeMult at CombatConfig.rangedMinRange to
    // accuracyAtMaxRangeMult at CombatConfig.rangedRange. Close-range
    // volleys are visibly tighter; long-range volleys keep the archer's
    // full declared spread. A target below rangedMinRange cannot be
    // fired at anyway (RangedCombatSystem filters those out), so the
    // min-range end is the tightest bound that can actually fire.
    accuracyAtMinRangeMult: 0.3,
    accuracyAtMaxRangeMult: 1.0
  },

  baseToHitChance: 0.55,

  baseMeleeCooldownTicks: 4,

  movement: {
    globalSpeedScale: 0.6
  },

  // --- Make-way pass ---
  // Runs after the main movement loop each tick (see
  // MovementSystem._applyMakeWay). Idle/marching soldiers whose different-
  // unit friendly is marching at them from close range step perpendicular
  // to that friendly's heading — away from the corridor center — opening
  // a lane for the friendly to walk straight through.
  //
  // The mover itself gets no sideways bias. Its path stays straight. The
  // corridor is created by the blocking formation parting, which matches
  // real infantry behaviour: soldiers already standing shoulder-to-shoulder
  // make room; they do not expect the walking column to weave around them.
  //
  // Push falls off with distance and is scaled by how head-on the friendly
  // is. A friendly merely in the vicinity does not trigger it; a friendly
  // walking directly at the blocker does.
  makeWay: {
    // Scan radius for approaching friendlies. Above the collision minimum
    // separation (0.5) so the push fires before collision does and
    // soldiers part smoothly instead of trading pushes.
    radius: 1.2,
    // Minimum currentSpeed (sim-space units/sec) for a friendly to count
    // as "marching at us". Below this the friendly is at most twitching
    // from slot-correction and there is no corridor to open. Checked
    // against currentSpeed rather than state because `idle`-state
    // soldiers whose unit just received a move order still walk toward
    // their new slots — they hold the idle label until an enemy target
    // appears, so a pure state test misses exactly the case scenario 15
    // is built to exercise. Any really-walking soldier — spear, sword,
    // archer, cav — clears 0.1 comfortably.
    incomingSpeedThreshold: 0.1,
    // Minimum dot of (friendly's heading) vs. (vector from friendly to
    // blocker). 0.4 ≈ 66° half-angle. A friendly outside this cone does
    // not fire the push — walking past, not walking through.
    dotThreshold: 0.4,
    // Fraction of walk speed applied to the push per tick. 0.8 produces
    // ~0.03 units/tick of lateral displacement, which over a ~50-tick
    // approach window accumulates to ~1.5 units — enough to slide past
    // one formation rank with room to spare. Smaller values fail to
    // clear the corridor in time; much larger values over-displace the
    // blocker out of its own slot.
    amount: 0.9,
    // Cross-product tie-break band. When the blocker sits almost exactly
    // in the friendly's path, the two perpendiculars are nearly equally
    // "away" and the sign flips on floating-point noise. This band
    // resolves the choice deterministically by soldier id.
    sideTieEpsilon: 0.05
  },

  // --- Friendly yield ---
  // When a soldier from a different friendly UNIT sits in the forward
  // cone, the soldier's movement direction is bent sideways this tick to
  // flow around the blocker rather than pressing into it. Same-unit
  // soldiers do not trigger yield — a formation marching to its slots
  // has friendlies directly ahead by design, and stepping sideways would
  // dissolve the formation. Yield applies only between units.
  //
  // The bias is per-tick and vanishes the moment the blocker leaves the
  // forward cone, so the soldier still converges on its formation slot;
  // it just takes a slightly curved path when another unit is in the way.
  //
  // Skipped for routing soldiers — panic flight pushes through, it does
  // not defer.
  friendlyYield: {
    // Scan radius for forward-cone friendlies. Above the collision
    // minimum separation (0.5) so yield fires before the collision push
    // does, letting soldiers route around rather than trade pushes.
    radius: 1.2,
    // Half-angle of the forward cone. A friendly outside this angular
    // spread of the movement direction does not trigger yield. 60°
    // half-angle = 120° total cone — generous enough to catch diagonal
    // blockers, tight enough that only genuinely-in-the-way friendlies
    // fire it.
    forwardConeHalfAngleDeg: 60,
    // Fraction of the movement direction replaced by sideways bias.
    // The remaining (1 - biasAmount) fraction is still forward, so the
    // soldier keeps advancing while drifting laterally. 0.75 was tried
    // and rejected: after normalizing the bent direction, forward speed
    // collapsed to ~32% of walk speed, so a yielding soldier advanced
    // too slowly to reach its slot before the fight it was marching to
    // ended. 0.5 gives a 45° bend — forward 71%, sideways 71% of walk
    // speed — the sweet spot where soldiers make real lateral progress
    // AND still cover ground.
    biasAmount: 0.5,
    // Side-commitment window in ticks. Once a soldier picks a yield
    // side it holds it for this many ticks. 25 ticks at 15Hz ≈ 1.7s of
    // committed lateral drift. At biasAmount 0.5 this produces ~0.65
    // units of sideways displacement per commit cycle — enough to
    // slide past one rank of a normal formation. A soldier needs ~3
    // cycles to clear a 3-deep formation, which is achievable within
    // the fight window.
    sideCommitTicks: 25,
    // Threshold below which the away-from-block dot product is treated
    // as "no clear side" and a deterministic tiebreak is used instead.
    sideTieEpsilon: 0.15,
    // When a fresh commit is required (previous commit expired, soldier
    // still blocked), reuse the previous side if the new best side is
    // within this dot-product threshold of the old. Keeps a soldier from
    // alternating east-west across commit cycles when the block centroid
    // drifts slightly. Set to 0 to disable stickiness.
    sideStickyDot: 0.3,

    // --- Reciprocal yield ("make way") ---
    // A soldier who is idle or marching, and who has a different-unit
    // friendly heading toward them from close range, nudges perpendicular
    // to that friendly's heading — moving further to the side they are
    // already on, so the incoming friendly gets a clean line through.
    //
    // This is a second-pass mechanic: the main movement loop resolves
    // everyone's own goal-directed step first, then this pass nudges
    // standers to open gaps. Does NOT set movedThisTick — a "make way"
    // nudge is involuntary, like the collision push, so it must not
    // feed back into FacingSystem's "walked this tick" branch.
    //
    // Engaged, staggered, knockedDown and routing soldiers never
    // reciprocate. Engaged means holding a melee line — that's the
    // right call; a fighting soldier does not step aside to let a
    // passer-through in.
    reciprocalNudgeRadius: 0.75,
    // Minimum forward-cone dot for the incoming friendly. 0.4 ≈ 66°
    // half-angle — the friendly has to actually be heading at us, not
    // merely walking in the general vicinity.
    reciprocalNudgeDot: 0.4,
    // Fraction of walk speed applied to the reciprocal nudge. Small —
    // this is a polite step-aside, not a movement order. Bigger values
    // visibly displace the making-way soldier from its slot.
    reciprocalNudgeAmount: 0.35
  },

  collision: {
    minSeparation: 0.5
  },

  skeleton: {
    massMult: 0.6
  },

  shield: {
    moveSpeedMult: 0.95
  },

  shieldBlock: {
    baseBlockChance: 0.70,
    innerArcDeg: 30,
    outerArcDeg: 90,
    outerArcBlockChance: 0.20,
    weaponTypeBlockMult: {
      bow: 1.4
    }
  },

  shieldMaxHp: 50,

  staggerDurationTicks: 6,

  fatigue: {
    max: 100,
    drainPerAttack: 3,
    drainPerBlockAttempt: 1.5,
    regenPerTickIdle: 0.5,
    minBlockMultiplierAtZeroFatigue: 0.35
  },

  discipline: {
    normal: { impetuousChance: 0.15 },
    low: { impetuousChance: 1.0 },
    high: { impetuousChance: 0.0 }
  },

  charge: {
    speedThreshold: 1.8,
    minMassRatioForKnockback: 1.5,
    bonusDamagePerMassRatio: 4,
    knockedDownDurationTicks: 18,
    blockChancePenaltyWhileCharging: 0.5,
    skeletonChargeDamageMult: 1.4,

    // Part C: ChargeReadiness corridor sampling. Half-width in world units
    // of the approach corridor between a charging cavalry unit and its
    // target. Any spearman inside this corridor who would plausibly brace
    // in the time available blocks the charge (see ChargeReadiness.assess).
    // Roughly one formation frontage — 2.0 covers a spear front rank's
    // full width and the few soldiers immediately behind it.
    corridorHalfWidth: 2.0,

    // Corridor length overshoot past the target's center. The corridor
    // nominally runs from the charger's center to the target's center;
    // this value extends it further along the same bearing so that
    // spearmen intermingled with the target unit — spears woven into an
    // archer formation, sitting one or two ranks behind the archers from
    // the charger's bearing — are still sampled. Without this, a charge
    // into an archer formation with spears mixed through it arrives at
    // the spears with no warning: the corridor ended exactly at the
    // archer unit's center and the spearmen behind it were invisible.
    //
    // 3.0 covers roughly four formation ranks past the target's center.
    // Raise if archer/spear mêlées still slip through; lower if charges
    // are being aborted against clean archer formations with a lone
    // spearman straggler far behind them.
    corridorOvershootUnits: 3.0,

    normalShovePerMassRatio: 0.2,
    maxNormalShove: 0.9,

    knockbackVelocityPerMomentum: 1.2,
    maxThrowMassRatioScale: 3,
    maxKnockbackVelocity: 12,
    skeletonKnockbackMult: 1.5,
    knockbackDurationTicks: 8,
    knockbackDecayPerTick: 0.75,
    throwHeightPerVelocity: 0.15,
    maxThrowHeight: 3.0
  },

  disengage: {
    graceTicks: 12
  },

  flank: {
    sideArcDeg: 90,
    rearArcDeg: 150,
    sideDamageMult: 1.25,
    rearDamageMult: 1.5
  },

  brace: {
    frontalArcDeg: 90,
    counterDamageMult: 1.5
  },

  // --- Turning ---
  // Every soldier's FACING rotates toward a desired facing at a bounded
  // angular rate — no state (engaged, marching, idle, threat-reacting) gets
  // instant facing. This is deliberate, not a simplification: flank/rear
  // damage bonuses (see `flank` above) and brace's frontal-arc requirement
  // (see `brace` above) only function as real mechanics if facing has
  // inertia. If facing were instant, a soldier could never be caught
  // off-guard by an angle of attack — they'd always snap to face whatever
  // last touched their targeting, and flanking/pre-impact bracing would be
  // meaningless. Modeled after Total War: a bounded turn rate applies
  // uniformly, including to soldiers already engaged in melee.
  turning: {
    // Radians per second. ~4.19 rad/s ≈ a soldier can turn 180° in ~0.75s —
    // fast enough to track a slowly circling opponent, not fast enough to
    // instantly snap onto a flank charge that closes in under that time.
    baseTurnRateRadPerSec: 4.2,
    // Soldiers actively fighting (engaged) turn somewhat slower than an
    // idle soldier reacting to a spotted threat — mid-swing/mid-block, full
    // agility isn't available. Multiplier on baseTurnRateRadPerSec.
    engagedTurnRateMult: 0.8,
    // Charging cavalry (currentSpeed >= charge.speedThreshold) turn slower
    // than infantry — committing a charge means committing to a heading;
    // a horse at a gallop cannot pivot like a standing man.
    chargingTurnRateMult: 0.45,
    // Spear-armed soldiers turn more slowly than sword/archer infantry —
    // a 1.4-unit shaft through a packed formation is awkward to reorient
    // without fouling neighbours. Applied AFTER the state multipliers
    // above, so a spear soldier in any state turns proportionally slower
    // than the equivalent non-spear soldier in the same state.
    spearTurnRateMult: 0.7
  },

  // --- Spear handling (raise/rotate/lower) ---
  // Governs the pre-rotation spear raise when a spear soldier would sweep
  // their shaft through a friendly. See FacingSystem._updateSpearHandling
  // for the full state machine.
  spearHandling: {
    // Ticks spent raising the spear before rotation begins, and ticks
    // spent lowering it once the new facing is reached. Rotation happens
    // ONLY while fully raised — the shaft is out of the sweep plane, so
    // the pivot is safe.
    raiseDurationTicks: 5,
    lowerDurationTicks: 5,
    // A reorientation smaller than this is treated as a target-tracking
    // adjustment and rotated without the ceremony — the raise cycle only
    // fires for genuine formation reorientations.
    minRotationDegForRaise: 25,
    // Friendly soldiers within this radius of the spearman are candidates
    // for "the swept shaft would clip them". Roughly the physical reach
    // of the shaft from the soldier's body — 1.2 units covers the
    // adjacent slot at standard 0.6-unit formation spacing with margin.
    friendlyClipReach: 1.2,
    // Tilt angle at full raise. ~60° tips the shaft up out of the
    // horizontal sweep plane without going fully vertical — reads as
    // "port arms" rather than a salute.
    fullRaiseRad: Math.PI / 3,
    // Spear-armed soldiers move slower than sword infantry. A 1.4-unit
    // shaft is not a running weapon, and a spear formation that can
    // out-pace a sword formation makes the sword's closing speed advantage
    // meaningless. Applied AFTER the shield mult, so a shielded spearman
    // gets both penalties stacked. At 0.8 a shielded spearman moves at
    // 1.2 * 0.95 * 0.8 = 0.912, vs a shielded swordsman at
    // 1.25 * 0.95 = 1.1875 — roughly 23% slower.
    moveSpeedMult: 0.8,

    // Degrees off the defender's UNIT formationFacing beyond which the
    // spear wall is treated as broken for that attacker. A spear wall is
    // a DIRECTIONAL formation: it works because all the shafts point
    // roughly the same way and overlap into a hedge. Once an attacker
    // falls outside this arc, the wall cannot present a coherent face to
    // them, and the individual spear's anti-sword advantage no longer
    // applies.
    //
    // Reference direction is the UNIT's formationFacing, NOT the
    // individual soldier's facing. A spearman who pivots his own body
    // east to answer a flanker does not restore the wall — the shafts
    // on either side of him are still pointed north, and the wall is
    // still broken from that attacker's perspective. Rotating in place
    // is a personal action; the wall is a formation property.
    //
    // At or beyond this angle against a spearman defender:
    //   - frontalVsSpearman is false — no 1/3 damage penalty, and the
    //     attacker's attack-speed bonus (if any) is restored
    //   - the flank damage multiplier fires against this angle, using
    //     CombatConfig.flank.sideDamageMult (1.25x) at this threshold
    //     and flank.rearDamageMult (1.5x) at flank.rearArcDeg (150)
    //
    // Applies to undead spearmen equally — bone does not pivot faster
    // than flesh, and a broken wall is a broken wall. Skeletons simply
    // do not rout from it; there is no morale consequence because
    // skeletons never rout.
    //
    // Non-spearman defenders are unaffected: they continue to use the
    // individual soldier's facing with flank.sideArcDeg (90) as before.
    // The asymmetry is intentional — a swordsman's guard is a personal
    // stance; a spearwall is a formation.
    wallBrokenArcDeg: 60
  },

  // --- Threat facing (pre-impact charge detection) ---
  // Governs ThreatFacingSystem: idle/marching/ranged soldiers passively
  // detect an incoming charge and set their DESIRED facing toward it (the
  // actual turn is still rate-limited by `turning` above — detecting a
  // threat doesn't grant instant reaction, it only grants the CHANCE to
  // turn in time).
  threatFacing: {
    // Only soldiers of at least this mass ratio disadvantage or specific
    // cavalry type count as a "charge" worth reacting to (this reuses the
    // same charge-detection basis as CombatResolutionSystem, so a soldier
    // reacts to the same thing that would actually harm them on impact).
    detectRadius: 7.0,
    detectSpeedThreshold: 1.8, // matches charge.speedThreshold — only react to soldiers actually charging, not walking
    // A soldier only reacts to the SINGLE nearest qualifying threat, not
    // an average of several — reacting to "a direction" between two
    // simultaneous threats would mean facing neither correctly, which is
    // both unrealistic and a worse outcome than picking one.
  }
};

export const WeaponMatchup = {
  spear: {
    toHitMod: 1.0,
    damage: 12,
    shieldDamage: 8,
    staggerThreshold: 18
  },
  bow: {
    toHitMod: 0.8,
    damage: 9,
    shieldDamage: 5,
    staggerThreshold: 999
  },
  lance: {
    toHitMod: 1.0,
    damage: 20,
    shieldDamage: 15,
    staggerThreshold: 14
  },
  sword: {
    toHitMod: 1.05,
    damage: 13,
    shieldDamage: 9,
    staggerThreshold: 20
  }
};

export const SkeletonDamageModifiers = {
  sword: 1.5,
  bow: 0.6,
  spear: 0.7,
  lance: 1.0
};

export const DefenderCategoryDamageModifiers = {
  cavalry: {
    spear: 1.75
  }
};
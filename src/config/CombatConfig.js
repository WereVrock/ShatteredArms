// ===== CombatConfig.js =====
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
  // How far (world units) a ranged soldier may stand from its formation
  // slot before it walks back onto it. Small on purpose: formation spacing
  // is 0.7, so anything bigger visibly breaks the line.
  rangedSlotHoldTolerance: 0.12,
  // Half-angle (degrees) of the firing arc around a unit's formationFacing.
  // A ranged soldier whose target lies inside this arc keeps the facing the
  // player set and shoots without turning; a target outside the arc makes
  // it turn toward the target. 60 = 120 degrees total. 180 = never turn to
  // shoot. 0 = always turn to the target (old behaviour).
  rangedHoldFacingArcDeg: 60,
  // DRAW TIME for a ranged unit's bow cycle, in ticks — NOT merely the gap
  // between volleys. 35 ticks at 15Hz ≈ 2.33s from nock to loose. The very
  // first shot after a unit enters ranged state is gated by this same full
  // draw: an archer cannot acquire a target and loose on the same tick.
  // See RangedCombatSystem.update for the "first aim" wind-up that enforces
  // this — without it, the initial volley fired instantly while every
  // later volley waited the full cooldown.
  //
  // Chosen so a charging cavalry unit (sim speed ~1.56 u/s with
  // globalSpeedScale 0.6) can close the ~20-unit gap from max range
  // without being shredded. At 20 ticks (1.33s) a horseman ate 3-4 volleys
  // on the approach and rarely reached the bow line. Bow damage, accuracy,
  // and the accuracy/arc curves in `arrow` below are unchanged — this is
  // purely a rate-of-fire knob.
  rangedCooldownTicks: 35,
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
    accuracyAtMaxRangeMult: 1.0,
    // Distance-scaled arc. Close-range shots fly flat (Total War style
    // — the arrow travels straight from bow to body); long-range shots
    // keep the full parabola so they clear the front rank on the way
    // in. Arc multiplier is 0 at or below arcFlatMaxDist, ramps
    // linearly to 1 at arcFullDist, and stays at 1 beyond. Thresholds
    // chosen against rangedMinRange (3.6) and rangedRange (21):
    // everything inside 6 units is a knife-fight shot and lofts not at
    // all; only shots past 15 units get the full arc.
    //
    // The interpolation itself lives in ArrowArc.arcMult — these are
    // the knobs, not the math.
    arcFlatMaxDist: 6.0,
    arcFullDist: 15.0,
    // Chance an UNBLOCKED arrow staggers the soldier it hits. Uses the
    // shared CombatConfig.staggerDurationTicks for the stagger length,
    // same as a melee stagger. Does NOT stack: a defender already
    // staggering (staggerTicksLeft > 0) or knocked down is not
    // re-staggered — see ProjectileSystem._resolveHit. Without the
    // no-stack rule a whole-unit loose (15-30 arrows landing on one
    // tick) would re-trigger the timer on every arrow that rolled a
    // stagger, stun-locking one soldier for the entire volley instead
    // of disrupting him for one interval.
    staggerChance: 0.4
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
    massMult: 0.6,
    // HP multiplier for any undead soldier. Applied on top of the normal
    // HP path (unitTypeDef.baseHp × race hpMultiplier), so a skeleton
    // spearman and a skeleton archer keep their relative durability and
    // the whole undead category just gets a uniform brittleness discount.
    // 0.8 = 20% less HP. Read by the Soldier constructor when isUndead is
    // true. See Soldier.js.
    hpMultiplier: 0.8,
    // Move speed multiplier for any undead soldier. Applied LAST in
    // Soldier.effectiveMoveSpeed, after equipment and race multipliers,
    // so it stacks cleanly with spear/shield penalties and any race-level
    // speed modifier. 0.9 = skeletons of foot types move 10% slower than
    // their living counterpart — a uniform, mild shambling penalty, not a
    // hard cap. Tune down toward 0.5 for a genuinely slow shamble; tune up
    // toward 1.0 to remove the penalty.
    //
    // EXEMPTION: undead CAVALRY skip this multiplier entirely. The check
    // in Soldier.effectiveMoveSpeed gates on !isCavalry(unitTypeDef), so a
    // skeletal horse (if one is ever added to the roster) still gallops at
    // full speed. Read there, not here — this value is the multiplier,
    // the cavalry exemption is code.
    moveSpeedMultiplier: 0.9
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
  // Per-unit-class multipliers on staggerDurationTicks. A soldier whose
  // unit type belongs to a class keyed here uses base * multiplier
  // instead of base. Light troops recover faster — archers (unitClasses
  // ['ranged']) at 0.5 get 3 ticks instead of 6. If a unit belongs to
  // multiple keyed classes, the SMALLEST multiplier wins (most forgiving
  // to the defender); a unit with no keyed class gets the base value
  // unchanged. Read via Soldier.staggerDurationTicks — both the melee
  // path (CombatResolutionSystem) and the arrow path (ProjectileSystem)
  // go through that one getter so the two can never disagree.
  staggerDurationMultiplierByClass: {
    ranged: 0.5
  },

  fatigue: {
    max: 100,
    drainPerAttack: 3,
    drainPerBlockAttempt: 1.5,
    // Idle-only recovery. Marchers no longer regenerate — the act of
    // walking now costs a small amount (see drainPerWalkTick below), so
    // a long march is itself tiring and a soldier can only recover by
    // standing still. Was 0.5 shared between idle and marching, which
    // made any disengage-and-walk sequence a full reset. See
    // CombatResolutionSystem._regenerateIdleFatigue.
    regenPerTickIdle: 0.1,
    // Walking drain. Applied per tick to any soldier who actually moved
    // this tick under voluntary locomotion — the main movement loop,
    // MovementSystem._holdFormationSlot, and MovementSystem._applyMakeWay.
    // Involuntary movement (throw/knockback integration, stand-still
    // decay in engaged states) does not set movedThisTick and is
    // correctly excluded. Scaled by the soldier's race fatigue
    // multiplier (RaceConfig.fatigueDrainMultiplier), so goblins tire
    // faster on the march than humans. Set to 0 to make walking free.
    drainPerWalkTick: 0.05,
    minBlockMultiplierAtZeroFatigue: 0.35,
    // Fatigue-based MELEE attack-speed floor. A soldier at FULL fatigue
    // (100) attacks at 1.0x speed (no change). A soldier at ZERO
    // fatigue attacks at this multiplier — with 0.6, a 4-tick spear
    // swing stretches to 7 ticks, and a 1.2x sword's 3-tick swing
    // stretches to 6 ticks. The multiplier is linear in between,
    // matching the existing minBlockMultiplierAtZeroFatigue curve so
    // block chance and attack speed degrade together as stamina
    // drains.
    //
    // Applied in CombatResolutionSystem._resolveAttack, on top of the
    // weapon's own attackSpeedMultiplier (sword 1.2) and any champion
    // attackSpeedMult. See Soldier.fatigueAttackSpeedMultiplier for
    // the curve.
    //
    // Tuning: 0.6 gives stamina a real presence in drawn-out melees —
    // an exhausted line is noticeably slower, giving a fresh reserve
    // committed late a meaningful advantage — without the fight
    // becoming entirely about stamina. Raise toward 0.75 for a
    // subtler effect; lower toward 0.35 to match the block-chance
    // floor and make exhaustion genuinely decisive.
    minAttackSpeedMultiplierAtZeroFatigue: 0.6,

    // Ranged analogue of minAttackSpeedMultiplierAtZeroFatigue. An
    // archer unit's volley cadence scales with the AVERAGE fatigue of
    // the archers who actually fired the last volley: at full average
    // fatigue (100) the unit volleys at the base
    // CombatConfig.rangedCooldownTicks (35); at zero average fatigue
    // the cooldown stretches to this value (60). Linear in between.
    //
    // Measured on the shooters of the volley, not on every living
    // soldier of the unit, because the shooters are the ones doing the
    // work — a fresh archer who was out of range last volley does not
    // pad the average for a spent one who was firing.
    //
    // Applied by RangedCombatSystem._volleyCooldownFor to both the
    // inter-volley cooldown and the initial aim wind-up, so a tired
    // unit visibly draws slower on its first shot too, not only on
    // follow-ups. Deliberately a tick-count ceiling rather than a
    // multiplier: the ranged cadence is already a whole-unit value
    // (volleyCooldownByUnit), and expressing the ceiling directly in
    // ticks keeps the tuning readable without a conversion.
    maxRangedCooldownAtZeroFatigue: 60
  },

  // Discipline tiers. Each entry carries:
  //
  //   impetuousChance       — probability of charging without orders
  //                           (existing behaviour, unchanged).
  //
  //   formationJitterUnits  — amplitude, in world units, of the
  //                           persistent per-soldier formation offset
  //                           applied at slot-computation time. 0
  //                           keeps the perfect grid; higher values
  //                           produce visibly looser, wobbly lines.
  //                           Read by Soldier.disciplineJitter, applied
  //                           by Unit._applyFormationAt. High-
  //                           discipline formations keep a clean
  //                           lattice; low-discipline swarms do not.
  //
  //   minFormationCols      — hard floor on the column count (frontage,
  //                           in soldiers). The formation cannot be
  //                           narrower than this. 1 = no floor.
  //
  //   minFormationRows      — hard floor on the row count (depth, in
  //                           soldiers). Enforced only when the unit has
  //                           enough soldiers to satisfy BOTH minimums
  //                           at once. When it is, the shape is
  //                           rebalanced to give exactly minFormationRows
  //                           balanced rows — no stub back row. A
  //                           24-soldier unit with minCols 3 / minRows 3
  //                           deploys 8/8/8, not 11/11/2. 1 = no floor.
  //
  //   slotToleranceUnits    — OUTER slot threshold. If a soldier is
  //                           within this distance of its slot AND was
  //                           pushed (collision, throw, any external
  //                           force) since its last walk decision, it
  //                           accepts where the push left it and stops.
  //                           This is what kills the collision /
  //                           walk-back jitter loop. Read by
  //                           Soldier.slotArrivalTolerance.
  //
  //   slotAttemptUnits      — INNER slot target upper bound. Every
  //                           soldier picks a personal target distance,
  //                           deterministic from its id, uniformly in
  //                           [0.01, slotAttemptUnits]. Outside the
  //                           pushed-and-within-tolerance case above,
  //                           the soldier walks toward its slot and stops
  //                           when it is within that personal target.
  //                           Read by Soldier.slotAttemptTarget.
  //
  //                           Setting slotAttemptUnits equal to
  //                           slotToleranceUnits (the default for every
  //                           tier) makes the personal target range the
  //                           full tolerance band — the soldier settles
  //                           at a random depth inside it. Setting a
  //                           smaller value gives a tighter attempt
  //                           band inside a wider acceptance band.
  //
  //   powerMultiplier       — flat multiplier on UnitPower's final total
  //                           for every unit of this discipline tier.
  //                           Scoring only: it does NOT change the sim.
  //                           A low-discipline unit is worth less than
  //                           its raw stats imply — its impetuous
  //                           charges, loose formation, and erratic
  //                           cohesion cost it sustained-combat value
  //                           even when its weapon and HP numbers are
  //                           identical to a disciplined counterpart.
  //                           Read by UnitPower._disciplinePowerMultiplier.
  //
  //   displayName           — player-facing label for the tier. Shown in
  //                           UnitInfoPanel's Combat section. Kept here
  //                           (not derived from the key) so a future
  //                           rename of the key does not leak into UI
  //                           text.
  //
  // Minimums and slot tolerance are enforced everywhere the shape or the
  // walk-home decision is made: initial deployment (FormationFactory),
  // live reshape (Unit._recomputeShapeForWidth), the drag preview
  // (Unit.previewFormationSlots), and the movement loop (MovementSystem).
  // Scenario-built and campaign-built units go through the same rules.
  //
  // Design intent: low-discipline troops (goblins) are a swarm, not a
  // manoeuvre element. They fight in a loosely packed block — never a
  // single-file line or a narrow column — and they stop fidgeting once
  // their formation has settled. High-discipline professionals may pack
  // however tightly the commander wants.
  discipline: {
    normal: {
      displayName: 'Normal',
      impetuousChance: 0.15,
      formationJitterUnits: 0.08,
      minFormationCols: 1,
      minFormationRows: 1,
      slotToleranceUnits: 0.15,
      slotAttemptUnits: 0.15,
      powerMultiplier: 1.0
    },
    low: {
      displayName: 'Low',
      impetuousChance: 1.0,
      formationJitterUnits: 0.35,
      minFormationCols: 3,
      minFormationRows: 3,
      slotToleranceUnits: 0.4,
      slotAttemptUnits: 0.4,
      powerMultiplier: 0.95
    },
    high: {
      displayName: 'High',
      impetuousChance: 0.0,
      formationJitterUnits: 0.0,
      minFormationCols: 1,
      minFormationRows: 1,
      slotToleranceUnits: 0.01,
      slotAttemptUnits: 0.01,
      powerMultiplier: 1.0
    }
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

  // --- Passing attacks ---
  // A soldier under an active move/attack order who walks into melee
  // contact with an enemy attacks them WITHOUT stopping, without leaving
  // its ordered path, and without entering 'engaged'. See
  // ContactAttackSystem.
  //
  // Contact RANGE is CombatConfig.engagementRange — the same radius the
  // sim already uses to decide "these two are in melee contact", so no
  // separate range constant is needed here.
  passingAttack: {
    // Half-arc in degrees around the soldier's moveFacing within which
    // an enemy counts as "in front" and can be attacked on the move.
    // 60 = 120° total cone. Forward-biased enough to read as "in
    // front"; wide enough to catch front-diagonal contacts that a
    // strict ±30° cone would miss; narrow enough that enemies the
    // soldier is walking PAST rather than INTO do not trigger a swing.
    // Measured against moveFacing (walk direction) rather than body
    // facing, because a soldier mid-turn has not yet looked where it
    // is going, but it IS going there.
    forwardArcDeg: 60
  },

  disengage: {
    graceTicks: 12
  },

  // --- Blood Thralls ---
  // Soldiers raised by the Blood Thrall champion skill. Half-statted, no
  // morale, fixed 30-second lifetime, auto-target the champion's nearest
  // enemy. Spawned as their own units; when a fresh thrall spawns within
  // mergeRadius of an existing thrall unit of the same owner, it joins
  // that unit instead of forming a new one.
  //
  // The AI does NOT commit to a thrall unit unless it is right next to a
  // friendly — thralls are an expiring hazard, not an army. That rule
  // lives in the AI layer (see AIConfig.thrallEngageRadius, added when
  // the AI side is patched); this block only carries the sim-side
  // constants.
  thrall: {
    // Multiplier applied to the source soldier's HP, damage, and mass.
    // Speed, accuracy, and stagger recovery are unchanged — a thrall is
    // a weaker fighter, not a slower one.
    statMultiplier: 0.5,
    // Lifetime in sim ticks. 450 = 30 seconds at 15 Hz.
    lifetimeTicks: 450,
    // Distance within which a fresh thrall joins an existing thrall unit
    // instead of forming its own. Roughly two formation widths.
    mergeRadius: 6.0,
    // How far a thrall will search for a target before it just stands
    // idle. Uses the same spatial-grid path as normal targeting, this
    // is the effective search radius.
    targetSearchRadius: 12.0,
    // Team assigned to spawned thrall units. Always the champion's team,
    // but declared here so a future multiplayer case can flip it.
    // (Kept as a constant since it is structurally single-player.)
  },

  // --- Blood Fury blast ---
  // Damage-on-cooldown counter-punch that the Blood Fury champion skill
  // triggers when the champion is struck below 50% HP. Uses the same
  // charge formula as cavalry momentum: damage, knockback, throw,
  // knockdown — just driven off the champion's own mass multiplied by
  // the skill's blastMassMult.
  bloodFury: {
    // Ticks between uses. Mirrors blastCooldownSeconds * tickRateHz,
    // rounded. Kept separately so a future tuning pass can adjust the
    // tick count without re-editing the skill node.
    cooldownTicks: 900,
    // Whether the blast also staggers the attacker for
    // staggerDurationTicks. True = the champion's counter-punch is a
    // real interrupt, not just a shove.
    staggers: true,
  },

  // --- Champion combat XP ------------------------------------------------
  // Raw in-battle XP a champion earns per attack roll, expressed as a
  // MULTIPLE of the enemy soldier's power (unit power / non-routing alive
  // soldiers, cached once per tick by
  // BattleSimulation._updateSoldierPowerCache).
  //
  // 20 makes an average swing (~80-power defender) worth ~1,600 raw XP.
  // A light first battle where the champion lands a handful of hits is
  // then enough to cross the first level threshold (see
  // ChampionSkills.LEVEL_THRESHOLDS). The diminishing curve in
  // ChampionSkills.effectiveXp caps a prolonged grind so a single long
  // battle cannot run away with the tree.
  //
  // TUNING: if champion progression feels slow, raise this value — it
  // scales every attack uniformly and does not require touching the
  // thresholds. If it feels too fast, raise the level thresholds in
  // ChampionSkills instead; do not lower this below ~5 or a single
  // battle will not move the bar at all.
  championXpPerSoldierPower: 20,

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

// Weapon matchup table. Consumed by both the sim (CombatResolutionSystem,
// ProjectileSystem) and the power score (UnitPower). The two consumers
// read DIFFERENT fields:
//
//   - Sim combat reads toHitMod, damage, shieldDamage, staggerThreshold.
//     Those govern what actually happens when a weapon lands.
//
//   - The power score additionally reads powerMultiplier, which is a
//     scoring-only bias. It does NOT affect sim combat — a spear whose
//     powerMultiplier is 1.10 still deals the same damage in a fight as
//     it would with 1.0. It exists so the AI (and the preview badges)
//     can value weapon roles on top of their raw per-soldier DPS.
//
// powerMultiplier rationale:
//   spear 1.21 — the spearwall is the most broadly useful formation
//                weapon in this sim: anti-cavalry, punishes frontal
//                sword attacks, holds a line. Cumulative boost of +21%
//                on the raw per-soldier score (1.10 initial, then a
//                further +10%). Nudges the AI's reinforcement dispatch
//                and plan-role scoring toward valuing spear units over
//                otherwise-equal sword units.
//   sword 0.855 — the sword's anti-skeleton flank-kill is extremely
//                powerful against undead, but situational: against
//                a braced spearwall the sword's speed advantage is
//                nullified. Cumulative penalty of -14.5% on the raw
//                score (0.90 initial, then a further -5%). Reflects
//                that the sword's high per-soldier DPS is conditional
//                on the enemy roster.
//   lance 1.00 — cavalry already scores highly through raw damage and
//                the mass-driven durability term; no correction needed.
//   bow   1.00 — the bow's real variance comes from range and accuracy,
//                which are captured separately by UnitPower's ranged
//                envelope scale (see rangedEnvelopeScale and
//                RANGED_ENVELOPE_DIVISOR). A bow is the nominal
//                reference point for that axis; its weapon multiplier
//                is deliberately neutral.
//
// Tune any of these without touching code. Missing entries default to 1.0.
export const WeaponMatchup = {
  spear: {
    toHitMod: 1.0,
    damage: 12,
    shieldDamage: 8,
    staggerThreshold: 18,
    powerMultiplier: 1.21
  },
  bow: {
    toHitMod: 0.8,
    damage: 9,
    shieldDamage: 5,
    staggerThreshold: 999,
    powerMultiplier: 1.00
  },
  lance: {
    toHitMod: 1.0,
    damage: 20,
    shieldDamage: 15,
    staggerThreshold: 14,
    powerMultiplier: 1.00
  },
  sword: {
    toHitMod: 1.05,
    damage: 13,
    shieldDamage: 9,
    staggerThreshold: 20,
    powerMultiplier: 0.855
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
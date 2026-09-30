// Tunable AI numbers. No logic here, only data.
// AI decisions run at a fixed interval independent of the sim tick rate,
// so a fast sim tick doesn't cause jittery re-issuing of orders.

export const AIConfig = {
  decisionIntervalTicks: 15,
  assessmentIntervalTicks: 15,

  // --- Line infantry (spearmen, swordsmen) ---
  lineApproachStopDist: 1.4,
  lineTargetSwitchMargin: 0.75,
  // Line-cohesion approach: while further than this from the nearest
  // enemy, line units walk to their assigned slot on the shared line
  // (anchored on the enemy mean position) instead of walking directly
  // toward their individual target. Prevents the line spreading into a
  // cloud during the approach; once within this distance of any enemy,
  // normal target-based behavior takes over.
  lineCohesionApproachDist: 8.0,

  // --- Weak-point concentration ---
  // Width (world units) of each lateral slice when scoring the enemy line
  // for weak points. Should roughly match a unit's formation width so
  // slices correspond to "about one enemy unit's worth of frontage".
  enemyLineSliceWidth: 4.0,
  // Fraction of non-reserve line units that should be biased toward the
  // single weakest enemy slice rather than their own nearest enemy. Not
  // all of them — concentrating literally everyone onto one point abandons
  // the rest of the line to be flanked for free.
  weakPointConcentrationFraction: 0.4,
  // A unit only diverts to the weak point if doing so doesn't take it more
  // than this multiple of its distance-to-nearest-enemy out of its way —
  // stops a unit on the far right from marching across the whole map for a
  // weak point on the far left while its own local fight goes unanswered.
  weakPointMaxDetourRatio: 2.2,

  // --- Reserve ---
  // Fraction of each team's non-cavalry, non-ranged units held back from
  // the initial line-forming assignment as a reserve pool, released to plug
  // gaps or reinforce as the fight develops rather than committing to a
  // formation slot from tick one.
  reserveFraction: 0.2,
  // A reserve unit deploys when either: (a) a gap opens in the front line
  // (an adjacent front-line unit is defeated), or (b) a reinforcement need
  // is flagged (see reinforceLocalOutnumberRatio) within this radius of the
  // reserve's current holding position.
  reserveDeployRadius: 14.0,
  // Reserve holding position: behind the line anchor by this distance.
  reserveHoldDepth: 6.0,

  // --- Skirmishers (archers) ---
  // Base standoff distance (world units) from the NEAREST ENEMY UNIT's
  // center that an archer unit walks to before holding and shooting.
  // SkirmisherBehavior combines this with the unit's own formation
  // half-width and a small edge buffer to derive the effective hold
  // band; see the holdFloor calculation there.
  //
  // Raised from 12.0. The prior value put archers well inside their
  // own 21-unit rangedRange, so they had no reason to hold at range
  // and would just keep pace with whatever distance the enemy
  // approached to. Combined with the (very) permissive hold floor,
  // archers that had drifted in could park at 8-10 units and shoot
  // from there. 13.0 puts the desired center-to-enemy distance around
  // 16.5 with the support-role depthOffset applied, which sits just
  // inside the archer formation's own effective max range.
  archerStandoffDist: 13.0,
  archerStandoffTolerance: 1.5,
  archerKiteTriggerDist: 8.0,
  // DESIGN-space speed threshold (see src/config/SpeedScale.js) — compared
  // against `soldier.currentSpeed`, which is SIM space, so any comparison
  // MUST route through SpeedScale.toSimSpeed(). Same contract as
  // CombatConfig.charge.speedThreshold and
  // CombatConfig.threatFacing.detectSpeedThreshold.
  archerChargeThreatSpeed: 1.8,
  // If archers raise a charge-threat kite AND no ally line/reserve unit is
  // already closer to the threat than this, the AI redirects the nearest
  // free line/reserve unit to intercept instead of just letting the
  // archers run.
  archerInterceptMaxAllyDist: 16.0,

  // --- Skirmisher cavalry-cover awareness ---
  // An archer line without cavalry cover gets run down by enemy cavalry:
  // superior horsemen sweep around the melee line and catch the skirmishers
  // in the open before they can retreat. This read compares own vs enemy
  // alive cavalry SOLDIERS (not units — a depleted cavalry unit is not
  // equivalent to a fresh one for screen purposes).
  //
  // When own / enemy falls below this fraction, BattleAssessment sets
  // skirmishersWithoutCavalryCover = true, and SkirmisherBehavior stops
  // advancing archers to archerStandoffDist from the enemy. Instead they
  // hold just forward of the melee line, so a kite-away from any threat
  // pulls them back INTO the formation rather than out into open field.
  //
  // 0.667 is the inverse of the common "we are out-cavalry'd 1 vs 1.5"
  // formulation: own is at most 2/3 of enemy cavalry strength. Tune down
  // to require a worse cavalry deficit before hugging the line; tune up
  // to make the fallback trigger earlier.
  skirmisherCavalrySuperiorityThreshold: 0.667,
  // Distance forward of the infantry line's mean center where archers hold
  // under the no-cover flag. Positive = just in front of the melee line
  // (toward the enemy), so kiting backward naturally passes through the
  // line rather than into open ground behind it. Small values keep archers
  // close enough to be protected; larger values let them get off a few
  // more volleys before falling back.
  skirmisherForwardHugOffset: 2.0,

  // When line-hugging (defensive stance + enemy cavalry superiority),
  // archers are normally pinned just in front of the melee line. But
  // they shouldn't stand idle while an enemy is close enough to be
  // shot — they advance to firing range and shoot. The unleash bubble
  // is defined as (rangedRange * skirmisherUnleashRangeMult) around
  // ANY single melee-line unit. If the archer's current focus-fire
  // target sits inside that bubble and is out of the archer's firing
  // range, the archer advances to a firing position on it; once in
  // range, it holds and fires. When the focus target leaves the
  // bubble or dies, the archer returns to the hug position.
  //
  // Only the archer's focus-fire target (set by FocusFireCoordinator)
  // can trigger an unleash. This keeps focus fire as the single source
  // of truth for WHICH enemy to shoot, while the unleash rule only
  // decides WHERE to stand to make that shot possible.
  //
  // 1.5 * rangedRange (21) = 31.5 world units from any line unit. Wide
  // enough to cover anything the line is already fighting or about to
  // fight; narrow enough that archers don't chase flankers into the
  // open field the hug rule exists to prevent. Tune down for a more
  // conservative advance (archers only shoot targets already close to
  // the line); tune up to let archers lean further forward.
  skirmisherUnleashRangeMult: 1.5,
  // Fraction of rangedRange at which the archer parks when advancing
  // on an unleash target. 0.9 leaves a small buffer inside max range
  // so the shot doesn't flicker in and out as both units shuffle. The
  // hysteresis band is (1 - fireFraction) * rangedRange — at 0.9 that
  // is ~2.1 world units, well above the arrival radius, so the archer
  // does not oscillate between "advance" and "hold" at the range edge.
  skirmisherUnleashFireFraction: 0.9,

  // --- Focus fire ---
  // Team-level archer target assignment. Re-picked every
  // focusFireReassessTicks; NOT every decision tick, so archers don't
  // thrash targets faster than a volley cycle can matter
  // (CombatConfig.rangedCooldownTicks in the sim is 20 ticks).
  focusFireReassessTicks: 20,
  // Priority order for focus fire, evaluated top to bottom; a lower-tier
  // candidate is only used if no higher-tier candidate exists in range of
  // ANY archer.
  focusFireLowHpFraction: 0.4, // prefer enemy units already below this HP frac

  // --- Flankers (cavalry) ---
  cavalryChargeDist: 3.0,
  cavalryCommitDist: 9.0,
  cavalryApproachOffset: 5.0,
  cavalrySoftTargetDistanceFactor: 1.5,
  commitTimeoutTicks: 90,
  regroupTriggerAllyRadius: 3.5,
  regroupMinAllies: 1,
  // Lowered from 45: playtest logs showed a lone charging cavalry soldier
  // (maxHp 55) losing a straight melee war of attrition against a full
  // archer unit within well under 45 ticks — archers hit for real melee
  // damage (WeaponMatchup.bow.damage: 9) from multiple attackers per tick
  // once surrounded. Waiting 3 full seconds before even checking for
  // regroup meant the unit was often already dead or too low HP to survive
  // the pull-out. This is a strike-and-disengage weapon, not a grinder.
  regroupTriggerTicksInMelee: 15,

  // Cavalry-specific minimum melee commitment. Once a charge makes
  // contact, the unit fights for at least this many ticks before checking
  // the regroup condition. Without this, the unit disengaged on the first
  // contact tick (ticksInMelee=0 in the logs), leaving targets at half
  // strength after a single charge hit. 10 ticks at 15Hz ≈ 0.67s, which
  // at base melee cooldown 4 gives 2-3 attack cycles per cav soldier —
  // enough for a real charge strike to land, short enough that a cav
  // soldier (maxHp 55) is safe from spear damage (21/hit, 3 hits to die)
  // and from concentrated archer fire (9/hit × several attackers).
  cavalryMeleeCommitTicks: 10,

  regroupFallbackDist: 6.0,
  regroupHoldTicks: 30,
  // Routing enemy units are the cheapest kills on the field (no shield
  // block roll matters if they're run down, and killing them denies any
  // chance of rally). Any routing enemy unit within this distance is
  // preferred over the normal nearest/soft-target scoring entirely.
  cavalryRoutingChaseRadius: 18.0,
  // Same-flank coordination: when multiple of our cavalry units are
  // simultaneously in 'seeking' phase, prefer grouping onto the SAME
  // target if they're within this distance of each other, rather than
  // splitting onto separate targets — a joint charge lands harder than two
  // separate ones and avoids wasting one charge on overkill while another
  // flank goes unaddressed. Only applies when the shared target can
  // plausibly absorb both (alive count check).
  cavalryCoordinationRadius: 12.0,

  // --- A3: Cavalry flank groups ---
  // Lateral distance (along the battle line's right axis) within which two
  // cavalry units are considered to be on the "same flank" and grouped
  // together with a single deterministic leader. A cavalry unit further
  // than this from any existing group's lateral centroid starts its own
  // group. Deliberately generous — cavalryApproachOffset/flankLateralOffset
  // already spread cavalry into two clusters (left/right) by formation
  // design, so this just needs to not accidentally merge them.
  cavalryGroupLateralRadius: 10.0,
  // A follower defers to its group leader's target UNLESS it has a
  // strictly better local option: a routing enemy within
  // cavalryRoutingChaseRadius. This mirrors FlankerBehavior's existing
  // routing-chase priority so group membership never prevents a free kill.

  // --- Cavalry target restrictions ---
  // Cavalry may only attack non-archer targets that are already
  // engaged with another unit, OR are enemy cavalry currently charging
  // one of our units. Archers are always a valid cavalry target.
  // Independently of type, any target must be close enough to one of
  // our OTHER units to be considered a supported target — no long-range
  // solo raids. See FlankerBehavior._isValidCavalryTarget.
  cavalryFlankSupportRadius: 14.0,
  // Detection radius for "enemy cavalry about to charge" — used by
  // FlankerBehavior to decide whether an enemy cavalry unit is a
  // valid intercept target. Matches the general scale of
  // threatFacing.detectRadius in CombatConfig.
  cavalryThreatDetectRadius: 7.0,

  // --- Battle-line formation ---
  lineUnitSpacing: 4.0,
  supportDepth: 3.5,
  flankLateralOffset: 3.0,
  flankDepth: 1.0,
  slotArrivalRadius: 0.6,

  // --- Team-wide utility / battle assessment ---
  localSuperiorityRadius: 8.0,
  pressStrengthRatio: 1.25,
  retreatStrengthRatio: 0.65,
  pressMoraleAdvantage: 15,
  retreatMoraleAdvantage: -20,

  // Initial battle stance threshold. At battle start, TeamAI commits to
  // 'offence' if the initial strengthRatio is >= this value, otherwise
  // 'defence'. Offence means the line advances in cohesion toward the
  // enemy; defence means the line holds position and lets the enemy
  // come. Committed once and held for the battle — with one exception:
  // if the enemy has a decisive ranged-power advantage, defence is a
  // losing stance from tick 0 (we stand and get shot). See
  // archerPressureFlipRatio below.
  offenceStrengthRatio: 1.0,

  // --- Stance flip under archer pressure ---
  // If the enemy team's summed ranged power is at least this multiple of
  // our own, we are losing the ranged duel and must close to contact
  // rather than stand and be shot. Read in two places:
  //
  //   - At initial stance commit (TeamAI._decide): overrides a
  //     strengthRatio-driven 'defence' choice when the enemy has the
  //     ranged edge from the start.
  //   - On the re-check while _stance === 'defence' (TeamAI._decide):
  //     triggered by a drop in the team's effective-combatant count
  //     (deaths, routs, shatters), which is the moment the tactical
  //     situation has measurably worsened.
  //
  // Once flipped, the stance is 'offence' for the rest of the battle.
  // There is no offence->defence path — the failure mode this exists to
  // prevent is a defensive team standing under sustained arrow fire
  // until it dies, and second-guessing the flip after the next casualty
  // would reproduce exactly that failure.
  //
  // Per-unit contribution is defined by Unit.getRangedPower (alive,
  // non-routing soldiers x per-soldier DPS proxy). Same formula on both
  // sides, so the ratio is apples-to-apples.
  //
  // Interpretation: 1.25 means "enemy has 25% more ranged output than
  // us." Near 1.0 = flip on any enemy ranged advantage (aggressive).
  // Near 2.0 = require being seriously out-shot before committing
  // (conservative). A team with zero ranged units flips under any
  // nonzero enemy ranged power, regardless of this value.
  archerPressureFlipRatio: 1.25,

  // Detection range for the envelopment check, expressed as a multiple
  // of CombatConfig.rangedRange. An enemy unit that is behind or beside
  // our line only triggers the defence->offence flip if its center is
  // within this radius of the NEAREST of our units — a flanker sitting
  // off at 40 units doing nothing is not a threat; a flanker 20 units
  // from our rear rank, walking in, is.
  //
  // 1.5 × 21 = 31.5 world units. Roughly one and a half archer ranges,
  // which is a meaningful fraction of the field at the ranges combat
  // actually resolves at. Tune down to require the flanker to be closer
  // (more conservative, misses late commitments), tune up to react
  // earlier (more aggressive, can false-positive on a spread enemy line).
  envelopmentDetectRangeMult: 1.5,

  // Angle (degrees) from our line's forward axis beyond which an enemy
  // unit counts as "flanking" rather than "in front." 0° = directly in
  // front, 90° = pure side, 180° = directly behind. This replaces a
  // min/max lateral-span test that fired on any enemy line wider than
  // ours even when it was still fully in front — the direct cause of
  // the "flips without anything being behind us" bug.
  //
  // 75° catches flankers as they swing around the side (before they are
  // fully perpendicular), while leaving a straight-but-wider enemy line
  // (typically 10-25° off-axis) well below the trigger.
  envelopmentFlankAngleDeg: 75,

  // Minimum uninterrupted time a single enemy unit must satisfy the
  // envelopment conditions (behind/beside, in detect range, not fighting
  // anyone) before the defence->offence flip fires. Prevents a charging
  // cavalry that briefly crosses our rear arc, or a unit that momentarily
  // reads as "beside" while repositioning, from triggering the flip.
  //
  // 150 ticks = 10 seconds at tickRateHz 15 = 10 decision cycles at
  // decisionIntervalTicks 15. The check itself runs on the decision
  // cadence, so the effective resolution of this timer is one decision
  // cycle. A unit that stops qualifying for even one cycle loses its
  // accumulated hold and restarts from zero if it qualifies again.
  envelopmentMinHoldTicks: 150,

  reinforceLocalOutnumberRatio: 1.3,
  reinforceSearchRadius: 10.0,

  // --- A2: Reinforcement coordination ---
  // Upper bound on what counts as a "winnable" fight. A threatened ally
  // worse than this local ratio receives no reinforcement — the helper
  // would die alongside it. Distinct from reinforceLocalOutnumberRatio,
  // which is the lower bound (below it, no help is needed at all).
  reinforcementMaxWinnableRatio: 3.0,
  // Threat ranking multipliers. A threatened ally whose NEAREST enemy is
  // cavalry, or that is itself ranged, outranks a generic melee threat at
  // the same local ratio — the first is a hard counter, the second a soft
  // target. Applied multiplicatively to the local enemy/ally ratio.
  reinforcementCavalryThreatMult: 1.5,
  reinforcementRangedThreatMult: 1.3,
  // Helper suitability by weapon type, keyed by the dominant enemy weapon
  // type (the nearest enemy's type, not a count-weighted average — the
  // closest enemy is the immediate threat). Higher = better matchup.
  // Missing entries default to 1.0.
  reinforcementSuitability: {
    spear: { cavalry: 1.5, spear: 1.0, sword: 1.0, bow: 1.2 },
    sword: { cavalry: 0.9, spear: 0.8, sword: 1.0, bow: 1.3 }
  },

  retreatUnitHpFraction: 0.35,
  retreatFallbackDist: 8.0,

  // --- Win planning ---
  // A candidate objective only qualifies if this many of our units are
  // within winPlannerSupportRadius of it — prevents the team from adopting
  // a "weak point" that only a lone unit can actually reach, which was the
  // direct cause of "half the infantry flanks an unoccupied target alone".
  winPlannerMinSupportUnits: 2,
  winPlannerSupportRadius: 16.0,
  // How much of the eligible (non-cavalry, non-ranged, not already in
  // melee elsewhere) line force is directed at the WinPlanner objective
  // when one exists, replacing the old weak-point-only bias fraction.
  winPlannerConcentrationFraction: 0.5,
  winPlannerMaxDetourRatio: 2.5,
  // Cavalry only commits to WinPlanner's objective if ChargeReadiness says
  // the charge will plausibly land clean; otherwise cavalry falls back to
  // its own independent soft-target scoring (still routing/ranged-target
  // aware) rather than forcing a doomed charge onto the team objective.
  cavalryRequireCleanCharge: true,

  // Overwhelming-force gate for corridor checks. When a cavalry unit's
  // non-routing alive count is at least this multiple of the non-routing
  // spear-wielding soldiers inside a corridor, the corridor is treated as
  // overwhelmed and the charge (or path) is allowed through regardless of
  // whether the spearmen would brace in time. The intent: one spear cannot
  // block a full cavalry unit; a real spear wall needs real depth to
  // matter, and a single straggler should not veto a massed charge.
  //
  // Read by both ChargeReadiness._countBracedSpearmenInCorridor (the
  // charge corridor) and TeamAI._isCavPathBlockedBySpears (the plan-role
  // move corridor) — same rule, same underlying question.
  //
  // 2.5 means the cav must outnumber the corridor's spears two-and-a-half
  // to one. Raise to require more cavalry per spear (harder to overwhelm);
  // lower to let smaller cav forces punch through a screen.
  corridorOverwhelmingRatio: 2.5,

  // --- A1: Line cohesion ---
  // A line unit's forward goal is capped at (neighborForwardMedian +
  // lineCohesionForwardCapMult * lineUnitSpacing). See LineBehavior's
  // _applyForwardCap and BattleLineFormation's _assignNeighbors.
  lineCohesionForwardCapMult: 2,

  // --- A4: Fragile-unit morale awareness ---
  // A unit whose average living-soldier morale is below this is "fragile":
  // excluded from WinPlanner objective scoring's eligibility for critical
  // roles, excluded from ReinforcementCoordinator's helper pool, and
  // routed to a reserve/rally fallback position instead of continuing
  // normal behavior. Distinct from MoraleConfig.rallyThreshold (85), which
  // governs individual-soldier routing — this is a team-AI-facing read on
  // the unit as a whole, checked far less often (decision cadence, not
  // every tick).
  fragileMoraleThreshold: 30,
  // Once a unit is excluded from plan roles it holds at a rally point this
  // far behind the team's own current line anchor, re-checked each
  // decision cycle so it re-joins normal behavior as soon as its average
  // morale recovers back above fragileMoraleThreshold.
  fragileRallyDepth: 8.0,

  // --- B2: Pin detector ---
  // Per-unit-type thresholds for PinDetector. A single global engaged-
  // fraction would read a 5-wide spear block and a 3-wide archer unit
  // identically — they are not. See PinDetector.js.
  //
  //   engagedFraction — fraction of living soldiers in engaged/staggered
  //                     state required for a pin (lower bound).
  //   driftThreshold  — maximum center-of-mass drift (world units) over
  //                     windowTicks that still counts as "stationary."
  //   windowTicks     — the drift measurement window.
  pinDetector: {
    thresholdsByUnitType: {
      line:    { engagedFraction: 0.60, driftThreshold: 0.40, windowTicks: 15 },
      ranged:  { engagedFraction: 0.50, driftThreshold: 0.60, windowTicks: 15 },
      cavalry: { engagedFraction: 0.70, driftThreshold: 0.80, windowTicks: 15 },
      default: { engagedFraction: 0.60, driftThreshold: 0.50, windowTicks: 15 }
    }
  },

  // --- C3: Posture-conditional profiles ---
  // BattleAssessment.posture ('press' | 'hold' | 'retreat') is computed
  // every assessment cycle but previously only 'retreat' had any effect
  // (LineBehavior._holdOrRetreatLine). This table is what 'press' and
  // 'hold' actually change. 'hold' is deliberately identical to the
  // pre-C3 defaults above — a team at hold posture behaves exactly as the
  // AI always has, so this is additive, not a behavior change for the
  // common case. 'press' loosens concentration and risk parameters so a
  // team that KNOWS it's winning locally commits harder, which is the
  // whole point of computing posture in the first place.
  //
  //   weakPointDetourMult   — multiplies weakPointMaxDetourRatio /
  //                           winPlannerMaxDetourRatio: a pressing team
  //                           will pull units further out of their way to
  //                           concentrate on the objective.
  //   focusFireWoundedOnly  — when true, FocusFireCoordinator only
  //                           considers the wounded-target tier (tier 1);
  //                           when false, it also opens up tier 2/3
  //                           (unshielded / nearest) as equally-eligible
  //                           targets for WeightedSelect to range over —
  //                           i.e. press widens the pool it's willing to
  //                           gamble a volley on instead of always
  //                           finishing the most-wounded target.
  //   chargeReadinessLeniency — subtracted from the braced-defender
  //                           majority threshold in ChargeReadiness: at
  //                           0 a charge aborts if >=50% of sampled
  //                           defenders would brace; press tolerates a
  //                           higher braced fraction before aborting.
  posture: {
    press: {
      weakPointDetourMult: 1.35,
      focusFireWoundedOnly: false,
      chargeReadinessLeniency: 0.15
    },
    hold: {
      weakPointDetourMult: 1.0,
      focusFireWoundedOnly: true,
      chargeReadinessLeniency: 0
    }
  }
};


// ===== behaviorUtils.js =====
// Shared helpers for unit-level AI behaviors. Kept stateless so behaviors
// stay pure and easy to test.

export function nearestUnit(sourceUnit, candidateUnits) {
  const center = sourceUnit.getCenter();
  let best = null;
  let bestDist = Infinity;

  for (const candidate of candidateUnits) {
    const c = candidate.getCenter();
    const dx = c.x - center.x;
    const dz = c.z - center.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }

  return best;
}

// Returns the vector + facing from unit A's center to unit B's center.
// facing is in the same convention used elsewhere (atan2(x, z)).
export function centerTowardUnit(sourceUnit, targetUnit) {
  const a = sourceUnit.getCenter();
  const b = targetUnit.getCenter();
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  return { dx, dz, dist, facing: Math.atan2(dx, dz) };
}

export function unitTypeOf(unit) {
  return unit.soldiers[0]?.unitTypeDef || null;
}

// Average morale fraction (0..1) across a unit's currently-living soldiers.
// Returns 1 (treated as healthy) for a unit with no living soldiers — a
// defeated/empty unit should never register as "fragile" since it isn't
// eligible for anything that reads this in the first place.
export function averageMorale(unit) {
  const alive = unit.getAliveSoldiers();
  if (alive.length === 0) return 100;
  let sum = 0;
  for (const s of alive) sum += s.morale;
  return sum / alive.length;
}

// A4: is this unit's average morale below the fragile threshold? Pure read,
// no side effects — callers decide what to do with the answer (exclude from
// roles, exclude from reinforcement dispatch, route to fallback behavior).
export function isFragile(unit, fragileThreshold) {
  return averageMorale(unit) < fragileThreshold;
}
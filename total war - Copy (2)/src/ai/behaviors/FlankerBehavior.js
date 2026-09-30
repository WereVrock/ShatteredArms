// ===== src/ai/behaviors/FlankerBehavior.js =====
// Cavalry behavior.
//
// Now routing-aware: a routing enemy unit within cavalryRoutingChaseRadius
// is preferred over normal soft-target scoring entirely — these are the
// cheapest kills on the field (see AIConfig comment) and were previously
// invisible to _pickFlankTarget.
//
// A3: sibling coordination is now GROUP-based rather than pairwise. TeamAI
// builds one CavalryGroup per flank cluster (see CavalryGroup.js) and
// passes THIS unit's group in. A follower defers to its group leader's
// target unless it has a strictly better local option (a routing enemy in
// chase range) — this replaces the old pairwise _preferSiblingTarget check,
// which could ping-pong with 3+ cavalry units since there was no single
// source of truth for "what does this flank want."
import { AIConfig } from '../../config/AIConfig.js';
import { CombatConfig } from '../../config/CombatConfig.js';
import { toSimSpeed } from '../../config/SpeedScale.js';
import { isCavalry, isRanged } from '../../config/UnitClasses.js';
import { centerTowardUnit, unitTypeOf } from '../behaviorUtils.js';
import { ChargeReadiness } from '../ChargeReadiness.js';
import { AIDebugLog } from '../AIDebugLog.js';
import { WeightedSelect } from '../WeightedSelect.js';

// Convergence radius for the pure-cavalry mass charge. When the team has
// no melee line and no ranged units, all cavalry converge to within this
// distance of their shared centroid before committing to a charge. Keeps
// a spread formation from arriving piecemeal and being defeated in
// detail by a stationary defender. Overridable via
// AIConfig.massChargeConvergenceRadius — the fallback matches the
// typical width of a 3-unit cavalry wing.
const MASS_CHARGE_CONVERGENCE_RADIUS_FALLBACK = 6.0;

export class FlankerBehavior {
  // group: this unit's CavalryGroup (always contains at least this unit).
  // objectiveUnit: WinPlanner's current shared team objective, or null.
  decide(unit, enemyUnits, context, intent, assessment, worldCtx, group, objectiveUnit) {
    // C3: posture leniency for ChargeReadiness. assessment may be null very
    // early (before first _updateAssessment); leniency 0 there reproduces
    // pre-C3 behavior exactly.
    const leniency = (assessment && assessment.posture === 'press')
      ? (worldCtx.postureChargeLeniency || 0)
      : 0;

    switch (intent.phase) {
      case 'committed':
        return this._decideCommitted(unit, enemyUnits, intent, worldCtx, leniency);
      case 'regrouping':
        return this._decideRegrouping(unit, intent, worldCtx, context);
      case 'seeking':
      default:
        return this._decideSeeking(unit, enemyUnits, context, intent, worldCtx, group, objectiveUnit, leniency);
    }
  }

_decideSeeking(unit, enemyUnits, context, intent, worldCtx, group, objectiveUnit, leniency) {
    // A cavalry unit that has entered melee while in seeking phase — usually
    // because a commit timeout released it from a charge that had already
    // closed to contact — cannot meaningfully seek a new target: the nearest
    // enemy is the one currently hitting it. Route through regroup so a real
    // disengage order is issued by _decideRegrouping next cycle.
    const inMelee = unit.getAliveSoldiers().some(
      s => s.state === 'engaged' || s.state === 'staggered'
    );
    if (inMelee) {
      AIDebugLog.regroup(worldCtx.currentTick, unit.id, 'seeking-in-melee-forcing-regroup');
      intent.beginRegroup(worldCtx.currentTick, intent.targetUnitId);
      return null;
    }

    // Choose a candidate: WinPlanner's shared objective if it passes the
    // cavalry validity filter, otherwise pick our own from the filtered
    // candidate pool. Exactly ONE candidate is chosen before any
    // ChargeReadiness check runs.
    let candidate = null;
    if (objectiveUnit && !objectiveUnit.isDefeated() &&
        this._isValidCavalryTarget(objectiveUnit, unit, worldCtx)) {
      candidate = objectiveUnit;
    } else {
      candidate = this._pickFlankTarget(unit, enemyUnits, group, null, worldCtx);
    }
    // No valid target this cycle. Cavalry holds at its formation flank
    // slot rather than sitting at spawn — this is what actually puts
    // the cavalry on the flank (the formation context supplies the
    // lateral/depth offsets; this method walks the unit there).
    if (!candidate) return this._holdFlankSlot(unit, context, worldCtx);

    // Mass-charge branch. When the team is pure cavalry (no melee line,
    // no ranged units), every readiness gate above is a "wait for a
    // better moment" instruction with no better moment to wait for —
    // there is no line to pin the enemy and no archers to soften it. In
    // that case the cav group converges on its own centroid first, then
    // all units commit directly without the ChargeReadiness check.
    //
    // ChargeReadiness is skipped entirely (not just corridor): the
    // impact-point check is the one refusing the charge in this
    // scenario, since the target spear always faces the approaching cav
    // (with only one enemy unit, the spear's forward axis is by
    // construction aimed at the cav) and is therefore always predicted
    // to brace. Skipping both checks lets the cav actually land the
    // charge; brace-counter damage still applies from
    // CombatResolutionSystem, so this is a genuine trade — cav takes
    // hits from the counter and must win on mass and momentum.
    //
    // The MAX_SOLO_ATTEMPTS gate below is also bypassed: it is designed
    // for solo charge/regroup cycling, not for a group that is
    // deliberately committing to one target.
    if (this._shouldMassCharge(worldCtx)) {
      const staging = this._massChargeStaging(unit, worldCtx);
      if (staging) return staging;

      // Grouped — commit and charge.
      const { dist } = centerTowardUnit(unit, candidate);
      AIDebugLog.chargeCommit(worldCtx.currentTick, unit.id, candidate.id, dist);
      intent.commitTo(candidate.id, worldCtx.currentTick, 0);
      return this._approachOrCharge(unit, candidate, intent, worldCtx);
    }

    // MAX_SOLO_ATTEMPTS: a target that has already survived this many solo
    // charge+regroup cycles is not worth a third identical attempt.
    const MAX_SOLO_ATTEMPTS = 2;
    const priorAttempts = intent.repeatAttemptsByTargetId.get(candidate.id) || 0;
    if (priorAttempts >= MAX_SOLO_ATTEMPTS) {
      AIDebugLog.repeatTargetWarning(worldCtx.currentTick, unit.id, candidate.id, priorAttempts);
      const alternative = this._pickFlankTarget(unit, enemyUnits, group, candidate.id, worldCtx);
      if (!alternative || alternative.id === candidate.id) {
        return null;
      }
      candidate = alternative;
    }

    let target = candidate;

    // Verify the charge is worth taking.
    if (AIConfig.cavalryRequireCleanCharge) {
      const readiness = ChargeReadiness.assess(unit, target, enemyUnits, leniency, worldCtx);
      AIDebugLog.chargeDecision(worldCtx.currentTick, unit.id, target.id, readiness.willLandClean, readiness.reason);
      if (!readiness.willLandClean) {
        const routingFallback = this._nearestRouting(unit, enemyUnits);
        if (routingFallback && routingFallback.id !== target.id &&
            this._isValidCavalryTarget(routingFallback, unit, worldCtx)) {
          AIDebugLog.log('charge', worldCtx.currentTick, `cav=${unit.id} switching to routing target=${routingFallback.id} instead`);
          target = routingFallback;
        } else {
          const alternative = this._pickFlankTarget(unit, enemyUnits, group, target.id, worldCtx);
          let switched = false;
          if (alternative && alternative.id !== target.id) {
            const altReadiness = ChargeReadiness.assess(unit, alternative, enemyUnits, leniency, worldCtx);
            if (altReadiness.willLandClean) {
              AIDebugLog.log('charge', worldCtx.currentTick,
                `cav=${unit.id} switching to alternative target=${alternative.id} (blocked on ${target.id}, reason="${readiness.reason}")`);
              target = alternative;
              switched = true;
            } else {
              AIDebugLog.chargeAbort(worldCtx.currentTick, unit.id,
                `no clean charge on ${target.id} or alternative ${alternative.id}`);
            }
          } else {
            AIDebugLog.chargeAbort(worldCtx.currentTick, unit.id,
              `no clean charge on ${target.id} and no alternative target`);
          }

          if (!switched) {
            // No clean charge available this cycle. The previous
            // behavior held position in place — which left cavalry
            // parked directly in front of a spear wall, re-evaluating
            // the same blocked corridor every decision cycle and never
            // actually extracting itself. It also kept the cav inside
            // the enemy's front, exposed and useless.
            //
            // Instead, fall back to the flank slot: a safe position
            // off to the side of the team's line (and behind it, per
            // the flank role's depthOffset). The intent stays in
            // 'seeking' phase, so a fresh opportunity — a new valid
            // target, or the spears repositioning so the corridor
            // opens — is taken next decision cycle without needing to
            // re-enter seeking. The cav just waits from a defensible
            // position instead of standing in front of the spears.
            const flankOrder = this._holdFlankSlot(unit, context, worldCtx);
            if (flankOrder) return flankOrder;
            // Already at the flank slot (or no context available) —
            // hold with a refreshed order so the unit doesn't drift
            // on a stale move order.
            const center = unit.getCenter();
            return { x: center.x, z: center.z, facing: unit.formationFacing };
          }
        }
      }
    }

    const { dx, dz, dist, facing } = centerTowardUnit(unit, target);
    if (dist <= 0.0001) return null;

    const commitReadiness = ChargeReadiness.assess(unit, target, enemyUnits, 0, worldCtx);
    AIDebugLog.chargeCommit(worldCtx.currentTick, unit.id, target.id, dist);
    intent.commitTo(target.id, worldCtx.currentTick, commitReadiness.bracedCount);
    return this._approachOrCharge(unit, target, intent, worldCtx);
  }

  _decideCommitted(unit, enemyUnits, intent, worldCtx, leniency) {
    const target = enemyUnits.find(u => u.id === intent.targetUnitId);

    if (!target || target.isDefeated()) {
      // Target is dead. Before disengaging to regroup, ask whether a
      // valid next target exists (a second archer unit, a routing enemy,
      // an interceptable charging cavalry unit). If yes, commit to it
      // directly — this is the "archer-1 dies, archer-2 is right there,
      // charge it instead of walking back to flank" case.
      //
      // The original "always regroup on target death" rule existed
      // because falling straight through to seeking meant a cavalry
      // unit might pick an unsupported target from inside the enemy
      // line. `_isValidCavalryTarget` now enforces support (with
      // archers as the deliberate exception), so re-picking is safe:
      // the cav will not select a lone spear unit.
      const nextTarget = this._pickFlankTarget(
        unit, enemyUnits, null, intent.targetUnitId, worldCtx
      );
      if (nextTarget) {
        const nextReadiness = ChargeReadiness.assess(
          unit, nextTarget, enemyUnits, leniency, worldCtx
        );
        if (nextReadiness.willLandClean) {
          AIDebugLog.log('charge', worldCtx.currentTick,
            `cav=${unit.id} RETARGET after kill → ${nextTarget.id} (dist close, clean charge)`);
          intent.commitTo(nextTarget.id, worldCtx.currentTick, nextReadiness.bracedCount);
          return this._approachOrCharge(unit, nextTarget, intent, worldCtx);
        }
        AIDebugLog.log('charge', worldCtx.currentTick,
          `cav=${unit.id} retarget candidate ${nextTarget.id} not clean ("${nextReadiness.reason}") — disengaging`);
      }
      // No viable next target — disengage and reset.
      AIDebugLog.regroup(worldCtx.currentTick, unit.id, 'target-defeated-forcing-regroup');
      intent.beginRegroup(worldCtx.currentTick, intent.targetUnitId);
      return null;
    }

    // Defensive guard: the commit timeout must not release a unit that is
    // already in melee. Releasing to seeking would re-derive the nearest
    // enemy (the infantry currently killing us), fail ChargeReadiness
    // against it, and leave the unit held in place. Route through regroup
    // so an actual disengage order gets issued. TeamAI._shouldStartRegroup
    // already fires this transition for committed cavalry on contact, but
    // this duplicate ensures the timeout path can never bypass it.
    const inMelee = unit.getAliveSoldiers().some(
      s => s.state === 'engaged' || s.state === 'staggered'
    );
    if (inMelee) {
      AIDebugLog.regroup(worldCtx.currentTick, unit.id, 'commit-timeout-melee-guard');
      intent.beginRegroup(worldCtx.currentTick, intent.targetUnitId);
      return null;
    }

    const { dist: distToTarget } = centerTowardUnit(unit, target);

    // Distance-scaled commit timeout. A charge from 30 units at cav sim
    // speed needs ~290 ticks to close; the old fixed 90-tick timeout
    // released the intent mid-approach every ~105 ticks, producing the
    // "cavalry keeps changing its mind" re-commit loop seen in the logs.
    // The timeout is now twice the straight-line time to cover the
    // CURRENT remaining distance — it only fires if the unit has
    // genuinely stalled (blocked, no path), not merely because the
    // target is far.
    const typeDef = unitTypeOf(unit);
    const baseSpeed = typeDef ? typeDef.baseMoveSpeed : 2.6;
    const simSpeed = toSimSpeed(baseSpeed);
    const ticksNeeded = simSpeed > 0
      ? (distToTarget / simSpeed) * CombatConfig.tickRateHz
      : AIConfig.commitTimeoutTicks;
    const commitTimeout = Math.max(AIConfig.commitTimeoutTicks, ticksNeeded * 2);
    if (intent.ticksSinceFormed(worldCtx.currentTick) > commitTimeout) {
      intent.releaseToSeeking(worldCtx.currentTick);
      return null;
    }

    // Re-check charge readiness during the approach. The bug this fixes:
    // a charge committed at 32 units against archers closes to 5-6 units
    // over ~30s while the target's spear screen moves in front of it, and
    // arrives at spears. The commitment was correct at commit time; it is
    // wrong by the time contact happens. Abort to regroup instead.
    //
    // Sampling note: assess() with enemyUnits samples ALL enemies near the
    // target's center (impact point), not just the target unit's own
    // soldiers. This is essential — the target is often archers, who can't
    // brace, and the actual threat is a spear unit that stepped into the
    // path. The wider sample catches them.
    //
    // Only guard: still outside chargeSpotRange. Once inside it the
    // closing time is short enough that aborting makes the unit fly past
    // the target and turn around pointlessly.
    // Mass-charge bypass for the approach re-check. Without this, the
    // very next decision cycle after committing would re-run the same
    // readiness assessment that the seeking branch just bypassed, fail
    // it for the same reason, and abort the charge before the cav has
    // closed half the distance. The whole point of the mass-charge
    // branch is to carry the charge all the way through to contact.
    if (!this._shouldMassCharge(worldCtx) && distToTarget > CombatConfig.chargeSpotRange) {
      const currentReadiness = ChargeReadiness.assess(unit, target, enemyUnits, leniency, worldCtx);
      if (!currentReadiness.willLandClean) {
        AIDebugLog.log('charge', worldCtx.currentTick,
          `cav=${unit.id} ABORT-ON-APPROACH target=${target.id} braced=${currentReadiness.bracedCount}/${currentReadiness.sampledDefenders} reason="${currentReadiness.reason}"`);
        const failedTarget = target.id;
        intent.beginRegroup(worldCtx.currentTick, failedTarget);
        const priorCount = intent.repeatAttemptsByTargetId.get(failedTarget) || 0;
        intent.repeatAttemptsByTargetId.set(failedTarget, priorCount + 1);
        return null;
      }
    }

    return this._approachOrCharge(unit, target, intent, worldCtx);
  }

  _approachOrCharge(unit, target, intent, worldCtx) {
    const { dist, facing } = centerTowardUnit(unit, target);
    if (dist <= 0.0001) return null;

    const tgtCenter = target.getCenter();
    intent.setGoal(tgtCenter.x, tgtCenter.z);
    return { x: tgtCenter.x, z: tgtCenter.z, facing };
  }

// Formation-relative hold. Computes the unit's flank slot as
  // (teamAnchor + right * lateralOffset - forward * depthOffset), using
  // the same forward/right axes and offsets BattleLineFormation supplied
  // for the 'flank' role. Called from _decideSeeking when there's no
  // valid target so cavalry actually deploy to the flank instead of
  // remaining at their spawn position.
  //
  // Returns a move order to the slot, or null if already within arrival
  // radius (in which case the unit stands where it is).
  _holdFlankSlot(unit, context, worldCtx) {
    if (!context || !worldCtx || !worldCtx.teamAnchor) return null;

    const anchor = worldCtx.teamAnchor;
    const slotX = anchor.x
      + context.right.x * context.lateralOffset
      - context.forward.x * context.depthOffset;
    const slotZ = anchor.z
      + context.right.z * context.lateralOffset
      - context.forward.z * context.depthOffset;

    const center = unit.getCenter();
    const dx = slotX - center.x;
    const dz = slotZ - center.z;
    if (Math.sqrt(dx * dx + dz * dz) < AIConfig.slotArrivalRadius) return null;

    return {
      x: slotX,
      z: slotZ,
      facing: context.lineFacing
    };
  }

_decideRegrouping(unit, intent, worldCtx, context) {
    // Release gate: hold-time alone. The previous `_hasEnoughAlliesNearby`
    // gate caused permanent stuck-in-regroup once the regroup destination
    // became the formation FLANK SLOT: the flank is 13+ units off the
    // line, nothing ever comes within regroupTriggerAllyRadius (3.5) of
    // it, so the ally check never became true and the unit never released
    // back to seeking. The hold timer is enough to guarantee the unit has
    // had time to reset before re-picking a target.
    const readyToResume =
      intent.ticksSinceFormed(worldCtx.currentTick) >= AIConfig.regroupHoldTicks;

    if (readyToResume) {
      intent.releaseToSeeking(worldCtx.currentTick);
      return null;
    }

    // Regroup destination preference:
    //   1. Formation flank slot — near the line, where the cavalry is
    //      actually useful. This is the destination after a SUCCESSFUL
    //      charge that killed (or damaged) its target: the unit just
    //      needs to reset, not retreat. Sending it to the deep fallback
    //      point cost ~300 ticks of walking back and then ~300 more
    //      forward again.
    //   2. ownFallbackPoint (deep, behind the team) — only used when no
    //      formation context exists. Preserves the original disengage-
    //      to-safety behavior for the rare case without formation data.
    if (context && worldCtx.teamAnchor) {
      const flankOrder = this._holdFlankSlot(unit, context, worldCtx);
      if (flankOrder) return flankOrder;
      // Already at the flank slot — hold position. Refreshing the order
      // each cycle prevents drift toward a stale formationSlot from a
      // previous move order.
      const center = unit.getCenter();
      return { x: center.x, z: center.z, facing: unit.formationFacing };
    }

    const fallback = worldCtx.ownFallbackPoint;
    if (!fallback) return null;

    const center = unit.getCenter();
    const dx = fallback.x - center.x;
    const dz = fallback.z - center.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < AIConfig.slotArrivalRadius) return null;

    return {
      x: fallback.x,
      z: fallback.z,
      facing: Math.atan2(dx, dz)
    };
  }

  _hasEnoughAlliesNearby(unit, worldCtx) {
    const center = unit.getCenter();
    let allies = 0;
    for (const s of worldCtx.allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.teamId !== unit.teamId) continue;
      if (s.unitId === unit.id) continue;
      const dx = s.pos.x - center.x;
      const dz = s.pos.z - center.z;
      if (dx * dx + dz * dz <= AIConfig.regroupTriggerAllyRadius * AIConfig.regroupTriggerAllyRadius) {
        allies++;
        if (allies >= AIConfig.regroupMinAllies) return true;
      }
    }
    return false;
  }

  // Priority: routing enemy (cheap kill, denies rally) > group leader's
  // current target (A3 coordination) > soft ranged target within factor >
  // nearest any.
  //
  // If this unit IS the group leader (or has no group), it falls through to
  // independent soft-target scoring — the leader is the one who picks for
  // the group, not the one who follows it.
_pickFlankTarget(unit, enemyUnits, group, excludeUnitId, worldCtx) {
    const myCenter = unit.getCenter();
    const raw = excludeUnitId
      ? enemyUnits.filter(u => u.id !== excludeUnitId)
      : enemyUnits;

    // Filter to targets cavalry is allowed to attack at all: near our
    // units, and either ranged, routing, a charging enemy cavalry unit,
    // or already engaged with another unit.
    const candidates = raw.filter(enemy =>
      this._isValidCavalryTarget(enemy, unit, worldCtx)
    );
    if (candidates.length === 0) return null;

    const routingCandidate = this._nearestRouting(unit, candidates);
    if (routingCandidate) return routingCandidate;

    // A3: defer to the group leader's target if we are a follower and the
    // leader has already committed or is seeking a live target.
    if (group && !group.isLeader(unit)) {
      const leaderTarget = this._groupLeaderTarget(group, candidates);
      if (leaderTarget) return leaderTarget;
    }

    let nearestAny = null;
    let nearestAnyDist = Infinity;
    let nearestRanged = null;
    let nearestRangedDist = Infinity;

    for (const enemy of candidates) {
      const ec = enemy.getCenter();
      const dx = ec.x - myCenter.x;
      const dz = ec.z - myCenter.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < nearestAnyDist) {
        nearestAnyDist = dist;
        nearestAny = enemy;
      }

      const type = unitTypeOf(enemy);
      if (type && isRanged(type) && dist < nearestRangedDist) {
        nearestRangedDist = dist;
        nearestRanged = enemy;
      }
    }

    if (!nearestAny) return null;

    // B4 retrofit: weighted-pick between ranged and nearest when the
    // ranged target is within the soft-target distance factor.
    if (nearestRanged &&
        nearestRangedDist <= nearestAnyDist * AIConfig.cavalrySoftTargetDistanceFactor) {
      const options = [
        { unit: nearestRanged, score: 1.0 },
        { unit: nearestAny, score: 0.6 }
      ];
      const picked = WeightedSelect.pick(options, {
        getScore: (o) => o.score,
        qualityFloorFraction: 1.0,
        temperature: 0.6
      });
      return picked ? picked.unit : nearestRanged;
    }

    return nearestAny;
  }

  _nearestRouting(unit, enemyUnits) {
    const myCenter = unit.getCenter();
    let best = null;
    let bestDist = Infinity;
    for (const enemy of enemyUnits) {
      const soldiers = enemy.getAliveSoldiers();
      if (soldiers.length === 0) continue;
      const routingCount = soldiers.filter(s => s.isRouting).length;
      if (routingCount / soldiers.length < 0.5) continue; // unit as a whole is routing, not one straggler

      const ec = enemy.getCenter();
      const dx = ec.x - myCenter.x;
      const dz = ec.z - myCenter.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AIConfig.cavalryRoutingChaseRadius) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = enemy;
      }
    }
    return best;
  }

  // Reads the group leader's OWN intent (seeking or committed target) and
  // returns that enemy unit if it's still a valid candidate. Returns null
  // if the leader has no live target yet, so the follower falls through to
  // its own independent scoring for this cycle (it will pick up the
  // leader's target next cycle once the leader has one).
  _groupLeaderTarget(group, candidates) {
    const leaderIntent = group.leader.intent;
    if (!leaderIntent) return null;
    if (leaderIntent.phase !== 'seeking' && leaderIntent.phase !== 'committed') return null;
    if (!leaderIntent.targetUnitId) return null;

    const target = candidates.find(u => u.id === leaderIntent.targetUnitId);
    if (!target || target.isDefeated()) return null;
    return target;
  }

  // Cavalry target validity: what is this unit ALLOWED to attack?
  //
  // - Archers/ranged: always valid — an open archer unit is a legitimate
  //   cavalry target even with no friendly unit anywhere near it. Chasing
  //   down unguarded archers is one of cavalry's core jobs; requiring the
  //   archers to be near our line would make it impossible.
  // - No-melee-line exemption: when this team currently fields zero living
  //   spear/sword units of its own, EVERY non-ranged enemy becomes valid,
  //   regardless of friendly-support or engaged-state. See the comment in
  //   the body for the reasoning. This branch short-circuits the
  //   friendly-support gate and the engaged-state gate below.
  // - Routing enemy units: valid (cheap kills, existing priority).
  // - Enemy cavalry charging an AI unit: valid intercept.
  // - Everyone else (spear/sword line units): only if already engaged
  //   with another unit — cavalry does not initiate against a standing
  //   line, it exploits one that is already fighting.
  //
  // For teams WITH a melee line, every non-archer target must be close to
  // an existing AI unit — cavalry supports the line against melee threats,
  // it does not go on solo raids against unengaged melee units far from
  // the army. See AIConfig.cavalryFlankSupportRadius.
  _isValidCavalryTarget(enemy, unit, worldCtx) {
    if (enemy.isDefeated()) return false;

    const type = unitTypeOf(enemy);
    if (!type) return false;

    // Archers are exempt from every other gate — an open archer unit is
    // exactly the target cavalry should be hunting.
    if (isRanged(type)) return true;

    // No-melee-line exemption, checked FIRST after the ranged branch.
    //
    // When this team currently fields zero living spear/sword units of its
    // own, both of the remaining gates below are meaningless:
    //
    //   - _hasFriendlySupport asks "is some OTHER friendly unit near this
    //     enemy?" In a pure-cav (or cav + archer) team there is no line to
    //     anchor around, and the cav itself is deliberately excluded from
    //     the check. In the cav-vs-spear scenario this gate was always
    //     false, so the exemption never fired even though it existed below
    //     it — the cav walked off the map holding a flank slot instead.
    //
    //   - The engaged-state requirement asks "is the enemy already pinned
    //     by someone else?" With no melee line, nobody can pin anyone.
    //
    // Original ordering placed this check AFTER both gates, which is why a
    // pure-cav team never received the exemption it was written for.
    //
    // Priority preservation is unaffected: _pickFlankTarget still runs
    // _nearestRouting FIRST on the widened candidate set, so a routing
    // enemy is still the preferred pick. Enemy cav about to charge is
    // still picked up via the _isAboutToCharge branch during outer
    // seeking, not via this predicate. This method only answers "is this
    // enemy legal at all" — with no line of our own, every non-ranged
    // enemy is.
    if (!this._teamHasMeleeLine(worldCtx)) return true;

    if (!this._hasFriendlySupport(enemy, unit, worldCtx)) return false;

    const soldiers = enemy.getAliveSoldiers();
    if (soldiers.length === 0) return false;

    const routingCount = soldiers.filter(s => s.isRouting).length;
    if (routingCount / soldiers.length >= 0.5) return true;

    if (isCavalry(type) && this._isAboutToCharge(enemy, unit, worldCtx)) return true;

    return soldiers.some(s => s.state === 'engaged' || s.state === 'staggered');
  }

  // Does this unit's team currently field any living spear/sword (i.e.
  // non-cavalry, non-ranged) units? Used by _isValidCavalryTarget to
  // decide whether cavalry must take on standing enemy melee units
  // itself.
  //
  // Reads worldCtx.infantryLineUnits when present. TeamAI's
  // _computeInfantryLineData always populates it (possibly with an
  // empty array when the team is all-cav / cav+archer), so the normal
  // path is a cheap iteration over the line-unit list.
  //
  // If the field is missing entirely — a stripped-down worldCtx from
  // some other caller — default to TRUE: assume a melee line exists
  // and do NOT grant the exemption. The exemption widens cavalry's
  // target set, so the conservative default when we cannot tell is
  // the original rule.
  _teamHasMeleeLine(worldCtx) {
    if (!worldCtx || !Array.isArray(worldCtx.infantryLineUnits)) return true;
    for (const u of worldCtx.infantryLineUnits) {
      if (!u.isDefeated()) return true;
    }
    return false;
  }

  // Is this enemy unit close enough to one of our OTHER units for the
  // cavalry to consider it a supported target? Excludes the cavalry
  // unit itself — "near existing AI units" means near the line, not
  // near this cavalry unit alone.
  _hasFriendlySupport(enemy, unit, worldCtx) {
    if (!worldCtx || !worldCtx.allSoldiers) return true;
    const center = enemy.getCenter();
    const radius = AIConfig.cavalryFlankSupportRadius;
    const radiusSq = radius * radius;
    for (const s of worldCtx.allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.teamId !== unit.teamId) continue;
      if (s.unitId === unit.id) continue;
      const dx = s.pos.x - center.x;
      const dz = s.pos.z - center.z;
      if (dx * dx + dz * dz <= radiusSq) return true;
    }
    return false;
  }

  // True when this team has no melee line AND no ranged units. Reads the
  // same composition fields ChargeReadiness uses for its corridor-skip
  // policy, so the two stay in sync — the mass-charge condition is a
  // strict superset of the corridor-skip's no-offensive-options
  // condition (it also fires when the target isn't a spear).
  //
  // Missing fields default to true (line exists, ranged exists) so an
  // unexpected worldCtx shape does not accidentally trigger mass charge.
  // The failure mode of a false negative here is "cav holds at flank
  // slot" — the same behavior the code had before this patch. The
  // failure mode of a false positive would be "cav throws itself at a
  // prepared spear wall it should have waited on," so the conservative
  // default is the right one.
  _shouldMassCharge(worldCtx) {
    if (!worldCtx) return false;
    if (this._hasAliveLineUnit(worldCtx)) return false;
    if (this._hasAliveRangedUnit(worldCtx)) return false;
    return true;
  }

  _hasAliveLineUnit(worldCtx) {
    if (!Array.isArray(worldCtx.infantryLineUnits)) return true;
    for (const u of worldCtx.infantryLineUnits) {
      if (!u.isDefeated()) return true;
    }
    return false;
  }

  _hasAliveRangedUnit(worldCtx) {
    if (!Array.isArray(worldCtx.rangedUnits)) return true;
    for (const u of worldCtx.rangedUnits) {
      if (!u.isDefeated()) return true;
    }
    return false;
  }

  // Mean center of this team's living cavalry units. Used by the mass-
  // charge staging step: each cav moves toward this point until all are
  // within MASS_CHARGE_CONVERGENCE_RADIUS of it, then all commit.
  //
  // Deliberately reads only cavalry — the staging point is a cavalry-
  // only rendezvous, not a team anchor. The team anchor (which is used
  // by _holdFlankSlot and can degenerate to the cav's own position when
  // no non-cav units survive) is not consulted here, so this method
  // behaves correctly in exactly the composition where the team anchor
  // is unreliable.
  _cavGroupCentroid(worldCtx) {
    if (!worldCtx || !Array.isArray(worldCtx.teamUnits)) return null;
    let sx = 0, sz = 0, count = 0;
    for (const u of worldCtx.teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || !isCavalry(t)) continue;
      const c = u.getCenter();
      sx += c.x;
      sz += c.z;
      count++;
    }
    if (count === 0) return null;
    return { x: sx / count, z: sz / count };
  }

  // Returns a move order toward the cav group centroid if this unit is
  // still too far from it, or null if the group has converged (in which
  // case the caller should commit to the charge).
  //
  // A single cav is trivially converged — its own position is the
  // centroid — so this returns null and the lone cav charges
  // immediately, matching "if there is only cavalry left, charge
  // directly" without requiring siblings to exist.
  _massChargeStaging(unit, worldCtx) {
    const centroid = this._cavGroupCentroid(worldCtx);
    if (!centroid) return null;

    const center = unit.getCenter();
    const dx = centroid.x - center.x;
    const dz = centroid.z - center.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const radius = (AIConfig && AIConfig.massChargeConvergenceRadius) != null
      ? AIConfig.massChargeConvergenceRadius
      : MASS_CHARGE_CONVERGENCE_RADIUS_FALLBACK;
    if (dist <= radius) return null;

    return {
      x: centroid.x,
      z: centroid.z,
      facing: Math.atan2(dx, dz)
    };
  }

  // Is this enemy cavalry unit currently moving fast enough to count as
  // charging, AND close enough to one of our units that we should
  // intercept? Reuses the same speed threshold as charge detection so
  // "about to charge" means the same thing everywhere.
  _isAboutToCharge(enemyUnit, unit, worldCtx) {
    if (!worldCtx || !worldCtx.allSoldiers) return false;
    const speedThreshold = toSimSpeed(CombatConfig.charge.speedThreshold);
    const soldiers = enemyUnit.getAliveSoldiers();
    const chargers = soldiers.filter(s => s.currentSpeed >= speedThreshold);
    if (chargers.length === 0) return false;

    const radius = AIConfig.cavalryThreatDetectRadius;
    const radiusSq = radius * radius;
    for (const s of worldCtx.allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.teamId !== unit.teamId) continue;
      for (const charger of chargers) {
        const dx = charger.pos.x - s.pos.x;
        const dz = charger.pos.z - s.pos.z;
        if (dx * dx + dz * dz <= radiusSq) return true;
      }
    }
    return false;
  }

}
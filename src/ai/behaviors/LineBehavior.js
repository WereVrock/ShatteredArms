// ===== LineBehavior.js =====
// Spear/sword line infantry behavior.
//
// Weak-point aware: a configurable fraction of line units bias toward
// the enemy's weakest slice (see EnemyLineAnalysis) instead of their own
// nearest enemy, so the team concentrates force somewhere rather than
// every unit grinding 1:1 along a flat front. Only diverts within a
// bounded detour ratio so a far-side unit doesn't abandon its own sector.
//
// Anchor-hold aware: under 'retreat' team posture, healthy line units
// hold in place rather than continuing to advance toward their forward
// slot; low-HP units withdraw.
//
// Line cohesion during approach (this revision): while further than
// AIConfig.lineCohesionApproachDist from the nearest enemy, EVERY line
// unit walks to its assigned slot on a SHARED line anchored on the enemy
// mean position (plus that unit's own lateral offset). Previously each
// line unit anchored its goal on its own individual target's center, so
// units with different targets spread the line into a cloud during the
// approach. Once any enemy is within lineCohesionApproachDist, normal
// target-based behavior takes over.
//
// Coherent retreat (this revision): retreating (low-HP) line units fall
// back to their slot on a SHARED retreat line, anchored on the team's
// mean position, offset backward by retreatFallbackDist along the line's
// forward axis, plus each unit's own lateral offset. Previously each
// retreating unit moved back the same distance from its own (possibly
// already spread-out) current position, so a mass retreat preserved the
// spread instead of reforming the line. Healthy units hold where they
// are with an explicit refreshed order.
import { AIConfig } from '../../config/AIConfig.js';
import { nearestUnit, centerTowardUnit, unitTypeOf } from '../behaviorUtils.js';
import { isSwordsmen, isRanged } from '../../config/UnitClasses.js';
import { AIDebugLog } from '../AIDebugLog.js';
import { LineAssault } from './LineAssault.js';

export class LineBehavior {
  // weakPointTarget: Unit|null — this unit's assigned weak-point target for
  // this decision interval, or null if it's not one of the units biased
  // toward concentration this round (see TeamAI._assignWeakPointBias).
  decide(unit, enemyUnits, context, intent, assessment, worldCtx, weakPointTarget) {
    if (assessment && assessment.posture === 'retreat') {
      const holdOrRetreat = this._holdOrRetreatLine(unit, context, worldCtx);
      if (holdOrRetreat) return holdOrRetreat;
    }

    // Swordsman anti-archer aggression. Runs AFTER retreat (a retreating
    // swordsman does not break formation to chase a fight it is trying
    // to leave) and BEFORE stance / cohesion (a swordsman sitting on
    // defence stance, or marching in cohesion, is exactly the case this
    // rule targets). When an enemy ranged unit is within
    // AIConfig.swordsmanArcherChargeDist, the swordsman breaks formation
    // and runs at it — archers caught by swordsmen are close to free
    // kills, and the line's normal target selection has no way to
    // express "the archer unit is a better target than the melee unit
    // in front of me right now".
    const archerCharge = this._pickArcherChargeTarget(unit, enemyUnits);
    if (archerCharge) {
      const abortReason = this._swordrushAbortReason(unit, archerCharge, enemyUnits, worldCtx);
      if (abortReason) {
        // Chase aborted — the archer is no longer an exposed straggler,
        // or the swordsman has drifted too far from its own line to
        // survive. Clear the sticky target so the fall-through to normal
        // behavior doesn't immediately re-lock onto the same archer.
        intent.targetUnitId = null;
        AIDebugLog.log('swordrush', 0,
          `unit=${unit.id} ABORT archer=${archerCharge.id} reason="${abortReason}"`);
      } else {
        const myCenter = unit.getCenter();
        const { dx, dz, dist, facing } = centerTowardUnit(unit, archerCharge);
        const stopDist = AIConfig.lineApproachStopDist;

        // Set the intent so the sticky-target logic does not immediately
        // re-point the unit at whatever melee target it previously held.
        // The stickiness keeps the swordsman on the archer across cycles
        // even as the archer moves, until either the archer dies or
        // steps back outside swordsmanArcherChargeDist.
        intent.targetUnitId = archerCharge.id;

        if (dist <= stopDist) {
          // Already at melee range. Return a no-op order rather than null
          // so TeamAI does not fall through to its secondary decide()
          // call and re-derive the same archer at the same distance.
          // TargetingSystem handles the actual engagement on the next tick.
          return { x: myCenter.x, z: myCenter.z, facing: unit.formationFacing };
        }

        const tgtCenter = archerCharge.getCenter();
        const fwdX = dx / dist;
        const fwdZ = dz / dist;
        AIDebugLog.log('swordrush', 0,
          `unit=${unit.id} charge-archer=${archerCharge.id} dist=${dist.toFixed(2)}`);
        return {
          x: tgtCenter.x - fwdX * stopDist,
          z: tgtCenter.z - fwdZ * stopDist,
          facing
        };
      }
    }

    // Defence stance: hold the line in place and let the enemy come to
    // us. The team's initial stance is committed once at battle start
    // (see TeamAI._decide) and does not flip mid-battle. Retreat posture
    // (above) takes precedence — a defensive team that's assessed as
    // losing withdraws rather than merely holding.
    // Line under attack (see LineAlarmDetector): the line is already
    // fighting, so every free line unit closes with the enemy directly
    // instead of holding, or walking to a shared slot while a neighbour is
    // ground down alone. Runs AFTER retreat (a retreating team still
    // withdraws) and BEFORE defence hold / cohesion / forward cap, which are
    // exactly the rules that kept units passive. Returns null only when
    // there is no valid target, in which case normal behavior continues.
    // Ranged pressure (see RangedPressureDetector) uses the same assault
    // but only against the shooters (rangedPressureTargets). The generic
    // nearest-enemy fallback is allowed only when the line alarm is on.
    if (worldCtx && (worldCtx.lineUnderAttack || worldCtx.rangedPressureTargets)) {
      const assignedFocus = worldCtx.rangedPressureAssignments
        ? worldCtx.rangedPressureAssignments.get(unit.id) || null
        : null;
      const assaultOrder = LineAssault.decide(
        unit, enemyUnits, intent,
        worldCtx.rangedPressureTargets || null,
        !!worldCtx.lineUnderAttack,
        assignedFocus,
        worldCtx
      );
      if (assaultOrder) return assaultOrder;
    }

    // Defence hold, unless the ranged tether has been exceeded. When
    // our archers have sallied past the tether distance to return fire,
    // holding here would leave them without cover — the exact failure
    // the hug rule exists to prevent. The correct response is not to
    // drag the archers back (which would silence them again), but to
    // walk the line forward so the cover follows. Skipping the hold
    // falls through to the cohesion approach below, which advances
    // toward the shared line slot anchored on the enemy mean. Once the
    // archers are back inside the tether, rangedOverextended clears and
    // this hold resumes.
    if (worldCtx && worldCtx.stance === 'defence' && !worldCtx.rangedOverextended) {
      return this._holdInPlace(unit, context);
    }

    // Line-cohesion approach. While still far from the nearest enemy,
    // walk to this unit's slot on the SHARED line rather than directly
    // toward its own target. Keeps the formation coherent until contact.
    // Skipped when no context exists (unit has no formation slot) — the
    // target-based path below handles that case.
    if (context && enemyUnits.length > 0) {
      const nearest = nearestUnit(unit, enemyUnits);
      if (nearest) {
        const { dist: nearestDist } = centerTowardUnit(unit, nearest);
        if (nearestDist > AIConfig.lineCohesionApproachDist) {
          const slotOrder = this._moveToLineSlot(unit, context, enemyUnits);
          if (slotOrder) {
            // Forward-cap the cohesion slot as well as the target-based
            // goal. Without this, a unit that started nearer the enemy
            // reaches the shared line first, its neighbor lags, and the
            // "line" stretches during the approach even though the goal
            // itself is shared. The cap never commands a retreat, it
            // only throttles advance.
            const capped = this._applyForwardCap(slotOrder.x, slotOrder.z, unit, context);
            return { x: capped.x, z: capped.z, facing: slotOrder.facing };
          }
          // Already at the shared line slot, still outside engagement
          // range. Hold formation facing forward and return — do NOT
          // fall through to the target-based path. _moveToLineSlot
          // returns null both when there are no enemies (legitimate
          // fall-through) and when the unit has ARRIVED at its slot
          // (must hold). Conflating the two is what broke the line
          // apart on contact: as soon as a unit reached the shared
          // line it took the target-based path and anchored its next
          // goal on its own individual target, snapping the formation
          // back into a per-unit chase.
          const c = unit.getCenter();
          return { x: c.x, z: c.z, facing: context.lineFacing };
        }
      }
    }

    const target = this._resolveTarget(unit, enemyUnits, intent, weakPointTarget);
    if (!target) return null;

    const { dx, dz, dist, facing } = centerTowardUnit(unit, target);
    if (dist <= 0.0001) return null;

    const stopDist = AIConfig.lineApproachStopDist;
    if (dist <= stopDist) return null;

    const tgtCenter = target.getCenter();
    const fwdX = dx / dist;
    const fwdZ = dz / dist;

    let goalX = tgtCenter.x - fwdX * stopDist;
    let goalZ = tgtCenter.z - fwdZ * stopDist;

    if (context) {
      goalX += context.right.x * context.lateralOffset;
      goalZ += context.right.z * context.lateralOffset;
      goalX -= context.forward.x * context.depthOffset;
      goalZ -= context.forward.z * context.depthOffset;
    }

    // A1 line cohesion: cap how far ahead of its neighbours this unit may
    // target. A unit at the line's leading edge holds position until the
    // line catches up, instead of outrunning its neighbours and arriving
    // alone to be flanked.
    const capped = this._applyForwardCap(goalX, goalZ, unit, context);
    goalX = capped.x;
    goalZ = capped.z;

    if (context) {
      const myCenter = unit.getCenter();
      const dgx = goalX - myCenter.x;
      const dgz = goalZ - myCenter.z;
      if (Math.sqrt(dgx * dgx + dgz * dgz) < AIConfig.slotArrivalRadius) return null;
    }

    return { x: goalX, z: goalZ, facing };
  }

  // Swordsman anti-archer aggression. Returns the nearest enemy RANGED
  // unit within AIConfig.swordsmanArcherChargeDist of this unit's center,
  // or null if there is none. Gated on the unit being a swordsman — a
  // spear unit is deliberately excluded, because the spear's own reach
  // and formation (a wall of shafts) is a line weapon, not an anti-archer
  // tool; sending spears out of formation after archers is what the
  // cohesion rules exist to prevent. Cavalry has its own archer-hunting
  // path in FlankerBehavior (archers are always a valid cavalry target),
  // and skirmishers obviously do not chase other skirmishers.
  //
  // "Nearest" not "weakest" — the point of this rule is to punish archers
  // that have come too close, not to select the best archer target from
  // any distance. The distance gate does the selection work; among
  // archers within that gate, closest is both the most reachable and the
  // most threatening.
  _pickArcherChargeTarget(unit, enemyUnits) {
    const type = unitTypeOf(unit);
    if (!type || !isSwordsmen(type)) return null;

    // Approach-phase gate. Don't start a chase while the line is still
    // walking toward the enemy — the swordsman hasn't earned a reason to
    // break formation yet, and committing before contact is how a
    // swordsman ends up 40 units from its own line chasing an archer
    // that simply walks away. Only when the swordsman is within
    // lineCohesionApproachDist of the nearest enemy (i.e., the line is
    // about to engage) does it become willing to break formation for an
    // archer.
    const nearestEnemy = nearestUnit(unit, enemyUnits);
    if (nearestEnemy) {
      const { dist: nearestDist } = centerTowardUnit(unit, nearestEnemy);
      if (nearestDist > AIConfig.lineCohesionApproachDist) return null;
    }

    const myCenter = unit.getCenter();
    const maxSq = AIConfig.swordsmanArcherChargeDist * AIConfig.swordsmanArcherChargeDist;

    let best = null;
    let bestDistSq = Infinity;
    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      const et = unitTypeOf(enemy);
      if (!et || !isRanged(et)) continue;
      const ec = enemy.getCenter();
      const dx = ec.x - myCenter.x;
      const dz = ec.z - myCenter.z;
      const dSq = dx * dx + dz * dz;
      if (dSq > maxSq) continue;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = enemy;
      }
    }
    return best;
  }

// Returns a reason string if the swordsman's current archer chase should
  // abort, or null if the chase is still valid. Called every cycle while a
  // chase is in progress.
  //
  // Two conditions abort:
  //   - The archer target is now supported by other non-routing enemy
  //     units nearby. It's no longer a lone straggler; it's part of a
  //     formation the swordsman would be walking into alone.
  //   - The swordsman has drifted too far from its own team anchor.
  //     Distance is measured from the anchor, not from where the chase
  //     started — a swordsman that has wiggled around in the same spot
  //     for 600 ticks without advancing is still chasing, but a
  //     swordsman 30 units behind the enemy line is not.
  _swordrushAbortReason(unit, archerTarget, enemyUnits, worldCtx) {
    if (this._archerHasNearbySupport(archerTarget, enemyUnits)) {
      return 'archer-supported';
    }
    if (worldCtx && worldCtx.teamAnchor) {
      const c = unit.getCenter();
      const a = worldCtx.teamAnchor;
      const dx = c.x - a.x;
      const dz = c.z - a.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AIConfig.swordsmanArcherMaxChaseDist) {
        return `too-far-from-line(${dist.toFixed(1)}>${AIConfig.swordsmanArcherMaxChaseDist})`;
      }
    }
    return null;
  }

  // True when the archer target has any non-routing, non-defeated enemy
  // unit other than itself within swordsmanArcherSupportRadius. Routed or
  // mostly-routing units do not count — a broken unit is not protecting
  // anything.
  //
  // "Support" here is deliberately broad: it includes other archers, not
  // just melee. Two archer units standing together can focus-fire a
  // swordsman down before it closes, and more importantly, an archer
  // standing next to ANY enemy unit is inside the enemy formation, not
  // an exposed straggler. The swordrush exists to punish exposure; the
  // moment the archer is back inside its own army, the rule should stop
  // applying.
  _archerHasNearbySupport(archerTarget, enemyUnits) {
    const c = archerTarget.getCenter();
    const radius = AIConfig.swordsmanArcherSupportRadius;
    const radiusSq = radius * radius;
    for (const enemy of enemyUnits) {
      if (enemy.id === archerTarget.id) continue;
      if (enemy.isDefeated()) continue;
      const alive = enemy.getAliveSoldiers();
      if (alive.length === 0) continue;
      let routing = 0;
      for (const s of alive) {
        if (s.isRouting) routing++;
      }
      if (routing / alive.length >= 0.5) continue;
      const ec = enemy.getCenter();
      const dx = ec.x - c.x;
      const dz = ec.z - c.z;
      if (dx * dx + dz * dz <= radiusSq) return true;
    }
    return false;
  }

// Shared-line approach slot. Every line unit computes its slot from the
  // SAME anchor (mean enemy center), so the line forms coherently instead
  // of each unit anchoring on its own individual target's center.
  //
  //   slot = enemyMean - forward * stopDist + right * lateralOffset
  //
  // The forward/right axes come from BattleLineFormation's context, so
  // "forward" is the line's own forward (team mean → enemy mean) and
  // "lateral offset" is the same one BattleLineFormation assigned for the
  // unit's front-role slot. This is what lets the line advance as a line.
  _moveToLineSlot(unit, context, enemyUnits) {
    let ex = 0, ez = 0, count = 0;
    for (const e of enemyUnits) {
      if (e.isDefeated()) continue;
      const c = e.getCenter();
      ex += c.x;
      ez += c.z;
      count++;
    }
    if (count === 0) return null;
    ex /= count;
    ez /= count;

    const stopDist = AIConfig.lineApproachStopDist;
    const slotX = ex - context.forward.x * stopDist
                + context.right.x * context.lateralOffset;
    const slotZ = ez - context.forward.z * stopDist
                + context.right.z * context.lateralOffset;

    const myCenter = unit.getCenter();
    const dx = slotX - myCenter.x;
    const dz = slotZ - myCenter.z;
    if (Math.sqrt(dx * dx + dz * dz) < AIConfig.slotArrivalRadius) return null;

    return { x: slotX, z: slotZ, facing: context.lineFacing };
  }

  // A1: caps the goal's forward-axis position at
  // (neighborForwardMedian + 2 * lineUnitSpacing). The cap is floored at
  // the unit's OWN current forward position, so a unit already past the
  // cap holds where it is rather than being commanded backward — the cap
  // throttles advance, it never reverses it.
  //
  // Neighbour data comes from BattleLineFormation via context. Units with
  // no neighbour set (flank/cavalry, or a sole surviving line unit) are
  // returned unchanged.
  _applyForwardCap(goalX, goalZ, unit, context) {
    if (!context ||
        context.neighborForwardMedian === null ||
        context.neighborForwardMedian === undefined) {
      return { x: goalX, z: goalZ };
    }

    const fwdX = context.forward.x;
    const fwdZ = context.forward.z;

    const myCenter = unit.getCenter();
    const myForward = myCenter.x * fwdX + myCenter.z * fwdZ;
    const goalForward = goalX * fwdX + goalZ * fwdZ;

    const capDistance = 2 * AIConfig.lineUnitSpacing;
    const capForward = Math.max(myForward, context.neighborForwardMedian + capDistance);

    if (goalForward > capForward) {
      const excess = goalForward - capForward;
      return {
        x: goalX - fwdX * excess,
        z: goalZ - fwdZ * excess
      };
    }

    return { x: goalX, z: goalZ };
  }

  // Resolution order: explicit weak-point assignment (if given and still
  // alive) takes priority over the sticky-nearest logic, but is itself
  // subject to the same "don't twitch" stickiness once adopted — intent
  // still stores whichever target was actually chosen.
  _resolveTarget(unit, enemyUnits, intent, weakPointTarget) {
    if (weakPointTarget && !weakPointTarget.isDefeated()) {
      intent.targetUnitId = weakPointTarget.id;
      return weakPointTarget;
    }

    const currentTarget = intent.targetUnitId
      ? enemyUnits.find(u => u.id === intent.targetUnitId && !u.isDefeated())
      : null;

    const nearest = nearestUnit(unit, enemyUnits);
    if (!nearest) {
      intent.targetUnitId = null;
      return null;
    }

    if (!currentTarget) {
      intent.targetUnitId = nearest.id;
      return nearest;
    }

    if (currentTarget.id === nearest.id) return currentTarget;

    const { dist: distCurrent } = centerTowardUnit(unit, currentTarget);
    const { dist: distNearest } = centerTowardUnit(unit, nearest);

    if (distNearest < distCurrent * AIConfig.lineTargetSwitchMargin) {
      intent.targetUnitId = nearest.id;
      return nearest;
    }

    return currentTarget;
  }

  // Retreat posture: individually low-HP units fall back to their slot on
  // a SHARED retreat line; healthy units hold at their current position.
  // Retreat line is anchored on the team's mean position, offset backward
  // by retreatFallbackDist along the line's forward axis, with each
  // unit's own lateral offset preserved — so a withdrawal keeps the
  // line's lateral structure instead of every unit retreating the same
  // distance from its own (possibly already spread-out) current position.
  //
  // Both branches return a non-null order, so retreating units never fall
  // through to target-based behavior while posture is retreat.
  _holdOrRetreatLine(unit, context, worldCtx) {
    const alive = unit.getAliveSoldiers();
    if (alive.length === 0) return null;

    const avgHpFraction = alive.reduce((sum, s) => sum + s.hp / s.maxHp, 0) / alive.length;

    if (avgHpFraction <= AIConfig.retreatUnitHpFraction) {
      const slotOrder = this._retreatSlotOrder(unit, context, worldCtx);
      if (slotOrder) return slotOrder;
      // Already at the retreat slot (or no anchor available) — hold with
      // a refreshed order so we don't fall through to target-based
      // behavior while still in retreat posture.
      const center = unit.getCenter();
      return { x: center.x, z: center.z, facing: unit.formationFacing };
    }

    // Healthy unit, team posture retreat: hold current ground. The
    // explicit hold order (rather than null) refreshes the formation slot
    // every cycle so a healthy unit doesn't sit executing a stale move
    // order from a previous cycle.
    const center = unit.getCenter();
    return { x: center.x, z: center.z, facing: unit.formationFacing };
  }

  // Shared retreat slot: teamAnchor - forward * retreatFallbackDist
  // (+ this unit's lateral offset along the line's right axis).
  //
  // Falls back to the previous per-unit straight-back-from-current-
  // position behavior when no context or teamAnchor is available (e.g.
  // formation was not constructed). That fallback does not preserve line
  // coherence — it exists only so retreat still functions in scenarios
  // without formation data.
  _retreatSlotOrder(unit, context, worldCtx) {
    if (!context || !worldCtx || !worldCtx.teamAnchor) {
      const center = unit.getCenter();
      const backX = context ? -context.forward.x : -Math.sin(unit.formationFacing);
      const backZ = context ? -context.forward.z : -Math.cos(unit.formationFacing);
      const goalX = center.x + backX * AIConfig.retreatFallbackDist;
      const goalZ = center.z + backZ * AIConfig.retreatFallbackDist;
      const dgx = goalX - center.x;
      const dgz = goalZ - center.z;
      if (Math.sqrt(dgx * dgx + dgz * dgz) < AIConfig.slotArrivalRadius) return null;
      return {
        x: goalX,
        z: goalZ,
        facing: Math.atan2(-backX, -backZ)
      };
    }

    const anchor = worldCtx.teamAnchor;
    const backX = -context.forward.x;
    const backZ = -context.forward.z;

    const lineX = anchor.x + backX * AIConfig.retreatFallbackDist;
    const lineZ = anchor.z + backZ * AIConfig.retreatFallbackDist;

    const slotX = lineX + context.right.x * context.lateralOffset;
    const slotZ = lineZ + context.right.z * context.lateralOffset;

    const center = unit.getCenter();
    const dx = slotX - center.x;
    const dz = slotZ - center.z;
    if (Math.sqrt(dx * dx + dz * dz) < AIConfig.slotArrivalRadius) return null;

    return {
      x: slotX,
      z: slotZ,
      facing: Math.atan2(-backX, -backZ)
    };
  }

  // Defence stance: hold the line in place at the current position,
  // facing the team's forward axis (toward the enemy center). The
  // explicit hold order (rather than returning null) refreshes the
  // formationSlot every cycle so the unit doesn't drift toward a stale
  // destination from an earlier move order.
  _holdInPlace(unit, context) {
    const center = unit.getCenter();
    const facing = context
      ? Math.atan2(context.forward.x, context.forward.z)
      : unit.formationFacing;
    return { x: center.x, z: center.z, facing };
  }
}
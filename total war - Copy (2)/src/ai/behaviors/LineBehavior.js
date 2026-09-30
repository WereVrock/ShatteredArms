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
import { nearestUnit, centerTowardUnit } from '../behaviorUtils.js';

export class LineBehavior {
  // weakPointTarget: Unit|null — this unit's assigned weak-point target for
  // this decision interval, or null if it's not one of the units biased
  // toward concentration this round (see TeamAI._assignWeakPointBias).
  decide(unit, enemyUnits, context, intent, assessment, worldCtx, weakPointTarget) {
    if (assessment && assessment.posture === 'retreat') {
      const holdOrRetreat = this._holdOrRetreatLine(unit, context, worldCtx);
      if (holdOrRetreat) return holdOrRetreat;
    }

    // Defence stance: hold the line in place and let the enemy come to
    // us. The team's initial stance is committed once at battle start
    // (see TeamAI._decide) and does not flip mid-battle. Retreat posture
    // (above) takes precedence — a defensive team that's assessed as
    // losing withdraws rather than merely holding.
    if (worldCtx && worldCtx.stance === 'defence') {
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
// Direct-attack order for a line unit that has been told to stop setting up
// and fight. Used in two situations (see LineBehavior):
//   - line under attack (worldCtx.lineUnderAttack, LineAlarmDetector):
//     close with the nearest enemy, preferring enemies already fighting us.
//   - ranged pressure (worldCtx.rangedPressureTargets,
//     RangedPressureDetector): coordinated break —
//       * units assigned as chasers (closest preferably swordsmen) go after
//         the shooters;
//       * the rest target the closest infantry, while remaining vigilant for
//         very close cavalry / archers, with sticky hysteresis on the infantry
//         choice.
//
// Deliberately ignores everything that makes a line unit patient: the shared
// cohesion slot, the forward cap, formation offsets and the weak-point bias.
//
// Target stickiness: the current target (intent.targetUnitId) is kept unless
// a rival scores better than current * AIConfig.lineTargetSwitchMargin, same
// hysteresis LineBehavior uses, so the unit does not flip between targets
// every decision cycle.
//
// Focus (ranged pressure) targets / assigned chaser targets are only taken if
// within AIConfig.rangedPressureMaxChaseDist of this unit. With no usable
// focus target the unit falls back to the general nearest-enemy pick only if
// allowAnyTarget is true (line alarm active); otherwise it returns null and
// normal line behavior continues.
import { AIConfig } from '../../config/AIConfig.js';
import { centerTowardUnit, unitTypeOf } from '../behaviorUtils.js';
import { isCavalry, isRanged } from '../../config/UnitClasses.js';
import { AIDebugLog } from '../AIDebugLog.js';

function isMostlyRouting(unit) {
  const alive = unit.getAliveSoldiers();
  if (alive.length === 0) return true;
  let routing = 0;
  for (const s of alive) {
    if (s.isRouting) routing++;
  }
  return routing / alive.length >= 0.5;
}

function isFightingUs(unit) {
  return unit.getAliveSoldiers().some(s => s.isInMelee());
}

function distanceBetween(a, b) {
  const ca = a.getCenter();
  const cb = b.getCenter();
  const dx = ca.x - cb.x;
  const dz = ca.z - cb.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function isInfantryEnemy(unit) {
  const type = unitTypeOf(unit);
  if (!type) return false;
  return !isCavalry(type) && !isRanged(type);
}

export class LineAssault {
  // focusUnits: enemy Unit[] to prefer (ranged pressure shooters), or null.
  // allowAnyTarget: when false and no focus/assigned target is usable, returns null.
  // assignedFocus: when set, this unit is a designated archer-chaser and must
  //   prioritise that specific shooter (subject to max-chase and stickiness).
  // Returns an { x, z, facing } order, or null (caller falls through).
  static decide(unit, enemyUnits, intent, focusUnits, allowAnyTarget, assignedFocus, worldCtx) {
    const target = LineAssault._pickTarget(
      unit, enemyUnits, intent, focusUnits, allowAnyTarget !== false, assignedFocus || null, worldCtx
    );
    if (!target) return null;

    intent.targetUnitId = target.id;

    const myCenter = unit.getCenter();
    const { dx, dz, dist, facing } = centerTowardUnit(unit, target);
    const orderFacing = dist > 0.0001 ? facing : unit.formationFacing;
    const stopDist = AIConfig.lineApproachStopDist;

    // Already at melee range. No-op order (rather than null) so TeamAI does
    // not fall through to a second decide() call; TargetingSystem handles the
    // actual engagement.
    if (dist <= stopDist) {
      return { x: myCenter.x, z: myCenter.z, facing: orderFacing };
    }

    const tgtCenter = target.getCenter();
    const fwdX = dx / dist;
    const fwdZ = dz / dist;

    AIDebugLog.log('lineassault', 0,
      `unit=${unit.id} assault target=${target.id} dist=${dist.toFixed(2)}`);

    return {
      x: tgtCenter.x - fwdX * stopDist,
      z: tgtCenter.z - fwdZ * stopDist,
      facing: orderFacing
    };
  }

  static _pickTarget(unit, enemyUnits, intent, focusUnits, allowAnyTarget, assignedFocus, worldCtx) {
    // Local-threat override. Fires BEFORE the archer-chaser designation,
    // BEFORE the ranged-pressure focus path, BEFORE _pickNearest.
    //
    // Rationale: everything below this point is a preference ranking —
    // "which of several plausible enemies is the best pick." That is
    // the right shape when the unit has no enemy in its face. It is the
    // wrong shape when the unit is standing next to a swordsman that is
    // about to swing at it: the local enemy is not "the best pick," it
    // is the only physically coherent choice. Stickiness and the
    // engagement-preference multiplier (both correct for the ranking
    // case) were what caused a locked-on line unit to walk past a fresh
    // enemy.
    //
    // Scope of the override:
    //   - Only fires on non-routing, non-defeated enemies within
    //     lineAssaultLocalThreatRadius of this unit's center.
    //   - Does NOT fire if the current sticky target is already at
    //     least as close — a unit already fighting a guy 2 units away
    //     does not switch to a different guy 3 units away.
    //   - Fires even against an archer-chaser assignment: "swordsman
    //     in my face" outranks "chase an archer across the field."
    // Tier handicap: a tier may shrink the local-threat radius, or set
    // it to 0 to disable the override entirely — line units then walk
    // past adjacent enemies toward their sticky target, the exact bug
    // this override was added to fix. Best-possible inherits the
    // AIConfig default. The 0 sentinel is honoured inside
    // _nearestLocalEnemy, which returns null immediately.
    const localThreatRadius = worldCtx?.tierCfg?.lineAssaultLocalThreatRadius
      ?? AIConfig.lineAssaultLocalThreatRadius;
    const localEnemy = LineAssault._nearestLocalEnemy(unit, enemyUnits, localThreatRadius);
    if (localEnemy) {
      if (intent.targetUnitId) {
        const current = enemyUnits.find(
          u => u.id === intent.targetUnitId && !u.isDefeated()
        );
        if (current) {
          const dCurrent = distanceBetween(unit, current);
          const dLocal = distanceBetween(unit, localEnemy);
          if (dCurrent <= dLocal) return current;
        }
      }
      return localEnemy;
    }

    // Designated archer-chaser: stick to the assigned shooter (or nearest
    // usable shooter if the assigned one is gone / out of range).
    if (assignedFocus && !assignedFocus.isDefeated()) {
      const d = distanceBetween(unit, assignedFocus);
      if (d <= AIConfig.rangedPressureMaxChaseDist) {
        return assignedFocus;
      }
    }

    if (Array.isArray(focusUnits) && focusUnits.length > 0) {
      // Under ranged pressure without a personal assignment: do NOT pile onto
      // the archers. Fight closest infantry, staying vigilant for very close
      // cavalry / archers. Only fall through to general nearest if allowed.
      if (!assignedFocus) {
        const infantryPick = LineAssault._pickInfantryWithVigilance(unit, enemyUnits, intent);
        if (infantryPick) return infantryPick;
        if (!allowAnyTarget) return null;
      } else {
        // Assigned but assigned target invalid / out of range: try any focus.
        const focus = LineAssault._pickFocusTarget(unit, focusUnits, intent);
        if (focus) return focus;
        if (!allowAnyTarget) return null;
      }
    }

    return LineAssault._pickNearest(unit, enemyUnits, intent);
  }

// Nearest non-routing, non-defeated enemy within
  // AIConfig.lineAssaultLocalThreatRadius of this unit's center, or null
  // when nothing qualifies. Used by _pickTarget as the local-threat
  // override — see that method's header for the rationale.
  //
  // Deliberately skips mostly-routing enemies: a broken unit is fleeing,
  // not a threat, and the override should not divert a line unit toward
  // a unit that is already out of the fight. The main _pickNearest path
  // also skips routing units (for a different reason — chasing routers
  // is a waste of a line unit's time), so the two are consistent here.
  //
  // Measures center-to-center, same convention as distanceBetween.
  static _nearestLocalEnemy(unit, enemyUnits, radiusOverride) {
    if (!Array.isArray(enemyUnits) || enemyUnits.length === 0) return null;
    const radius = radiusOverride ?? AIConfig.lineAssaultLocalThreatRadius;
    // A radius of 0 (or negative) is the "override disabled" sentinel
    // — return early without doing the scan. Callers that want the
    // override active pass a positive value or omit the argument.
    if (!(radius > 0)) return null;
    const radiusSq = radius * radius;
    const myCenter = unit.getCenter();

    let best = null;
    let bestDistSq = Infinity;
    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      if (isMostlyRouting(enemy)) continue;
      const ec = enemy.getCenter();
      const dx = ec.x - myCenter.x;
      const dz = ec.z - myCenter.z;
      const dSq = dx * dx + dz * dz;
      if (dSq > radiusSq) continue;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = enemy;
      }
    }
    return best;
  }

static _pickFocusTarget(unit, focusUnits, intent) {
    const maxDist = AIConfig.rangedPressureMaxChaseDist;
    const candidates = [];
    for (const enemy of focusUnits) {
      if (enemy.isDefeated()) continue;
      if (distanceBetween(unit, enemy) > maxDist) continue;
      candidates.push(enemy);
    }
    return LineAssault._pickSticky(
      candidates, intent, enemy => distanceBetween(unit, enemy)
    );
  }

  // Non-chaser path under ranged pressure: primary target is closest infantry
  // (non-cav, non-ranged), with engaged-preference scoring and the same
  // sticky hysteresis as the rest of the line. Very close cavalry or archers
  // override that preference so the unit does not ignore an immediate threat.
  static _pickInfantryWithVigilance(unit, enemyUnits, intent) {
    const vigilanceDist = AIConfig.rangedPressureVigilanceDist;
    const closeThreats = [];
    const infantry = [];

    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      if (isMostlyRouting(enemy)) continue;

      const dist = distanceBetween(unit, enemy);
      const type = unitTypeOf(enemy);
      const isThreatType = type && (isCavalry(type) || isRanged(type));

      if (isThreatType && dist <= vigilanceDist) {
        closeThreats.push(enemy);
      } else if (isInfantryEnemy(enemy)) {
        infantry.push(enemy);
      }
    }

    // Immediate threats win over infantry when inside the vigilance bubble.
    if (closeThreats.length > 0) {
      return LineAssault._pickSticky(
        closeThreats, intent, enemy => distanceBetween(unit, enemy)
      );
    }

    if (infantry.length === 0) return null;

    return LineAssault._pickSticky(infantry, intent, enemy => {
      let score = distanceBetween(unit, enemy);
      if (isFightingUs(enemy)) score *= AIConfig.lineAssaultEngagedPreference;
      return score;
    });
  }

  static _pickNearest(unit, enemyUnits, intent) {
    const candidates = [];
    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      if (isMostlyRouting(enemy)) continue;
      candidates.push(enemy);
    }
    return LineAssault._pickSticky(candidates, intent, enemy => {
      let score = distanceBetween(unit, enemy);
      if (isFightingUs(enemy)) score *= AIConfig.lineAssaultEngagedPreference;
      return score;
    });
  }

  // Lowest score wins, but the current target is kept unless the best rival
  // beats it by lineTargetSwitchMargin.
  static _pickSticky(candidates, intent, scoreFn) {
    let best = null;
    let bestScore = Infinity;
    let current = null;
    let currentScore = Infinity;

    for (const enemy of candidates) {
      const score = scoreFn(enemy);
      if (score < bestScore) {
        bestScore = score;
        best = enemy;
      }
      if (enemy.id === intent.targetUnitId) {
        current = enemy;
        currentScore = score;
      }
    }

    if (current && best && best.id !== current.id &&
        bestScore >= currentScore * AIConfig.lineTargetSwitchMargin) {
      return current;
    }
    return best;
  }
}
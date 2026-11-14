import { CombatConfig } from '../config/CombatConfig.js';
import { isRanged, getRangedRange } from '../config/UnitClasses.js';

// Marching-formation logic extracted from Unit: how the live anchor
// advances, follows terrain paths, turns, gates on its followers and
// releases soldiers at their break-off range. Stateless: every function
// takes the unit and reads or writes the march fields that stay on Unit
// (formationMarchOrigin, _path*, _marchReleased, _followerSlotDist...), so
// TerrainView, SoldierPathFollower and MovementSystem keep reading them
// where they always did. Same pattern as UnitDirectMarch.
//
// Unit keeps thin delegates with the old private names; see Unit.js.

// Hard ceiling on how fast the live marching anchor closes the distance to
// its destination, in world-units/second. The actual per-tick anchor speed
// is the MINIMUM of this value and the slowest slot-following soldier's
// walk speed (see computeAnchorSpeed) - the anchor must never advance
// faster than the soldiers converging on it, or the formation slots race
// ahead of the block.
const MARCH_ANCHOR_SPEED = 1.3;

// Safety margin (world units) kept INSIDE a ranged unit's max range when
// computing the focus-target standoff - see focusTargetStandoff. The
// shooter's FRONT rank halts at (maxRange - buffer) from the enemy's
// NEAREST soldier, leaving a small buffer against range-edge flicker.
const FOCUS_TARGET_STANDOFF_BUFFER = 1.5;

// A crew unit whose shooters are released from their carriers (see
// CrewPairing, unit.crewDontWaitActive) is paced by its shooters alone:
// carriers trail behind instead of holding the block back.
function isUnpaced(unit, s) {
  return unit.crewDontWaitActive === true && s.crewRole === 'carrier';
}

// Waypoint reach radius for the marching anchor.
const PATH_WAYPOINT_REACH = 1.5;
// Repath when the goal has moved this far (attack orders chase a moving centre).
const PATH_REPATH_GOAL_DIST_SQ = 4 * 4;
// Never repath more often than this (15 ticks = 1 s at 15 Hz).
const PATH_MIN_REPATH_TICKS = 15;
// A partial (goal unreachable) path is retried this often.
const PATH_PARTIAL_RETRY_TICKS = 75;
const PATH_MAX_CLEARANCE = 8;
// Formation turn rate (radians/second) while following a detour path, and the
// angle under which no turn is applied (filters path-heading jitter).
const MARCH_TURN_RATE = 0.7;
const MARCH_TURN_DEADBAND = 0.05;

export class UnitMarch {
  // Rotates formationFacing toward `desired` at MARCH_TURN_RATE. Returns the
  // angle (radians) still to turn. Differences under the deadband are ignored.
  static turnTowardFacing(unit, desired, deltaSeconds) {
    let d = desired - unit.formationFacing;
    d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const abs = Math.abs(d);
    if (abs < MARCH_TURN_DEADBAND) return abs;
    const step = MARCH_TURN_RATE * deltaSeconds;
    if (abs <= step) {
      unit.formationFacing += d;
      return 0;
    }
    unit.formationFacing += d > 0 ? step : -step;
    return abs - step;
  }

  // After arrival, keeps turning to the ordered facing. Returns true while a
  // turn remains, which keeps the path state alive. Never turns a unit in
  // melee or one that was chasing a target.
  static finishMarchTurn(unit, alive, deltaSeconds) {
    if (unit._pathFinalFacing === null || unit.focusTargetUnitId) return false;
    for (const s of alive) {
      if (s.state === 'engaged') return false;
    }
    return UnitMarch.turnTowardFacing(unit, unit._pathFinalFacing, deltaSeconds) > MARCH_TURN_DEADBAND;
  }

  // Returns the point the anchor should advance toward this tick: the next
  // waypoint of the (lazily computed) path, or `target` itself when the way
  // is open or the path is on its final leg.
  static steerTarget(unit, target, terrain, deltaSeconds) {
    // A direct march keeps the anchor on the destination; its soldiers path
    // individually (UnitDirectMarch).
    if (!terrain || unit._directMarch) return target;
    unit._pathAgeTicks++;

    let need = unit._path === null;
    if (!need) {
      const dx = target.x - unit._pathGoal.x;
      const dz = target.z - unit._pathGoal.z;
      if (dx * dx + dz * dz > PATH_REPATH_GOAL_DIST_SQ) need = true;
      else if (unit._pathPartial && unit._pathAgeTicks >= PATH_PARTIAL_RETRY_TICKS) need = true;
    }
    if (need && (unit._path === null || unit._pathAgeTicks >= PATH_MIN_REPATH_TICKS)) {
      UnitMarch.computePath(unit, target, terrain);
    }

    const p = unit._path;
    if (p === null) return target;
    if (p.length === 1 && !unit._pathPartial) return target;

    const a = unit.formationMarchOrigin;
    while (unit._pathIdx < p.length - 1) {
      const w = p[unit._pathIdx];
      const dx = w.x - a.x, dz = w.z - a.z;
      if (dx * dx + dz * dz <= PATH_WAYPOINT_REACH * PATH_WAYPOINT_REACH) unit._pathIdx++;
      else break;
    }

    if (unit._pathIdx === p.length - 1 && !unit._pathPartial) {
      // Final leg: turn back to the facing the order asked for. A chase
      // (focus target) keeps the heading it already has.
      if (!unit.focusTargetUnitId && unit._pathFinalFacing !== null) {
        UnitMarch.turnTowardFacing(unit, unit._pathFinalFacing, deltaSeconds);
      }
      return target;
    }

    // Detour leg: the block turns toward its direction of travel.
    const w = p[unit._pathIdx];
    // A partial path whose only point is the start (goal unreachable, no
    // progress possible) has zero length; atan2(0, 0) would snap the whole
    // formation to facing 0.
    if ((w.x - a.x) * (w.x - a.x) + (w.z - a.z) * (w.z - a.z) > 1e-4) {
      UnitMarch.turnTowardFacing(unit, Math.atan2(w.x - a.x, w.z - a.z), deltaSeconds);
    }
    return w;
  }

  static computePath(unit, target, terrain) {
    const a = unit.formationMarchOrigin;
    const clearance = Math.min(PATH_MAX_CLEARANCE, Math.max(0.6, unit.currentWidthUnits * 0.5));
    const res = terrain.findPath(a.x, a.z, target.x, target.z, {
      clearance,
      mounted: unit._isMountedUnit()
    });
    unit._path = (res.points && res.points.length) ? res.points : [{ x: target.x, z: target.z }];
    unit._pathIdx = 0;
    unit._pathGoal = { x: target.x, z: target.z };
    unit._pathAgeTicks = 0;
    unit._pathPartial = !res.reached;
    // Captured once per order: a repath mid-march must not overwrite it with a
    // facing the march has already turned away from.
    if (unit._pathFinalFacing === null) unit._pathFinalFacing = unit.formationFacing;

    // A goal inside a rock or lake can never be reached. Park the order's
    // arrival point at the end of the reachable path so the order can clear
    // instead of hanging forever. _marchDestination stays untouched so
    // same-order detection keeps working.
    if (unit.hasActiveOrder && !unit.focusTargetUnitId && unit._marchDestination) {
      const last = unit._path[unit._path.length - 1];
      unit.orderTarget = unit._pathPartial
        ? { x: last.x, z: last.z }
        : { x: unit._marchDestination.x, z: unit._marchDestination.z };
    }
  }

  // Distance the anchor still has to travel, along the path when there is
  // one. Used for breakoff release so soldiers are not released just because
  // a wall puts them 5 units from the target as the crow flies.
  static remainingDist(unit, target) {
    const a = unit.formationMarchOrigin;
    const p = unit._path;
    if (p === null || p.length <= 1) {
      return Math.hypot(target.x - a.x, target.z - a.z);
    }
    let d = 0, px = a.x, pz = a.z;
    for (let i = unit._pathIdx; i < p.length; i++) {
      d += Math.hypot(p[i].x - px, p[i].z - pz);
      px = p[i].x; pz = p[i].z;
    }
    if (unit._pathPartial) d += Math.hypot(target.x - px, target.z - pz);
    return d;
  }

  // Moves formationMarchOrigin a bounded step toward `target`. Elastic, not
  // rigid: the anchor advances regardless of whether every soldier has
  // caught up to their current slot yet, but never faster than
  // `anchorSpeed`, which the caller caps at the slowest slot-following
  // soldier's actual walk speed.
  static advanceAnchor(unit, target, deltaSeconds, anchorSpeed) {
    const dx = target.x - unit.formationMarchOrigin.x;
    const dz = target.z - unit.formationMarchOrigin.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= 0.001) {
      unit.formationMarchOrigin.x = target.x;
      unit.formationMarchOrigin.z = target.z;
      return;
    }

    const step = Math.min(dist, anchorSpeed * deltaSeconds);
    unit.formationMarchOrigin.x += (dx / dist) * step;
    unit.formationMarchOrigin.z += (dz / dist) * step;
  }

  // Standoff distance (world units) the formation anchor halts at when
  // marching at a focus target. Melee units return 0 - they march all the
  // way to the enemy's center. Ranged units return a distance that puts
  // their FRONT rank at (maxRange - buffer) from the enemy's nearest
  // soldier:
  //
  //   anchorToCenter = ourDepth + frontToFront + enemyDepth
  //
  // Both depths are re-derived per call from the current alive count and
  // persisted column count (Unit._formationDepth), so casualties already
  // reflowed into a shorter formation are reflected.
  static focusTargetStandoff(unit, focusUnit) {
    const typeDef = unit.soldiers[0]?.unitTypeDef;
    if (!typeDef) return 0;
    if (!isRanged(typeDef)) return 0;

    const maxRange = getRangedRange(typeDef);
    if (maxRange <= 0) return 0;

    const ourDepth = unit._formationDepth();
    const enemyDepth = focusUnit ? focusUnit._formationDepth() : 0;

    const standoff =
      maxRange + ourDepth + enemyDepth - FOCUS_TARGET_STANDOFF_BUFFER;
    // Never return 0 or negative: Unit.update treats a standoff of 0 as
    // "melee, march all the way to the enemy center".
    return Math.max(1.0, standoff);
  }

  // Speed cap for the live marching anchor, derived from the soldiers
  // themselves: the lowest actualMoveSpeed among alive soldiers still
  // following the block (not released, not routing/shattered), scaled by
  // the same global speed multiplier MovementSystem applies to every step.
  // MARCH_ANCHOR_SPEED remains a hard ceiling; with no qualifying soldier
  // the anchor falls back to it.
  static computeAnchorSpeed(unit, aliveSoldiers) {
    let minSpeed = Infinity;
    let counted = 0;
    for (const s of aliveSoldiers) {
      if (s.state === 'routing' || s.state === 'shattered') continue;
      if (unit._marchReleased.has(s.id)) continue;
      if (isUnpaced(unit, s)) continue;
      if (!(s.actualMoveSpeed > 0)) continue;
      if (s.actualMoveSpeed < minSpeed) minSpeed = s.actualMoveSpeed;
      counted++;
    }
    if (counted === 0 || !isFinite(minSpeed)) return MARCH_ANCHOR_SPEED;

    const scale = (CombatConfig.movement && CombatConfig.movement.globalSpeedScale) || 1;
    return Math.min(MARCH_ANCHOR_SPEED, minSpeed * scale);
  }

  // Soldiers who are expected to be ACTIVELY walking to their formation
  // slot this tick: alive, not released from block-following, and in a
  // state MovementSystem moves toward formationSlot ('idle' / 'marching').
  // Everyone else is driven by something other than their slot and must NOT
  // count toward the falling-behind measurement.
  static slotFollowers(unit, aliveSoldiers) {
    const followers = [];
    for (const s of aliveSoldiers) {
      if (unit._marchReleased.has(s.id)) continue;
      if (s.state !== 'idle' && s.state !== 'marching') continue;
      if (isUnpaced(unit, s)) continue;
      followers.push(s);
    }
    return followers;
  }

  // Average soldier-to-slot distance across this unit's slot-followers.
  // Null when nobody is following - callers treat null as "no signal",
  // never as "falling behind".
static avgFollowerSlotDist(unit, aliveSoldiers) {
    const released = unit._marchReleased;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < aliveSoldiers.length; i++) {
      const s = aliveSoldiers[i];
      if (released.has(s.id)) continue;
      if (isUnpaced(unit, s)) continue;
      if (s.state !== 'idle' && s.state !== 'marching') continue;
      const dx = s.formationSlot.x - s.pos.x;
      const dz = s.formationSlot.z - s.pos.z;
      sum += Math.sqrt(dx * dx + dz * dz);
      count++;
    }
    return count === 0 ? null : sum / count;
  }

  // True when the unit's slot-followers were, on average, FARTHER from
  // their slots at the last measurement than the one before - i.e. the
  // block is losing ground to its own anchor. The epsilon absorbs
  // float/measurement noise.
  static followersFallingBehind(unit, aliveSoldiers) {
    if (unit._followerSlotDist === null || unit._followerSlotDist === undefined) {
      return false;
    }
    const current = UnitMarch.avgFollowerSlotDist(unit, aliveSoldiers);
    if (current === null) return false;
    return current > unit._followerSlotDist + 0.005;
  }

  // A soldier releases from block-following once the LIVE anchor-to-target
  // distance is within that soldier's own breakoffRange. Using the anchor's
  // distance (not each soldier's) means the whole block breaks off together.
  static releaseInBreakoffRange(unit, aliveSoldiers, target) {
    const anchorDist = UnitMarch.remainingDist(unit, target);

    for (const s of aliveSoldiers) {
      if (unit._marchReleased.has(s.id)) continue;
      const range = s.unitTypeDef.breakoffRange ?? 6.0;
      if (anchorDist <= range) {
        unit._marchReleased.add(s.id);
      }
    }
  }
}
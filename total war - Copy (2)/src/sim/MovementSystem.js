import { CombatConfig } from '../config/CombatConfig.js';

// Moves soldiers each tick based on their state, and tracks each soldier's
// actual current speed + movement heading (moveFacing).
//
// Throw handling runs FIRST, before the isAlive check, so a corpse killed by
// a cavalry charge still flies. See CombatConfig.charge for the throw tuning.
//
// Make-way pass: after the main movement loop, idle/marching soldiers step
// sideways when a different-unit friendly is heading at them from close
// range. This opens a corridor in the blocking formation rather than
// steering the mover around it. See _applyMakeWay below.
// Routing and shattered soldiers move at normal walk speed. Previously
// 1.3 (a "sprint" boost) which made routers leave the field in a hurry
// regardless of how broken they were — a soldier at -400 morale and one
// at -10 both exited at the same 1.3x clip. Removing the multiplier
// means rout duration is governed purely by morale recovery time, which
// is what the deep-negative-morale change was for: a soldier has to
// actually walk home, not sprint off the map.
const FLEE_SPEED_MULT = 1.0;
const FLEE_LOOKAHEAD = 8;

export class MovementSystem {
  constructor(spatialGrid) {
    this.spatialGrid = spatialGrid;
  }

update(allSoldiers, unitsById, deltaSeconds) {
    const byId = new Map(allSoldiers.map(s => [s.id, s]));

    // Pre-pass: which units currently have a soldier in melee. Idle unit-mates
    // advance on the fight instead of holding formation.
    const unitsInCombat = new Set();
    for (const s of allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.state === 'engaged' || s.state === 'staggered') {
        unitsInCombat.add(s.unitId);
      }
    }

    for (const soldier of allSoldiers) {
      // Airborne thrown soldiers (alive or dead) always integrate their throw
      // velocity. This runs before the isAlive check on purpose.
      if (soldier.airborneTicksLeft > 0) {
        this._applyThrow(soldier, deltaSeconds);
        continue;
      }

      if (!soldier.isAlive()) continue;

      if (soldier.state === 'engaged' || soldier.state === 'staggered' ||
          soldier.state === 'ranged' || soldier.state === 'knockedDown') {
        // Decay, do NOT zero — CombatResolutionSystem reads currentSpeed for
        // charge detection on the contact tick.
        soldier.currentSpeed *= 0.75;
        soldier.movedThisTick = false;
        continue;
      }

      let speed = soldier.effectiveMoveSpeed *
        CombatConfig.movement.globalSpeedScale *
        deltaSeconds;
      const unit = unitsById.get(soldier.unitId);
      const hasFocusTarget = !!(unit && unit.focusTargetUnitId);
      // A soldier still following the block (not yet released per
      // breakoffRange — see Unit.isMarchReleased) always targets the live
      // formationSlot, which Unit.update() already recomputed this tick
      // from the advancing march anchor. Only a RELEASED soldier falls
      // through to the focus-target / impetuous / rally branches below.
      const isReleased = !unit || unit.isMarchReleased(soldier.id);
      let targetPos = soldier.formationSlot;

      if (soldier.state === 'routing' || soldier.state === 'shattered') {
        if (soldier.fleeDirection.x === 0 && soldier.fleeDirection.z === 0) {
          // Prefer the unit's shared flee direction so the whole broken
          // formation runs coherently in one direction. Falls back to the
          // per-soldier nearest-enemy-away vector only if the unit lookup
          // misses (defensive; should not happen in normal play).
          const fleeUnit = unitsById.get(soldier.unitId);
          if (fleeUnit && typeof fleeUnit.getOrComputeFleeDirection === 'function') {
            const dir = fleeUnit.getOrComputeFleeDirection(allSoldiers);
            soldier.fleeDirection = { x: dir.x, z: dir.z };
          } else {
            this._initFleeDirection(soldier, allSoldiers);
          }
        }
        targetPos = {
          x: soldier.pos.x + soldier.fleeDirection.x * FLEE_LOOKAHEAD,
          z: soldier.pos.z + soldier.fleeDirection.z * FLEE_LOOKAHEAD
        };
        speed *= FLEE_SPEED_MULT;
      } else if (soldier.state === 'impetuous' && soldier.targetId) {
        const target = byId.get(soldier.targetId);
        if (target && target.isAlive()) targetPos = target.pos;
      } else if (isReleased && hasFocusTarget && soldier.targetId) {
        const target = byId.get(soldier.targetId);
        if (target && target.isAlive()) targetPos = target.pos;
      } else if (isReleased && soldier.rallyTargetId && unitsInCombat.has(soldier.unitId)) {
        const rallyTarget = byId.get(soldier.rallyTargetId);
        if (rallyTarget && rallyTarget.isAlive()) targetPos = rallyTarget.pos;
      }

      const prevX = soldier.pos.x;
      const prevZ = soldier.pos.z;

      this._moveToward(soldier, targetPos, speed);

      const movedX = soldier.pos.x - prevX;
      const movedZ = soldier.pos.z - prevZ;
      const movedDist = Math.sqrt(movedX * movedX + movedZ * movedZ);

      soldier.currentSpeed = deltaSeconds > 0 ? movedDist / deltaSeconds : 0;
      soldier.movedThisTick = movedDist > 0.001;

      if (soldier.movedThisTick) {
        soldier.moveFacing = Math.atan2(movedX, movedZ);
      }
    }

    // Make-way pass. Runs after the main movement loop so incoming soldiers
    // have already moved this tick; blockers then step aside from the
    // updated geometry. Collision (which runs after MovementSystem in the
    // sim tick order) resolves any overlaps the push creates.
    this._applyMakeWay(allSoldiers, deltaSeconds);
  }

  // Integrates one tick of throw velocity, decays it, and counts down the
  // airborne timer. Does NOT set movedThisTick — a thrown soldier is not
  // voluntarily moving, so FacingSystem holds their last real facing and
  // brace checks correctly read them as immobile.
  _applyThrow(soldier, deltaSeconds) {
    soldier.pos.x += soldier.knockbackVel.x * deltaSeconds;
    soldier.pos.z += soldier.knockbackVel.z * deltaSeconds;

    const speed = Math.sqrt(
      soldier.knockbackVel.x * soldier.knockbackVel.x +
      soldier.knockbackVel.z * soldier.knockbackVel.z
    );
    soldier.currentSpeed = speed;
    soldier.movedThisTick = false;

    const decay = CombatConfig.charge.knockbackDecayPerTick;
    soldier.knockbackVel.x *= decay;
    soldier.knockbackVel.z *= decay;
    soldier.airborneTicksLeft--;

    if (soldier.airborneTicksLeft <= 0) {
      soldier.knockbackVel.x = 0;
      soldier.knockbackVel.z = 0;
      soldier.currentSpeed = 0;
    }
  }

  _initFleeDirection(soldier, allSoldiers) {
    let nearest = null;
    let nearestDistSq = Infinity;

    for (const other of allSoldiers) {
      if (other.teamId === soldier.teamId) continue;
      if (!other.isAlive()) continue;
      const dx = other.pos.x - soldier.pos.x;
      const dz = other.pos.z - soldier.pos.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < nearestDistSq) {
        nearestDistSq = dSq;
        nearest = other;
      }
    }

    if (!nearest) {
      soldier.fleeDirection = { x: 0, z: 1 };
      return;
    }

    const dx = soldier.pos.x - nearest.pos.x;
    const dz = soldier.pos.z - nearest.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.001) {
      soldier.fleeDirection = { x: 0, z: 1 };
      return;
    }
    soldier.fleeDirection = { x: dx / d, z: dz / d };
  }

  // Direct movement to targetPos by up to maxStep. No sideways bias — the
  // make-way pass handles clearing the path, not this function.
  _moveToward(soldier, targetPos, maxStep) {
    const dx = targetPos.x - soldier.pos.x;
    const dz = targetPos.z - soldier.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist <= 0.01) return;

    const step = Math.min(maxStep, dist);
    soldier.pos.x += (dx / dist) * step;
    soldier.pos.z += (dz / dist) * step;
  }

  // Make-way pass. A soldier who is idle or marching, and who has a
  // different-unit friendly marching at them from close range, steps
  // perpendicular to that friendly's heading — away from the corridor
  // center, opening a lane for the friendly to walk straight through.
  //
  // Applied as a position nudge only. currentSpeed and movedThisTick are
  // deliberately NOT set: this is a reactive step, not voluntary movement,
  // so it must not feed FacingSystem's "walked this tick" branch (which
  // would turn the making-way soldier to face the incoming friendly) and
  // must not register as charge speed.
  //
  // Engaged, staggered, knockedDown, and routing soldiers never make way.
  // A soldier holding a melee line does not step aside for a passer; a
  // routing soldier is fleeing and has no discipline to open corridors.
  //
  // Push magnitude falls off with distance: a friendly 0.5 units away
  // produces a strong push, a friendly at makeWayRadius produces almost
  // none. Weighted also by how directly the friendly is heading (dot of
  // heading vs. to-me vector), so a friendly merely walking in the
  // vicinity does not open a corridor.
  //
  // No side commitment, no hysteresis. The push is small per tick and
  // recomputed each tick from current geometry — the natural result is a
  // smooth, continuous side-step that stops the moment the friendly has
  // passed. Any oscillation is damped by the fact that once a blocker
  // has stepped to one side, the incoming friendly is no longer heading
  // directly at them (dot drops below threshold) and the push stops.
// Make-way pass (Option 2 — perpendicular yield).
  //
  // Runs after the main movement loop each tick. A disengaged soldier
  // (idle/marching) whose different-unit friendly is walking into them
  // steps PERPENDICULAR TO THE PUSH DIRECTION — the radial vector from
  // the pusher to the yielder — on the side that moves them furthest
  // off the pusher's path. This opens a lane the pusher can walk
  // straight through without the yielder being teleported radially
  // (which would fight the pusher's forward motion) or needing the
  // pusher to steer around them.
  //
  // The yield is applied as VOLUNTARY movement: `movedThisTick` is set
  // and `moveFacing` points along the yield direction, so FacingSystem
  // turns the yielder to look where they stepped. `currentSpeed` is
  // deliberately NOT touched — a soldier stepping aside for a friendly
  // must not register as charging on the next melee contact tick.
  //
  // "Return to slot once the push stops" needs no code here: once the
  // pusher leaves the detection radius the yield contributes nothing,
  // and the main movement loop's default `_moveToward(formationSlot)`
  // walks the yielder home automatically.
  //
  // Engaged, staggered, knockedDown, routing, and impetuous soldiers
  // never yield. A soldier holding a melee line does not step aside; a
  // routing soldier is fleeing and has no discipline; an impetuous
  // soldier has committed to a target.
  //
  // Push magnitude falls off with distance (1 at contact, 0 at radius)
  // and is weighted by how directly the pusher is heading at the
  // yielder (dot of pusher heading vs. push direction). A pusher merely
  // walking past — outside the forward cone — does not fire the yield.
  _applyMakeWay(allSoldiers, deltaSeconds) {
    const cfg = CombatConfig.makeWay;
    const radius = cfg.radius;
    const radiusSq = radius * radius;
    const dotThreshold = cfg.dotThreshold;

    for (const yielder of allSoldiers) {
      if (!yielder.isAlive()) continue;
      if (yielder.state === 'engaged' || yielder.state === 'staggered' ||
          yielder.state === 'knockedDown' ||
          yielder.state === 'routing' || yielder.state === 'shattered') {
        continue;
      }
      if (yielder.state !== 'idle' && yielder.state !== 'marching') continue;

      const nearby = this.spatialGrid.queryNearby(yielder.pos.x, yielder.pos.z, 1);

      let moveX = 0;
      let moveZ = 0;
      let weightSum = 0;

      for (const pusher of nearby) {
        if (pusher === yielder) continue;
        if (!pusher.isAlive()) continue;
        if (pusher.teamId !== yielder.teamId) continue;
        if (pusher.unitId === yielder.unitId) continue;
        if (pusher.currentSpeed < cfg.incomingSpeedThreshold) continue;
        if (pusher.state === 'routing' || pusher.state === 'shattered' ||
            pusher.state === 'knockedDown') continue;

        // Vector from pusher to yielder — this is the push direction.
        const ox = yielder.pos.x - pusher.pos.x;
        const oz = yielder.pos.z - pusher.pos.z;
        const dSq = ox * ox + oz * oz;
        if (dSq > radiusSq || dSq < 0.0001) continue;

        const d = Math.sqrt(dSq);
        const pushDirX = ox / d;
        const pushDirZ = oz / d;

        // Only react to a pusher actually heading at the yielder —
        // walking past outside the forward cone does not trigger yield.
        const headingX = Math.sin(pusher.moveFacing);
        const headingZ = Math.cos(pusher.moveFacing);
        const dot = headingX * pushDirX + headingZ * pushDirZ;
        if (dot < dotThreshold) continue;

        // Perpendicular to the push direction. Two candidates:
        // rotate pushDir +90° or −90°. Pick the side that moves the
        // yielder further off the pusher's path, using the cross
        // product of the pusher's heading and the push direction.
        // Cross ≈ 0 means the yielder sits dead-centre in the path —
        // deterministic tie-break on yielder id so the side doesn't
        // flip on floating-point noise.
        let cross = headingX * pushDirZ - headingZ * pushDirX;
        if (Math.abs(cross) < cfg.sideTieEpsilon) {
          cross = (yielder.id % 2 === 0)
            ? cfg.sideTieEpsilon
            : -cfg.sideTieEpsilon;
        }
        const sideSign = cross > 0 ? 1 : -1;
        const perpX = -pushDirZ * sideSign;
        const perpZ = pushDirX * sideSign;

        // Weight: how close (1 at contact, 0 at radius) × how directly
        // the pusher is heading at us (0 at dotThreshold, 1 head-on).
        const w = (1 - d / radius) * dot;
        moveX += perpX * w;
        moveZ += perpZ * w;
        weightSum += w;
      }

      if (weightSum < 0.05) continue;

      const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
      if (len < 0.0001) continue;

      const step = yielder.effectiveMoveSpeed *
        CombatConfig.movement.globalSpeedScale *
        deltaSeconds *
        cfg.amount *
        Math.min(1, weightSum);

      const dx = (moveX / len) * step;
      const dz = (moveZ / len) * step;
      yielder.pos.x += dx;
      yielder.pos.z += dz;

      // Mark as voluntary: the yielder visibly turns toward where they
      // stepped. currentSpeed is left alone — a side-step is not a
      // charge and must not be read as one on the next contact tick.
      yielder.movedThisTick = true;
      yielder.moveFacing = Math.atan2(dx, dz);
    }
  }
}
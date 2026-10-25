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

      // Ranged soldiers stand and shoot, but never from a broken formation:
      // if one is off its slot it walks back onto it first. Without this a
      // line ordered while enemies were in range froze wherever each archer
      // happened to be when it acquired a target.
      if (soldier.state === 'ranged' && this._holdFormationSlot(soldier, deltaSeconds, unitsById)) {
        continue;
      }

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

      // Thralls bypass formation entirely. They path straight at their
      // target (assigned each tick by BloodThrallSystem) regardless of
      // unit order state.
      if (soldier.isThrall) {
        if (soldier.targetId) {
          const target = byId.get(soldier.targetId);
          if (target && target.isAlive()) targetPos = target.pos;
        }
        // Walk. Skip all the state branches below.
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
        continue;
      }

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

      // Clear the pushed flag. It is no longer read here — the settle-
      // in tolerance ramp (Unit._settleToleranceBonus) subsumes the
      // old "pushed and within tolerance → accept" test. Cleared so the
      // flag does not accumulate stale true values from CollisionSystem.
      soldier.pushedSinceLastMovement = false;

      // Walk decision. Non-slot targets (an enemy to chase, a flee
      // point) walk all the way in with a tiny tolerance — the settle
      // ramp only applies when the destination IS the formation slot.
      const isSlotTarget = (targetPos === soldier.formationSlot);
      let tolerance;

      if (isSlotTarget) {
        const dxs = targetPos.x - soldier.pos.x;
        const dzs = targetPos.z - soldier.pos.z;
        const distToSlot = Math.sqrt(dxs * dxs + dzs * dzs);

        // Effective tolerance = discipline base + the unit's settle-in
        // ramp. While the unit has an active order the ramp is 0, so a
        // marching formation uses its discipline base and stays loose
        // (goblins) or tight (high discipline) as configured. After the
        // order clears, the ramp grows per tick until every soldier has
        // stopped — the growth is what removes the residual fidget of
        // a soldier nudged off its attempt target and walking back.
        const bonus = unit ? (unit._settleToleranceBonus || 0) : 0;
        const effectiveTolerance = soldier.slotArrivalTolerance + bonus;

        // In tolerance → stop. Combined with the ramp, this is what
        // terminates the collision / walk-back loop — the band grows
        // until the whole formation has stopped, at which point the
        // ramp freezes and the formation holds.
        if (distToSlot <= effectiveTolerance) {
          soldier.currentSpeed = 0;
          soldier.movedThisTick = false;
          continue;
        }

        // Outside the band — walk toward the slot and stop on the
        // soldier's personal attempt target, a per-soldier random value
        // in [0.01, slotAttemptUnits]. Fires when the soldier is
        // genuinely displaced (a throw, a long collision chain, a fresh
        // order that moved the slot) and needs to walk back into
        // formation.
        tolerance = soldier.slotAttemptTarget;
      } else {
        tolerance = 0.01;
      }

      this._moveToward(soldier, targetPos, speed, tolerance);

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
    this._applyMakeWay(allSoldiers, unitsById, deltaSeconds);

    // Walking drain. One pass over the whole roster at the end of the
    // movement update so every source of VOLUNTARY locomotion is caught
    // — the main movement loop, _holdFormationSlot (ranged soldiers
    // walking back onto their slot), and _applyMakeWay (yielding). The
    // movedThisTick flag is set only by those three; involuntary
    // movement (throw integration, and the engaged/staggered/ranged/
    // knockedDown stand-still decay) explicitly clears it, so this pass
    // correctly excludes everything that is not the soldier walking of
    // their own volition.
    this._drainWalkFatigue(allSoldiers);
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
_moveToward(soldier, targetPos, maxStep, tolerance = 0.01) {
    const dx = targetPos.x - soldier.pos.x;
    const dz = targetPos.z - soldier.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist <= tolerance) return;

    const step = Math.min(maxStep, dist);
    soldier.pos.x += (dx / dist) * step;
    soldier.pos.z += (dz / dist) * step;
  }

// Ranged soldiers hold formation while shooting. Returns true if the
  // soldier was off its slot and walked toward it this tick (the caller
  // then skips the stand-still branch), false if it is already on its slot
  // within CombatConfig.rangedSlotHoldTolerance and should just stand.
  //
  // The step is capped at the remaining distance by _moveToward, so the
  // soldier lands exactly on the slot instead of oscillating around it.
  // Facing is not driven by this movement: FacingSystem handles ranged
  // soldiers before it looks at movedThisTick.
  _holdFormationSlot(soldier, deltaSeconds, unitsById) {
    const slot = soldier.formationSlot;
    const dx = slot.x - soldier.pos.x;
    const dz = slot.z - soldier.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    // Tolerance is the largest of: the ranged-specific hold (archers
    // want to stay roughly on slot while shooting), the soldier's own
    // discipline base tolerance, and the unit's settle-in ramp on top
    // of that. A low-discipline archer accepts its slot at 0.4; a
    // high-discipline one stays at the ranged-specific 0.12.
    const unitRef = unitsById ? unitsById.get(soldier.unitId) : null;
    const bonus = unitRef ? (unitRef._settleToleranceBonus || 0) : 0;
    const tolerance = Math.max(
      CombatConfig.rangedSlotHoldTolerance,
      soldier.slotArrivalTolerance + bonus
    );
    if (dist <= tolerance) return false;

    const maxStep = soldier.effectiveMoveSpeed *
      CombatConfig.movement.globalSpeedScale *
      deltaSeconds;

    const prevX = soldier.pos.x;
    const prevZ = soldier.pos.z;
    this._moveToward(soldier, slot, maxStep, tolerance);

    const movedX = soldier.pos.x - prevX;
    const movedZ = soldier.pos.z - prevZ;
    const movedDist = Math.sqrt(movedX * movedX + movedZ * movedZ);

    soldier.currentSpeed = deltaSeconds > 0 ? movedDist / deltaSeconds : 0;
    soldier.movedThisTick = movedDist > 0.001;
    if (soldier.movedThisTick) {
      soldier.moveFacing = Math.atan2(movedX, movedZ);
    }
    return true;
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
  _applyMakeWay(allSoldiers, unitsById, deltaSeconds) {
    const cfg = CombatConfig.makeWay;
    const radius = cfg.radius;
    const radiusSq = radius * radius;
    const dotThreshold = cfg.dotThreshold;

    // Units currently being passed through by a friendly different-unit
    // soldier. Collected here rather than in a separate scan because
    // _applyMakeWay already performs the exact detection the unit-level
    // spread needs: a different-unit friendly moving directly at a
    // standing yielder from close range. Fed to _updateUnitSpread below
    // to ramp each affected unit's lateral formation spread.
    const passingThroughUnits = new Set();

    // Higher speed threshold for the unit-wide spread flag than for the
    // per-soldier nudge. The nudge fires as soon as a pusher is barely
    // walking (makeWay.incomingSpeedThreshold, 0.1), but the unit-wide
    // spread must only fire for a genuine march-through — otherwise a
    // unit stays spread open because a neighbouring soldier is slowly
    // slot-correcting on top of it after the actual pass has ended.
    const SPREAD_FLAG_MIN_SPEED = 0.3;

    // Unit-center proximity radius for the unit-wide spread flag. The
    // flag fires only while the pusher's unit CENTER is within this
    // distance of the yielder's unit CENTER — not merely while any
    // pusher soldier is adjacent to any yielder soldier.
    //
    // Why this gate exists: the per-soldier radius (makeWay.radius, 1.2)
    // is intentionally tight so individual soldiers nudge past each
    // other cleanly, but at that radius the yielder's unit stays flagged
    // for as long as ANY trailing pusher soldier is adjacent to ANY
    // yielder soldier. For a multi-rank passing unit, the rear echelon
    // sits at that range for the entire pass, so the yielder's unit is
    // held spread open long after the bulk of the pass-through has
    // visibly cleared. Gating on unit centers decouples "is a real
    // pass-through in progress" from "are any two soldiers coincidentally
    // adjacent", so the flag clears when the passing unit's center moves
    // on — which is the moment a human reads the pass as finished.
    //
    // The per-soldier nudge below is NOT gated on this: individual
    // yielders still step aside for individual pushers regardless of
    // unit centers, so collisions and passing still resolve per-soldier
    // as before.
    const SPREAD_UNIT_CENTER_RADIUS_SQ = 4.0 * 4.0;

    for (const yielder of allSoldiers) {
      if (!yielder.isAlive()) continue;
      if (yielder.state === 'engaged' || yielder.state === 'staggered' ||
          yielder.state === 'knockedDown' ||
          yielder.state === 'routing' || yielder.state === 'shattered') {
        continue;
      }
      if (yielder.state !== 'idle' && yielder.state !== 'marching') continue;

      // Yielder's unit + unit center. Cached once per yielder so the
      // inner pusher loop can read them for the unit-proximity gate
      // without recomputing per pusher.
      const yielderUnit = unitsById ? unitsById.get(yielder.unitId) : null;
      const yielderUnitCenter = yielderUnit ? yielderUnit.getCenter() : null;

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

        // Skip pushers whose own unit is currently spread. A spreading
        // unit's soldiers walk laterally to their widened slots, and that
        // lateral walk can itself satisfy the pusher test against another
        // unit's soldiers — producing a mutual feedback loop where two
        // adjacent units keep each other spread forever. A unit that is
        // already spread is therefore not eligible to cause another unit
        // to spread: only a normally-formed unit can open another
        // formation's corridor.
        const pusherUnit = unitsById ? unitsById.get(pusher.unitId) : null;
        if (pusherUnit && (pusherUnit._spreadFactor ?? 1.0) > 1.0) continue;

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

        // Same-direction gate. When both the pusher and the yielder are
        // walking in roughly the same direction, they are travelling in
        // a queue, not passing through each other. The old branch treated
        // the pair as mutual pass-throughs and toggled the unit spread
        // factor on/off every tick, producing visible side-to-side
        // shake. Skip the yield for this pair entirely.
        //
        // Head-on (headingDot < 0) and perpendicular (headingDot ≈ 0)
        // motion still yield as before — those are genuine pass-through
        // cases. A stationary yielder never reaches this gate
        // (movedThisTick is false), so it still steps aside for a moving
        // pusher.
        if (yielder.movedThisTick && pusher.movedThisTick) {
          const yHeadX = Math.sin(yielder.moveFacing);
          const yHeadZ = Math.cos(yielder.moveFacing);
          const headingDot = headingX * yHeadX + headingZ * yHeadZ;
          if (headingDot > 0) continue;
        }

        // Flag the yielder's unit for formation spread. This is the
        // unit-level response to the pass-through — the yielder's whole
        // unit widens its ranks laterally so a real corridor opens,
        // rather than relying on individual soldiers nudging aside.
        //
        // Gated on three conditions:
        //   - the pusher's unit center is within SPREAD_UNIT_CENTER_RADIUS
        //     of the yielder's unit center. This is the gate that lets
        //     the yielder's unit CLOSE once the passing unit's bulk has
        //     cleared, even if trailing pusher soldiers are still
        //     adjacent to trailing yielder soldiers.
        //   - the pusher's unit has an active march/attack order. A
        //     soldier whose unit has no order is standing, settling, or
        //     reacting — not passing through anyone, and it must not
        //     keep another unit spread open.
        //   - the pusher is moving at least SPREAD_FLAG_MIN_SPEED, a
        //     higher bar than the per-soldier nudge's threshold, so a
        //     twitch-correcting soldier does not hold the unit open.
        //
        // Note this block does NOT `continue` when the gate fails — the
        // per-soldier nudge below still runs, so individual yielders
        // still step aside for individual pushers regardless of unit
        // centers. Only the unit-wide spread flag is gated here.
        const pusherHasOrder = !!(pusherUnit &&
          (pusherUnit.hasActiveOrder || pusherUnit.focusTargetUnitId));

        let unitCentersClose = true;
        if (yielderUnitCenter && pusherUnit) {
          const puCenter = pusherUnit.getCenter();
          const dxc = puCenter.x - yielderUnitCenter.x;
          const dzc = puCenter.z - yielderUnitCenter.z;
          unitCentersClose =
            (dxc * dxc + dzc * dzc) <= SPREAD_UNIT_CENTER_RADIUS_SQ;
        }

        if (unitCentersClose &&
            pusherHasOrder &&
            pusher.currentSpeed >= SPREAD_FLAG_MIN_SPEED) {
          passingThroughUnits.add(yielder.unitId);
        }

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

    this._updateUnitSpread(allSoldiers, unitsById, passingThroughUnits, deltaSeconds);
  }

  // Unit-level formation spread while a friendly unit passes through.
  //
  // When _applyMakeWay detects that one of this unit's soldiers is being
  // walked through by a friendly soldier from a different unit, the
  // yielder's UNIT is added to passingThroughUnits. This method ramps
  // that unit's lateral spread factor up toward MAX_SPREAD so its ranks
  // visibly open a corridor; units no longer being passed through ramp
  // back toward 1.0 and close up. The factor is applied to each
  // soldier's formationOffset x-component in Unit._applyFormationAt.
  //
  // Engaged units are excluded — a unit in melee holds formation and
  // does not make way for anyone, even if some of its rear-rank soldiers
  // are idle. The check is on the whole unit, not the individual
  // yielder, so a partly-engaged formation does not awkwardly stretch
  // while its front rank fights.
  //
  // Ramps are per-second so the spread opens and closes at a visible but
  // not instant rate, regardless of tick rate.
  _updateUnitSpread(allSoldiers, unitsById, passingThroughUnits, deltaSeconds) {
    const MAX_SPREAD = 1.8;
    // Opening is deliberately slower than closing. Opening a corridor
    // reads as the formation gradually making room; closing must snap
    // back so the unit visibly reforms the moment the pass-through ends
    // and does not linger half-spread. The close rate is 3x the open
    // rate, so a unit that has just cleared a pass-through closes in
    // roughly 3-4 ticks (at 15 Hz) from full spread back to normal.
    const RAMP_OPEN_PER_SEC = 2.0;
    const RAMP_CLOSE_PER_SEC = 6.0;
    const openStep = RAMP_OPEN_PER_SEC * deltaSeconds;
    const closeStep = RAMP_CLOSE_PER_SEC * deltaSeconds;

    const seen = new Set();
    for (const s of allSoldiers) {
      if (seen.has(s.unitId)) continue;
      seen.add(s.unitId);

      const unit = unitsById ? unitsById.get(s.unitId) : null;
      if (!unit) continue;

      if (unit._spreadFactor === undefined) unit._spreadFactor = 1.0;

      const detected = passingThroughUnits.has(unit.id);
      const engaged = this._unitInMelee(unit);

      // Opt-in debug trace. Enable from the browser console with
      //   window.__spreadDebug = true
      // Logs every tick for any unit whose spread factor is not 1.0,
      // including whether the flag fired and what the current factor is.
      // Inert when the flag is not set — zero allocation in normal play.
      if (typeof window !== 'undefined' && window.__spreadDebug) {
        if (detected || unit._spreadFactor !== 1.0) {
          console.log(
            `[spread] unit=${unit.id} spread=${unit._spreadFactor.toFixed(3)} ` +
            `detected=${detected} engaged=${engaged}`
          );
        }
      }

      // Any tick without a fresh detection drives the unit back toward
      // 1.0 — there is no per-unit linger state. The detection set is
      // rebuilt from scratch every tick in _applyMakeWay, so a unit
      // that is no longer being passed through closes immediately.
      let target;
      let step;
      if (detected && !engaged) {
        target = MAX_SPREAD;
        step = openStep;
      } else {
        target = 1.0;
        step = closeStep;
      }

      const diff = target - unit._spreadFactor;
      if (Math.abs(diff) <= step) {
        unit._spreadFactor = target;
      } else {
        unit._spreadFactor += Math.sign(diff) * step;
      }
    }
  }

  // True when any living soldier of this unit is in melee ('engaged').
  // Used by _updateUnitSpread to hold formation on a unit that is
  // currently fighting — a unit in combat does not spread to let a
  // friendly pass through.
  _unitInMelee(unit) {
    for (const s of unit.soldiers) {
      if (!s.isAlive()) continue;
      if (s.state === 'engaged') return true;
    }
    return false;
  }

  // Walking drain. Every soldier who moved this tick under their own
  // volition loses a small amount of fatigue, scaled by their race's
  // fatigueDrainMultiplier (goblins tire 1.5x as fast as humans on the
  // march). Runs once per tick at the end of update() so it covers the
  // main movement loop, formation-slot holds, and make-way yields
  // without needing three separate call sites.
  //
  // Skip when the configured drain is zero so a future tuning pass that
  // wants walking to be free can flip one config value to a no-op
  // without a code change.
_drainWalkFatigue(allSoldiers) {
    const drain = CombatConfig.fatigue.drainPerWalkTick;
    if (!(drain > 0)) return;
    const WALK_DRAIN_MULT = 0.5;
    for (const s of allSoldiers) {
      if (!s.movedThisTick) continue;
      s.fatigue = Math.max(0,
        s.fatigue - drain * s.fatigueDrainMultiplier * WALK_DRAIN_MULT);
    }
  }
}
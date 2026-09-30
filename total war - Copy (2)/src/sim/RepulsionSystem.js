import { CombatConfig } from '../config/CombatConfig.js';

// Continuous repulsion between soldiers, modeled on Total War's Warscape
// engine approach: each entity maintains a radius, and overlapping
// entities are pushed apart by a soft force rather than a discrete
// collision push. This replaces the earlier make-way push and
// collision-yield flag with a unified, force-based separation model.
//
// Key properties:
//   - Runs AFTER MovementSystem (voluntary movement applied first) and
//     BEFORE CollisionSystem (which still resolves hard overlaps for
//     pairs that repulsion couldn't clear, e.g. deeply overlapping
//     knocked-down soldiers or mass-pinned formations).
//   - Force scales with overlap depth (spring model), so a barely-touching
//     pair feels almost nothing while a deeply overlapping pair is
//     pushed apart strongly. No oscillation threshold.
//   - Friendlies use a smaller radius than enemies (soft same-team
//     collision, matching Total War: Arena's soft collision for
//     hostiles and the spacing-script approach for friendlies).
//   - When a marching soldier is detected as passing through a friendly
//     different-unit formation, the radius between those specific units
//     is reduced further (yielding), opening a soft corridor.
//   - Push is split by inverse mass, same as CollisionSystem, so a
//     cavalry soldier barely moves when repelled by an archer while the
//     archer takes most of the displacement.
//   - Does NOT set movedThisTick. Repulsion is involuntary, like
//     collision — it must not feed FacingSystem's "walked this tick"
//     branch.
//
// The yield detection pass is lightweight: a soldier only sets a yield
// flag when it detects a friendly different-unit soldier marching
// directly at it from close range, using the same heading/dot test as
// the old make-way code. Once the flag is set, the repulsion force
// handles the separation — no separate push is needed.
export class RepulsionSystem {
  constructor(spatialGrid) {
    this.spatialGrid = spatialGrid;
  }

  update(allSoldiers, unitsById, deltaSeconds) {
    const cfg = CombatConfig.repulsion;

    // --- Pass 1: reset yield flags, then detect pass-through relationships ---
    for (const s of allSoldiers) {
      s.repulsionYieldUnitId = null;
    }

    this._detectYielding(allSoldiers);

    // --- Pass 2: apply repulsion force to every overlapping pair ---
    const baseRadius = cfg.baseRadius;
    const friendlyMult = cfg.friendlyRadiusMult;
    const yieldingMult = cfg.yieldingRadiusMult;
    const springK = cfg.springK;
    const maxStepMult = cfg.maxStepSpeedMult;

    for (const a of allSoldiers) {
      if (!a.isAlive()) continue;
      if (a.state === 'knockedDown') continue;
      if (a.airborneTicksLeft > 0) continue;

      const nearby = this.spatialGrid.queryNearby(a.pos.x, a.pos.z, 1);
      const massA = a.effectiveMass;
      const walkSpeedA = a.effectiveMoveSpeed *
        CombatConfig.movement.globalSpeedScale * deltaSeconds;

      for (const b of nearby) {
        if (b === a) continue;
        if (!b.isAlive()) continue;
        if (b.state === 'knockedDown') continue;
        if (b.airborneTicksLeft > 0) continue;
        // Process each pair once. Lower id wins the tie so the outer loop
        // owns the pair and the inner loop skips it.
        if (a.id > b.id) continue;

        // Determine the pair's combined radius.
        let radiusA = baseRadius;
        let radiusB = baseRadius;

        const sameTeam = a.teamId === b.teamId;

        if (sameTeam) {
          radiusA *= friendlyMult;
          radiusB *= friendlyMult;

          // Yielding: if either side has flagged the other's unit as
          // being passed through, reduce both radii for this pair.
          if (a.repulsionYieldUnitId === b.unitId ||
              b.repulsionYieldUnitId === a.unitId) {
            radiusA *= yieldingMult;
            radiusB *= yieldingMult;
          }
        }

        const combinedRadius = radiusA + radiusB;
        const combinedRadiusSq = combinedRadius * combinedRadius;

        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq >= combinedRadiusSq) continue;

        // Extremely rare co-location — nudge them apart along +X.
        if (dSq < 0.0001) {
          a.pos.x -= 0.01;
          b.pos.x += 0.01;
          continue;
        }

        const d = Math.sqrt(dSq);
        const overlap = combinedRadius - d;
        const nx = dx / d;
        const nz = dz / d;

        // Spring force: proportional to overlap depth.
        const force = overlap * springK;

        // Cap the per-tick step so a deeply overlapping pair can't be
        // launched. Cap is relative to the lighter soldier's walk speed
        // (the one who will move further) — using the pair's lighter
        // walk speed keeps the cap meaningful for mixed formations.
        const massB = b.effectiveMass;
        const totalMass = massA + massB;
        const walkSpeedB = b.effectiveMoveSpeed *
          CombatConfig.movement.globalSpeedScale * deltaSeconds;
        const minWalkSpeed = Math.min(walkSpeedA, walkSpeedB);
        const maxStep = minWalkSpeed * maxStepMult;

        // Split by inverse mass: pushA gets massB's share, pushB gets
        // massA's share.
        let pushA = force * (massB / totalMass);
        let pushB = force * (massA / totalMass);

        // Cap both pushes at maxStep.
        if (pushA > maxStep) pushA = maxStep;
        if (pushB > maxStep) pushB = maxStep;

        a.pos.x -= nx * pushA;
        a.pos.z -= nz * pushA;
        b.pos.x += nx * pushB;
        b.pos.z += nz * pushB;
      }
    }
  }

  // Detect pass-through relationships: a soldier being marched through by
  // a friendly different-unit soldier. Sets repulsionYieldUnitId on both
  // sides of the relationship, so the repulsion pass finds it regardless
  // of iteration order.
  //
  // Same detection logic as the old make-way push: a friendly must be
  // actually moving (currentSpeed above a threshold), heading at the
  // blocker (dot of heading vs. to-me above a threshold), and within
  // close range. The blocker must be idle or marching (engaged, routing,
  // knocked-down soldiers do not yield).
  _detectYielding(allSoldiers) {
    const yieldRadius = CombatConfig.repulsion.baseRadius * 2.5;
    const yieldRadiusSq = yieldRadius * yieldRadius;
    const speedThreshold = CombatConfig.repulsion.yieldingSpeedThreshold ?? 0.1;
    const dotThreshold = CombatConfig.repulsion.yieldingDotThreshold ?? 0.4;

    for (const blocker of allSoldiers) {
      if (!blocker.isAlive()) continue;
      if (blocker.state === 'engaged' || blocker.state === 'staggered' ||
          blocker.state === 'knockedDown' || blocker.state === 'routing') {
        continue;
      }
      if (blocker.state !== 'idle' && blocker.state !== 'marching') continue;

      const nearby = this.spatialGrid.queryNearby(blocker.pos.x, blocker.pos.z, 1);

      for (const other of nearby) {
        if (other === blocker) continue;
        if (!other.isAlive()) continue;
        if (other.teamId !== blocker.teamId) continue;
        if (other.unitId === blocker.unitId) continue;
        if (other.currentSpeed < speedThreshold) continue;
        if (other.state === 'routing' || other.state === 'knockedDown') continue;

        const ox = blocker.pos.x - other.pos.x;
        const oz = blocker.pos.z - other.pos.z;
        const dSq = ox * ox + oz * oz;
        if (dSq > yieldRadiusSq || dSq < 0.0001) continue;

        const d = Math.sqrt(dSq);
        const toMeX = ox / d;
        const toMeZ = oz / d;

        const headingX = Math.sin(other.moveFacing);
        const headingZ = Math.cos(other.moveFacing);

        const dot = headingX * toMeX + headingZ * toMeZ;
        if (dot < dotThreshold) continue;

        // Record the relationship. Only flag the marching side if it
        // doesn't already have a flag set — a soldier being passed
        // through by two different units keeps whichever relationship
        // it detected first, which is enough for the repulsion
        // softening to work on both pairs.
        blocker.repulsionYieldUnitId = other.unitId;
        if (other.repulsionYieldUnitId === null) {
          other.repulsionYieldUnitId = blocker.unitId;
        }
      }
    }
  }
}
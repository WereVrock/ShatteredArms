// C1 — Retreat operation.
//
// Previously, posture 'retreat' returned null from LineBehavior: the unit
// stood where it was, in contact with the enemy, and got ground down. There
// was no concept of "withdrawing to a specific place," only "moving to a
// specific place."
//
// Retreat is now a multi-phase plan:
//   Disengage — unengaged units pull back toward a rally line; engaged
//               units hold (they cannot be yanked out of melee).
//   Screen    — the least-damaged line unit holds at the rally line,
//               facing the enemy, as a rear guard.
//   Reform    — all units gather at the rally line, no routing soldiers.
//
// If the reassessment after Reform still reads 'retreat', a fresh retreat
// plan is created with a new rally line further back. Retreat continues in
// waves rather than one deep withdrawal.
//
// Retreat is sticky per B1's priority rules: it cannot be preempted by
// combined-arms or hammer-and-anvil while active.
import { AIConfig } from '../../config/AIConfig.js';

function computeRallyLine(worldCtx) {
  // Rally line sits `retreatFallbackDist` behind the team's current mean
  // position, away from the enemy mean.
  const teamUnits = worldCtx.teamUnits;
  const enemyUnits = worldCtx.enemyUnits || [];

  let sx = 0, sz = 0, count = 0;
  for (const u of teamUnits) {
    if (u.isDefeated()) continue;
    const c = u.getCenter();
    sx += c.x; sz += c.z; count++;
  }
  if (count === 0) return null;
  const meanX = sx / count, meanZ = sz / count;

  let ex = 0, ez = 0, ecount = 0;
  for (const u of enemyUnits) {
    if (u.isDefeated()) continue;
    const c = u.getCenter();
    ex += c.x; ez += c.z; ecount++;
  }
  if (ecount === 0) return { x: meanX, z: meanZ };

  ex /= ecount; ez /= ecount;
  const dx = meanX - ex, dz = meanZ - ez;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 0.001) return { x: meanX, z: meanZ };

  const dist = AIConfig.retreatFallbackDist;
  return {
    x: meanX + (dx / d) * dist,
    z: meanZ + (dz / d) * dist
  };
}

function isUnitEngaged(unit) {
  return unit.getAliveSoldiers().some(
    s => s.state === 'engaged' || s.state === 'staggered'
  );
}

function distanceToPoint(unit, point) {
  if (!point) return Infinity;
  const c = unit.getCenter();
  const dx = point.x - c.x;
  const dz = point.z - c.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function allUnengagedAtLine(worldCtx, plan) {
  const line = plan.stagingPoint;
  if (!line) return true;
  const arrival = AIConfig.slotArrivalRadius * 3;
  for (const unit of worldCtx.teamUnits) {
    if (unit.isDefeated()) continue;
    if (isUnitEngaged(unit)) continue;
    if (distanceToPoint(unit, line) > arrival) return false;
  }
  return true;
}

function noRouting(worldCtx) {
  for (const unit of worldCtx.teamUnits) {
    if (unit.isDefeated()) continue;
    for (const s of unit.getAliveSoldiers()) {
      if (s.isRouting) return false;
    }
  }
  return true;
}

function pickRearGuard(teamUnits) {
  let best = null;
  let bestScore = -Infinity;
  for (const u of teamUnits) {
    if (u.isDefeated()) continue;
    const alive = u.getAliveSoldiers();
    if (alive.length === 0) continue;
    const hpFrac = alive.reduce((s, x) => s + x.hp / x.maxHp, 0) / alive.length;
    // Prefer high-HP, larger units.
    const score = hpFrac * 10 + alive.length * 0.05;
    if (score > bestScore) { bestScore = score; best = u; }
  }
  return best;
}

export const RetreatPlan = {
  id: 'retreat',

  // Retreat bypasses B3/B4 in PlanScheduler when posture is 'retreat';
  // evaluate() is still provided for API consistency.
  evaluate(worldCtx) {
    if (!worldCtx.assessment) return null;
    if (worldCtx.assessment.posture !== 'retreat') return null;
    return {
      applicable: true,
      upside: 0.5,
      downside: 0.2,
      successProb: 0.8
    };
  },

  build(worldCtx) {
    const line = computeRallyLine(worldCtx);
    if (!line) return null;

    const rearGuard = pickRearGuard(worldCtx.teamUnits);
    const roles = new Map();

    for (const unit of worldCtx.teamUnits) {
      if (unit.isDefeated()) continue;
      if (rearGuard && unit.id === rearGuard.id) {
        roles.set(unit.id, 'screen');
      } else {
        roles.set(unit.id, 'rally');
      }
    }

    const phases = [
      {
        name: 'disengage',
        // Timeout must cover retreatFallbackDist (8 world units) at the
        // slowest eligible unit's SIM-space speed. A shielded spearman at
        // globalSpeedScale 0.6 covers ~0.036 units/tick, so 8 units needs
        // ~220 ticks of straight-line travel — 400 leaves headroom for
        // interrupted movement and collision. The old 90 was ~3.3 units
        // of reachable travel and could never satisfy the exit condition.
        exitCondition: (ws, plan) => allUnengagedAtLine(ws, plan),
        timeoutTicks: 400
      },
      {
        name: 'screen',
        exitCondition: (ws, plan) => {
          if (!rearGuard || rearGuard.isDefeated()) return true;
          return distanceToPoint(rearGuard, plan.stagingPoint) <= AIConfig.slotArrivalRadius * 3;
        },
        timeoutTicks: 60
      },
      {
        name: 'reform',
        exitCondition: (ws) => noRouting(ws),
        timeoutTicks: 90
      }
    ];

    return {
      tactic: 'retreat',
      phases,
      objectiveUnitId: null,
      roles,
      stagingPoint: line
    };
  }
};
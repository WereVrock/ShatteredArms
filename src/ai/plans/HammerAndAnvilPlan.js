// D1 — Hammer-and-anvil.
//
// The first real tactic. Exercises every part of the plan layer:
//   - Persistent phases (B1).
//   - Pin detection (B2) drives the phase transition.
//   - Risk gate (B3) judges whether to commit given the current world.
//   - Weighted selection (B4) picks this tactic vs. combined-arms.
//   - Cavalry group (A3) is the hammer.
//   - Fragile units (A4) are excluded from the anvil.
//
// Phases:
//   Advance — anvil marches to contact; hammer stages off the flank.
//   Pin     — anvil fights; hammer holds. Exit when PinDetector says pinned.
//   Strike  — anvil holds; hammer charges the objective's flank/rear.
//   Exploit — everyone presses; objective destroyed or timeout.
//
// Aborts: objective dies (success), anvil destroyed, hammer destroyed, pin
// never reported within total timeout, phase timeout exceeded.
import { CombatConfig } from '../../config/CombatConfig.js';
import { AIConfig } from '../../config/AIConfig.js';
import { unitTypeOf, centerTowardUnit, isFragile } from '../behaviorUtils.js';
import { ChargeReadiness } from '../ChargeReadiness.js';

function avgHpFraction(unit) {
  const alive = unit.getAliveSoldiers();
  if (alive.length === 0) return 0;
  return alive.reduce((s, x) => s + x.hp / x.maxHp, 0) / alive.length;
}

function isInContact(unit, otherUnit, range) {
  if (!otherUnit || otherUnit.isDefeated()) return false;
  const c = unit.getCenter();
  const oc = otherUnit.getCenter();
  const dx = c.x - oc.x, dz = c.z - oc.z;
  return Math.sqrt(dx * dx + dz * dz) <= range;
}

function computeStagingPoint(cavUnits, objectiveUnit) {
  const objCenter = objectiveUnit.getCenter();
  if (cavUnits.length === 0) return objCenter;

  let sx = 0, sz = 0;
  for (const u of cavUnits) {
    const c = u.getCenter();
    sx += c.x; sz += c.z;
  }
  sx /= cavUnits.length; sz /= cavUnits.length;

  const dx = objCenter.x - sx, dz = objCenter.z - sz;
  const d = Math.sqrt(dx * dx + dz * dz) || 1;
  const ux = dx / d, uz = dz / d;
  const perpX = -uz, perpZ = ux;

  const cavRelX = sx - objCenter.x, cavRelZ = sz - objCenter.z;
  const sideSign = (cavRelX * perpX + cavRelZ * perpZ) >= 0 ? 1 : -1;

  const offset = AIConfig.cavalryApproachOffset || 5.0;
  return {
    x: objCenter.x + perpX * sideSign * offset,
    z: objCenter.z + perpZ * sideSign * offset
  };
}

function pickAnvilUnits(teamUnits, objectiveUnit, maxCount) {
  // Line units nearest the objective; fragile (A4) excluded.
  const candidates = [];
  for (const u of teamUnits) {
    if (u.isDefeated()) continue;
    const t = unitTypeOf(u);
    if (!t || t.isCavalry || t.isRanged) continue;
    if (isFragile(u, AIConfig.fragileMoraleThreshold)) continue;
    const { dist } = centerTowardUnit(u, objectiveUnit);
    candidates.push({ unit: u, dist });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.slice(0, maxCount).map(c => c.unit);
}

export const HammerAndAnvilPlan = {
  id: 'hammer_and_anvil',

  evaluate(worldCtx) {
    const assessment = worldCtx.assessment;
    if (!assessment || assessment.posture === 'retreat') return null;

    const objective = worldCtx.objectiveUnit;
    if (!objective || objective.isDefeated()) return null;

    const cavalry = worldCtx.teamUnits.filter(u => {
      if (u.isDefeated()) return false;
      const t = unitTypeOf(u);
      return t && t.isCavalry;
    });
    if (cavalry.length === 0) return null; // no hammer, no tactic

    let anvilCandidateCount = 0;
    for (const u of worldCtx.teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || t.isCavalry || t.isRanged) continue;
      if (isFragile(u, AIConfig.fragileMoraleThreshold)) continue;
      anvilCandidateCount++;
    }
    if (anvilCandidateCount === 0) return null;

    const objAlive = objective.getAliveSoldiers();
    if (objAlive.length === 0) return null;

    // Reachability gate. The anvil advances at a slow SIM-space speed (see
    // HammerAndAnvilPlan advance-phase comment); an objective farther than
    // this can't be reached before the advance timeout aborts the plan, so
    // don't offer the plan as a candidate at all. Cavalry move faster, but
    // the anvil is the constraint the tactic's timing depends on.
    //
    // Conservative: 12 design units. Straight-line reach at 500 ticks is
    // ~18 units, but the anvil will usually be intercepted by the enemy's
    // front line en route, so the effective usable reach is much shorter.
    const anvilDistanceCap = 12;
    let nearestAnvilDist = Infinity;
    for (const u of worldCtx.teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || t.isCavalry || t.isRanged) continue;
      const c = u.getCenter();
      const oc = objective.getCenter();
      const dx = c.x - oc.x;
      const dz = c.z - oc.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < nearestAnvilDist) nearestAnvilDist = d;
    }
    if (nearestAnvilDist > anvilDistanceCap) return null;

    const hpFrac = avgHpFraction(objective);
    const upside = 0.75 + (hpFrac < 0.5 ? 0.2 : 0);
    const downside = 0.6;

    let successProb = 0.5;
    try {
      const readiness = ChargeReadiness.assess(cavalry[0], objective, worldCtx.enemyUnits, 0, worldCtx);
      if (readiness && readiness.willLandClean) successProb += 0.15;
      else successProb -= 0.1;
    } catch (e) { /* leave default */ }

    return {
      applicable: true,
      objectiveUnitId: objective.id,
      upside,
      downside,
      successProb: Math.max(0.1, Math.min(0.95, successProb))
    };
  },

  build(worldCtx, evalResult, scheduler) {
    const objective = worldCtx.objectiveUnit;
    if (!objective || objective.isDefeated()) return null;

    const cavalry = [];
    const lineCandidates = [];
    for (const u of worldCtx.teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t) continue;
      if (t.isCavalry) cavalry.push(u);
      else if (!t.isRanged) lineCandidates.push(u);
    }
    if (cavalry.length === 0) return null;

    // Anvil count: roughly 1.5 line units per engaged enemy line unit,
    // scaled from the objective's alive count. Capped at what we have.
    const objAlive = objective.getAliveSoldiers().length;
    const anvilCount = Math.max(1, Math.min(lineCandidates.length, Math.ceil(objAlive / 60)));
    const anvil = pickAnvilUnits(worldCtx.teamUnits, objective, anvilCount);
    if (anvil.length === 0) return null;

    const hammer = cavalry;
    const stagingPoint = computeStagingPoint(hammer, objective);
    const objectiveId = objective.id;

    const roles = new Map();
    for (const u of anvil) roles.set(u.id, 'anvil');
    for (const u of hammer) roles.set(u.id, 'hammer');

    const pinMinHold = scheduler && scheduler.tierCfg
      ? (scheduler.tierCfg.pinMinHoldDurationTicks || 0)
      : 0;
    const pinDetector = scheduler ? scheduler.pinDetector : null;

    const phases = [
      {
        name: 'advance',
        // Timeout must cover the anvil's approach to the objective at the
        // anvil's SIM-space speed. At globalSpeedScale 0.6 a shielded
        // spearman covers ~0.036 units/tick, so 500 ticks reaches ~18
        // world units — enough for the anvil distances H&A is meant to
        // take (front-line objectives). The old 240 reached only ~8.7
        // units and timed out on every engagement in the log.
        exitCondition: (ws) => {
          for (const u of anvil) {
            if (u.isDefeated()) continue;
            if (isInContact(u, objective, CombatConfig.chargeSpotRange + 1.5)) return true;
          }
          return false;
        },
        timeoutTicks: 500
      },
      {
        name: 'pin',
        exitCondition: (ws) => {
          if (!pinDetector) return false;
          const obj = ws.enemyUnits.find(u => u.id === objectiveId);
          if (!obj || obj.isDefeated()) return true;
          const result = pinDetector.assess(obj, ws.currentTick, pinMinHold);
          return result.pinned;
        },
        timeoutTicks: 240
      },
      {
        name: 'strike',
        exitCondition: (ws) => {
          for (const u of hammer) {
            if (u.isDefeated()) continue;
            if (u.getAliveSoldiers().some(s => s.state === 'engaged')) return true;
          }
          return false;
        },
        timeoutTicks: 90
      },
      {
        name: 'exploit',
        exitCondition: (ws) => {
          const obj = ws.enemyUnits.find(u => u.id === objectiveId);
          return !obj || obj.isDefeated();
        },
        timeoutTicks: 240
      }
    ];

    return {
      tactic: 'hammer_and_anvil',
      phases,
      objectiveUnitId: objectiveId,
      roles,
      stagingPoint
    };
  }
};
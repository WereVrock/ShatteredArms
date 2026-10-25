// C2 — Combined-arms sequencing.
//
// Archers fire, cavalry charges, and infantry advances all currently happen
// in parallel, on independent clocks. Real combined arms is about sequence:
// soften with arrows, charge the softened target, advance through the gap.
//
// Phases:
//   Bombard — archers focus-fire the objective; infantry hold; cavalry
//             holds at staging.
//   Charge  — cavalry charges the objective; infantry advances to contact.
//   Exploit — all units press the objective.
//
// Key timing property: the charge phase does not begin until the bombard
// phase's exit condition holds. If the objective never softens within the
// bombard timeout, the plan aborts rather than charging a fresh target.
import { CombatConfig } from '../../config/CombatConfig.js';
import { AIConfig } from '../../config/AIConfig.js';
import { unitTypeOf } from '../behaviorUtils.js';

function avgHpFraction(unit) {
  const alive = unit.getAliveSoldiers();
  if (alive.length === 0) return 0;
  return alive.reduce((s, x) => s + x.hp / x.maxHp, 0) / alive.length;
}

function isUnitInContactWith(unit, targetUnit, range) {
  if (!targetUnit || targetUnit.isDefeated()) return false;
  const c = unit.getCenter();
  const tc = targetUnit.getCenter();
  const dx = c.x - tc.x, dz = c.z - tc.z;
  return Math.sqrt(dx * dx + dz * dz) <= range;
}

// Staging point: offset perpendicular to the objective, on whichever side
// the cavalry is currently closer to — no need to cross the objective's
// face to reach it, and this keeps the hammer out of the archers' line.
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

export const CombinedArmsPlan = {
  id: 'combined_arms',

  evaluate(worldCtx) {
    const assessment = worldCtx.assessment;
    if (!assessment || assessment.posture === 'retreat') return null;

    const objective = worldCtx.objectiveUnit;
    if (!objective || objective.isDefeated()) return null;

    // Need at least one archer and one line unit.
    let archerCount = 0;
    let lineCount = 0;
    for (const u of worldCtx.teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t) continue;
      if (t.isRanged) archerCount++;
      else if (!t.isCavalry) lineCount++;
    }
    if (archerCount === 0 || lineCount === 0) return null;

    const hpFrac = avgHpFraction(objective);
    const softened = hpFrac <= 0.7 ? 0.3 : 0;

    return {
      applicable: true,
      objectiveUnitId: objective.id,
      upside: 0.6 + softened,
      downside: 0.35,
      successProb: 0.55 + (hpFrac < 0.5 ? 0.15 : 0)
    };
  },

  build(worldCtx) {
    const objective = worldCtx.objectiveUnit;
    if (!objective || objective.isDefeated()) return null;

    const archers = [];
    const lines = [];
    const cavalry = [];
    for (const u of worldCtx.teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t) continue;
      if (t.isRanged) archers.push(u);
      else if (t.isCavalry) cavalry.push(u);
      else lines.push(u);
    }

    const stagingPoint = computeStagingPoint(cavalry, objective);

    const roles = new Map();
    for (const u of archers) roles.set(u.id, 'bombard');
    for (const u of lines) roles.set(u.id, 'hold');
    for (const u of cavalry) roles.set(u.id, 'staging');

    // Bombard threshold is intentionally permissive: the exit condition
    // asks "have archers clearly softened this objective?", not "have
    // archers brought it to half HP." A tight threshold times out on
    // shielded / moving objectives the archers only partially hit, and
    // the plan then aborts (correct per design) and re-creates (not
    // correct — see PlanScheduler abort cooldown). 0.75 gives archers
    // ~3-4 volleys before the phase is considered done.
    const targetHpFrac = 0.75;
    const bombardTimeout = 300; // ~20s at 15Hz, room for 3-4 volleys plus travel
    const chargeTimeout = 90;
    const objectiveId = objective.id;

    const phases = [
      {
        name: 'bombard',
        exitCondition: (ws) => {
          const obj = ws.enemyUnits.find(u => u.id === objectiveId);
          if (!obj || obj.isDefeated()) return true;
          return avgHpFraction(obj) <= targetHpFrac;
        },
        timeoutTicks: bombardTimeout
      },
      {
        name: 'charge',
        exitCondition: (ws) => {
          const obj = ws.enemyUnits.find(u => u.id === objectiveId);
          if (!obj || obj.isDefeated()) return true;
          for (const u of cavalry) {
            if (u.isDefeated()) continue;
            if (isUnitInContactWith(u, obj, CombatConfig.chargeSpotRange)) return true;
            if (u.getAliveSoldiers().some(s => s.state === 'engaged')) return true;
          }
          return false;
        },
        timeoutTicks: chargeTimeout
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
      tactic: 'combined_arms',
      phases,
      objectiveUnitId: objectiveId,
      roles,
      stagingPoint
    };
  }
};
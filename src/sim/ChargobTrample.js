import { CombatConfig } from '../config/CombatConfig.js';

// A charging beast throws everybody it runs into: enemies AND its own
// soldiers and handlers, regardless of panic. The throw writes the same
// soldier fields the melee charge throw uses (knockbackVel, airborne*,
// throwPeakHeight, knockedDownTicksLeft); the integration of those fields is
// done by the normal systems. It deals no damage. A thrown soldier cannot be
// thrown again for trampleCooldownTicks, and soldiers that are already in the
// air or on the ground are left alone.
//
// Victims are the units' soldiers (not other beasts).

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function throwSoldier(beast, v, tick) {
  const c = CombatConfig.chargob;
  const ch = CombatConfig.charge;

  const ratio = beast.effectiveMass / Math.max(0.1, v.effectiveMass);
  const speed = clamp(
    c.trampleVelocityPerRatio * Math.min(ratio, ch.maxThrowMassRatioScale),
    c.trampleMinVelocity,
    ch.maxKnockbackVelocity
  );

  // Along the course, pushed sideways away from the beast's line.
  let ax = v.pos.x - beast.pos.x;
  let az = v.pos.z - beast.pos.z;
  const al = Math.sqrt(ax * ax + az * az);
  if (al > 0.01) { ax /= al; az /= al; } else { ax = 0; az = 0; }
  let dx = beast.chargeDirX + ax * 0.5;
  let dz = beast.chargeDirZ + az * 0.5;
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl < 1e-6) { dx = beast.chargeDirX; dz = beast.chargeDirZ; } else { dx /= dl; dz /= dl; }

  v.knockbackVel = { x: dx * speed, z: dz * speed };
  v.airborneTicksLeft = ch.knockbackDurationTicks;
  v.airborneTotalTicks = ch.knockbackDurationTicks;
  v.throwPeakHeight = Math.min(ch.maxThrowHeight, speed * ch.throwHeightPerVelocity);
  v.knockedDownTicksLeft = ch.knockedDownDurationTicks;
  v.staggerTicksLeft = 0;
  v.stateBeforeStagger = null;
  v.targetId = null;
  v.pushedSinceLastMovement = true;
  if (v.state !== 'routing' && v.state !== 'shattered') v.state = 'knockedDown';
  v.trampleUntil = tick + c.trampleCooldownTicks;
}

export const ChargobTrample = {
  // Per tick, after the units' beasts were updated.
  update(units, tick) {
    const r = CombatConfig.chargob.trampleRadius;
    const r2 = r * r;

    for (let u = 0; u < units.length; u++) {
      const unit = units[u];
      if (unit.companionKind !== 'chargob') continue;
      const companions = unit.companions;

      for (let i = 0; i < companions.length; i++) {
        const beast = companions[i];
        if (!beast.isAlive() || !beast.chargeActive) continue;

        for (let k = 0; k < units.length; k++) {
          const soldiers = units[k].soldiers;
          for (let m = 0; m < soldiers.length; m++) {
            const v = soldiers[m];
            if (!v.isAlive()) continue;
            const dx = v.pos.x - beast.pos.x;
            const dz = v.pos.z - beast.pos.z;
            if (dx * dx + dz * dz > r2) continue;
            if (v.trampleUntil > tick || v.airborneTicksLeft > 0 || v.knockedDownTicksLeft > 0) continue;
            throwSoldier(beast, v, tick);
          }
        }
      }
    }
  }
};
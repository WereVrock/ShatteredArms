import { CombatConfig } from '../config/CombatConfig.js';
import { ChargobHandlers } from './ChargobHandlers.js';

// Panic of chargob beasts (0..100, per beast, soldier.panic).
//
// Rises with:
//   - damage taken: panicDamageScale * (hp lost / maxHp), read from the HP
//     difference since last tick, so every damage source counts;
//   - a beast of the herd dying within panicBeastDeathRadius (diminishing
//     when several die within a few seconds);
//   - a handler of the unit dying within panicHandlerDeathRadius;
//   - the handler loss of the unit, as a floor: panicLossFloor * loss fraction.
// Falls when the beast took no damage for panicCalmTicks: panicDecayCalm per
// second, panicDecayHandler per second while a handler stands within pushRange.
//
// Every beast has a fixed random bias (panicBias, +-panicBiasRange), so the
// herd never breaks all at once. The EFFECTIVE panic is panic + bias.
//
// What panic does lives elsewhere: ChargobForces (enemy push and the walk
// home grow with resistance(), see below) and ChargobSystem (a beast at its
// charge threshold charges in the direction it looks).

const _events = [];

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export const ChargobPanic = {
  // Panic as the forces see it: 0..100.
  effective(b) {
    return clamp(b.panic + b.panicBias, 0, 100);
  },

  // Raw panic at which this beast charges (90..100: a negative bias breaks earlier).
  chargeThreshold(b) {
    return 100 + Math.min(0, b.panicBias);
  },

  shouldCharge(b) {
    return b.panic >= ChargobPanic.chargeThreshold(b);
  },

  // 0 up to panicFleeStart, then rising to 1 at 100 along an exponent curve.
  // Scales the enemy push and the walk home.
  resistance(pe) {
    const c = CombatConfig.chargob;
    const t = clamp((pe - c.panicFleeStart) / (100 - c.panicFleeStart), 0, 1);
    return Math.pow(t, c.panicResistExp);
  },

  // Per tick, before the herd is placed. `line` = beasts standing in the herd.
  update(unit, line) {
    const c = CombatConfig.chargob;
    const dt = 1 / CombatConfig.tickRateHz;
    _events.length = 0;

    unit._panicRecentDeaths = Math.max(0, (unit._panicRecentDeaths || 0) - dt / 3);

    // Handler deaths.
    const soldiers = unit.soldiers;
    let dead = 0;
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (s.isAlive()) continue;
      dead++;
      if (s.panicSeenDead) continue;
      s.panicSeenDead = true;
      _events.push({
        x: s.pos.x,
        z: s.pos.z,
        amount: c.panicHandlerDeath,
        r2: c.panicHandlerDeathRadius * c.panicHandlerDeathRadius
      });
    }
    const loss = soldiers.length > 0 ? dead / soldiers.length : 0;
    const floor = c.panicLossFloor * loss;

    // Beast deaths (a charging beast dying at the edge does not count).
    const companions = unit.companions;
    for (let i = 0; i < companions.length; i++) {
      const b = companions[i];
      if (b.isAlive() || b.panicSeenDead || b.beastDetached) continue;
      b.panicSeenDead = true;
      const recent = unit._panicRecentDeaths || 0;
      unit._panicRecentDeaths = recent + 1;
      _events.push({
        x: b.pos.x,
        z: b.pos.z,
        amount: c.panicBeastDeath / (1 + 0.5 * recent),
        r2: c.panicBeastDeathRadius * c.panicBeastDeathRadius
      });
    }

    const nearR2 = c.pushRange * c.pushRange;
    for (let i = 0; i < line.length; i++) {
      const b = line[i];
      let gain = 0;

      const lost = b.panicHp - b.hp;
      if (lost > 0) gain += c.panicDamageScale * lost / Math.max(1, b.maxHp);
      b.panicHp = b.hp;

      for (let k = 0; k < _events.length; k++) {
        const ev = _events[k];
        const dx = ev.x - b.pos.x;
        const dz = ev.z - b.pos.z;
        if (dx * dx + dz * dz <= ev.r2) gain += ev.amount;
      }

      if (gain > 0) {
        b.panic += gain;
        b.panicCalmTicks = 0;
      } else {
        b.panicCalmTicks++;
        if (b.panicCalmTicks >= c.panicCalmTicks) {
          let handlerNear = false;
          for (let k = 0; k < soldiers.length; k++) {
            const h = soldiers[k];
            if (!ChargobHandlers.usable(h)) continue;
            const dx = h.pos.x - b.pos.x;
            const dz = h.pos.z - b.pos.z;
            if (dx * dx + dz * dz <= nearR2) { handlerNear = true; break; }
          }
          b.panic -= (handlerNear ? c.panicDecayHandler : c.panicDecayCalm) * dt;
        }
      }
      b.panic = clamp(b.panic, floor, 100);
    }
  },

  // Numbers for the UI: beasts in the herd, beasts charging, panic average / maximum.
  summary(unit) {
    let beasts = 0;
    let charging = 0;
    let sum = 0;
    let max = 0;
    const companions = unit.companions;
    for (let i = 0; i < companions.length; i++) {
      const b = companions[i];
      if (!b.isAlive()) continue;
      if (b.beastDetached || b.chargeActive) { charging++; continue; }
      if (b.state === 'routing' || b.state === 'shattered') continue;
      beasts++;
      sum += b.panic;
      if (b.panic > max) max = b.panic;
    }
    return { beasts, charging, avg: beasts > 0 ? sum / beasts : 0, max };
  }
};
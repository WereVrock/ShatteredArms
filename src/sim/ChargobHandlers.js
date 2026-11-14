import { CombatConfig } from '../config/CombatConfig.js';

// Small helpers of the handler side of the chargob herd. The decisions (which
// handler works on which beast) are ChargobHandlerAI, the forces on the beasts
// are ChargobForces; goading is ChargobPoke.
//
// Handlers claimed by ChargobPoke this tick are listed in unit._busyHandlers
// (see begin()); the herding AI leaves them alone.
//
// A handler that works (herds or goads) RUNS: run() sets soldier.herdRunSet,
// which Soldier.effectiveMoveSpeed turns into handlerSpeedMult, and asks for
// the run gait. begin() clears the flag every tick, so it only lasts while
// something keeps setting it.
//
// usable() is "free for beast work": a handler in melee (engaged) is not,
// it fights.

const _contactBuf = [];

function usable(s) {
  if (!s || !s.isAlive()) return false;
  const st = s.state;
  return st !== 'routing' && st !== 'shattered' && st !== 'knockedDown' && st !== 'engaged';
}

export const ChargobHandlers = {
  usable,

  // Start of a beast pass: nobody is claimed yet and nobody runs.
  begin(unit) {
    if (!unit._busyHandlers) unit._busyHandlers = new Set();
    unit._busyHandlers.clear();
    const soldiers = unit.soldiers;
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (s.herdRunSet) {
        s.herdRunSet = false;
        s.gaitRunning = false;
      }
    }
  },

  // The handler works this tick: it runs.
  run(h) {
    h.herdRunSet = true;
    h.gaitRunning = true;
  },

  // True when a handler is in melee or an enemy stands within
  // meleeContactReach of one. The handlers then stop holding back and fight
  // (unit.chargobHold, see ChargobSystem).
  inContact(unit, grid) {
    const reach = CombatConfig.chargob.meleeContactReach;
    const r2 = reach * reach;
    const soldiers = unit.soldiers;

    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (s.isAlive() && s.state === 'engaged') return true;
    }

    const cells = Math.ceil(reach / grid.cellSize) + 1;
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s.isAlive()) continue;
      const st = s.state;
      if (st === 'routing' || st === 'shattered' || st === 'knockedDown') continue;
      const near = grid.queryNearbyIntoExcludingTeam(_contactBuf, s.pos.x, s.pos.z, cells, s.teamId);
      for (let k = 0; k < near.length; k++) {
        const o = near[k];
        if (!o.isAlive()) continue;
        const dx = o.pos.x - s.pos.x;
        const dz = o.pos.z - s.pos.z;
        if (dx * dx + dz * dz <= r2) return true;
      }
    }
    return false;
  },

  // Living beasts of the unit, the things handlers walk round.
  obstacles(unit, out) {
    out.length = 0;
    const companions = unit.companions;
    for (let i = 0; i < companions.length; i++) {
      if (companions[i].isAlive()) out.push(companions[i]);
    }
    return out;
  },

  // Writes into `out` the point to walk to on the way from (px, pz) to
  // (qx, qz): the target itself, or a point beside the first beast that
  // stands on the way. Beasts right next to the target are ignored (the
  // beast being worked on, for one).
  steer(px, pz, qx, qz, obst, out) {
    const c = CombatConfig.chargob;
    out.x = qx;
    out.z = qz;

    const dx = qx - px;
    const dz = qz - pz;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.5) return out;
    const ux = dx / len;
    const uz = dz / len;
    const nx = -uz;
    const nz = ux;
    const skipSq = c.endSkip * c.endSkip;

    let best = null;
    let bestT = Infinity;
    let bestLat = 0;
    for (let i = 0; i < obst.length; i++) {
      const o = obst[i];
      const ox = o.pos.x - px;
      const oz = o.pos.z - pz;
      const t = ox * ux + oz * uz;
      if (t < 0.2 || t > len) continue;
      const lat = ox * nx + oz * nz;
      if (lat > c.avoidRadius || lat < -c.avoidRadius) continue;
      const ex = o.pos.x - qx;
      const ez = o.pos.z - qz;
      if (ex * ex + ez * ez < skipSq) continue;
      if (t < bestT) { bestT = t; best = o; bestLat = lat; }
    }
    if (best === null) return out;

    const side = bestLat >= 0 ? -1 : 1;
    out.x = best.pos.x + nx * side * c.avoidClear;
    out.z = best.pos.z + nz * side * c.avoidClear;
    return out;
  },

  // Cosmetic hit of a handler on the beast it pushes: an 'attack' event now
  // and then, no damage.
  hit(h, b, combat) {
    const c = CombatConfig.chargob;
    if (h.herdHitCd > 0) {
      h.herdHitCd--;
      return;
    }
    if (!combat) return;
    const dx = b.pos.x - h.pos.x;
    const dz = b.pos.z - h.pos.z;
    if (dx * dx + dz * dz <= c.hitReach * c.hitReach) {
      combat.events.push({ type: 'attack', attackerId: h.id, defenderId: b.id });
      h.herdHitCd = c.hitMinTicks + Math.floor(Math.random() * (c.hitMaxTicks - c.hitMinTicks));
    }
  }
};
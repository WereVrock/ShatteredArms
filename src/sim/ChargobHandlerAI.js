import { CombatConfig } from '../config/CombatConfig.js';
import { ChargobPack } from './ChargobPack.js';
import { ChargobHandlers } from './ChargobHandlers.js';
import { ChargobForces } from './ChargobForces.js';

// The unit AI of a chargob unit: decides WHICH handler works on WHICH beast.
// The player (or the team AI) only gives move / attack orders; those move the
// herd places (ChargobHerd) and this module sends handlers to bring the beasts
// there. It writes only soldier.herdAnchorId / herdSlotIdx / formationSlot of
// the handlers and beast.herdWanted / herdPullWanted. The forces themselves
// are ChargobForces.
//
// A beast needs handlers when it has to go to its place (herdNeed) or it is a
// stray (far from its place, beastStray). Strays come first, then the most
// panicked beasts, so a free handler always goes to the worst case. A calm
// beast that is fighting an enemy (ChargobForces.fightsHere) needs nobody.
//
//   stray                    1 handler, PULL (a pull always works)
//   enemy push + walk home   n handlers PUSH, the smallest n whose power beats
//   (beast.herdResist)       the resistance by resistMargin. If even
//                            maxPushHandlers cannot, one handler PULLS instead.
//
// Push: the handler stands `standoff` behind the beast (seen from where the
// beast has to go), extra handlers beside it. Pull: it stands pullStand in
// front of the beast, so the beast follows. Handlers walk round other beasts
// and RUN while they work. A handler that gets into melee drops its beast
// (ChargobHandlers.usable) and fights.
// Handlers claimed by ChargobPoke this tick (unit._busyHandlers) are not used.

const _wp = { x: 0, z: 0 };
const _obst = [];
const _needy = [];
const _count = new Map();

function byPriority(a, b) {
  if (a.beastStray !== b.beastStray) return a.beastStray ? -1 : 1;
  return b.panic - a.panic;
}

// How many handlers beast `b` needs; also sets b.herdPullWanted.
function wantedFor(b) {
  const c = CombatConfig.chargob;
  if (b.beastStray) {
    b.herdPullWanted = true;
    return 1;
  }
  const need = b.herdResist * c.resistMargin;
  if (need > ChargobForces.pushPower(c.maxPushHandlers)) {
    b.herdPullWanted = true;
    return 1;
  }
  b.herdPullWanted = false;
  let k = 1;
  while (k < c.maxPushHandlers && ChargobForces.pushPower(k) < need) k++;
  return k;
}

function nearestFree(unit, b, busy) {
  const soldiers = unit.soldiers;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < soldiers.length; i++) {
    const h = soldiers[i];
    if (!ChargobHandlers.usable(h) || busy.has(h.id) || h.herdAnchorId !== null) continue;
    const dx = h.pos.x - b.pos.x;
    const dz = h.pos.z - b.pos.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

export const ChargobHandlerAI = {
  // Per tick, after ChargobPoke.update. `line` = the beasts in the herd.
  dispatch(unit, line, byId, combat) {
    const soldiers = unit.soldiers;
    const busy = unit._busyHandlers;

    _needy.length = 0;
    for (let i = 0; i < line.length; i++) {
      const b = line[i];
      b.herdPullWanted = false;
      if ((b.beastStray || b.herdNeed) && !ChargobForces.fightsHere(b)) {
        b.herdWanted = wantedFor(b);
        _needy.push(b);
      } else {
        b.herdWanted = 0;
      }
    }
    _needy.sort(byPriority);

    // Handlers keep their beast while it still needs them.
    _count.clear();
    for (let i = 0; i < soldiers.length; i++) {
      const h = soldiers[i];
      if (h.herdAnchorId === null) continue;
      const b = byId.get(h.herdAnchorId);
      const cnt = b ? (_count.get(b.id) || 0) : 0;
      const keep = !!b
        && ChargobPack.isInLine(b)
        && b.herdWanted > 0
        && cnt < b.herdWanted
        && ChargobHandlers.usable(h)
        && !busy.has(h.id);
      if (keep) {
        h.herdSlotIdx = cnt;
        _count.set(b.id, cnt + 1);
      } else {
        h.herdAnchorId = null;
      }
    }

    // Beasts that still lack handlers get the nearest free ones.
    let exhausted = false;
    for (let i = 0; i < _needy.length && !exhausted; i++) {
      const b = _needy[i];
      let cnt = _count.get(b.id) || 0;
      while (cnt < b.herdWanted) {
        const h = nearestFree(unit, b, busy);
        if (!h) { exhausted = true; break; }
        h.herdAnchorId = b.id;
        h.herdSlotIdx = cnt;
        cnt++;
      }
      _count.set(b.id, cnt);
    }

    // Walk the handlers.
    ChargobHandlers.obstacles(unit, _obst);
    let any = false;
    for (let i = 0; i < soldiers.length; i++) {
      const h = soldiers[i];
      if (h.herdAnchorId === null) continue;
      const b = byId.get(h.herdAnchorId);
      if (!b) { h.herdAnchorId = null; continue; }
      any = true;
      busy.add(h.id);
      ChargobHandlerAI._act(unit, h, b, combat);
    }
    // Walking handlers must not stop short of their position.
    if (any) {
      unit._settleToleranceBonus = 0;
      unit._settled = false;
    }
  },

  _act(unit, h, b, combat) {
    const c = CombatConfig.chargob;
    ChargobHandlers.run(h);

    // Direction the beast has to go.
    const dx = b.herdTx - b.pos.x;
    const dz = b.herdTz - b.pos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    let gx;
    let gz;
    if (len > 0.3) {
      gx = dx / len;
      gz = dz / len;
    } else {
      const f = typeof unit._beastFacing === 'number' ? unit._beastFacing : unit.formationFacing;
      gx = Math.sin(f);
      gz = Math.cos(f);
    }

    // Extra handlers of one beast stand beside the first one.
    const idx = h.herdSlotIdx | 0;
    const lat = idx === 0 ? 0 : (idx % 2 ? 1 : -1) * Math.ceil(idx / 2) * c.handlerLateral;
    const px = -gz;
    const pz = gx;

    let tx;
    let tz;
    if (b.herdPullWanted) {
      tx = b.pos.x + gx * c.pullStand + px * lat * 0.5;
      tz = b.pos.z + gz * c.pullStand + pz * lat * 0.5;
    } else {
      tx = b.pos.x - gx * c.standoff + px * lat;
      tz = b.pos.z - gz * c.standoff + pz * lat;
    }

    ChargobHandlers.steer(h.pos.x, h.pos.z, tx, tz, _obst, _wp);
    h.formationSlot.x = _wp.x;
    h.formationSlot.z = _wp.z;

    if (!b.herdPullWanted) ChargobHandlers.hit(h, b, combat);
  }
};
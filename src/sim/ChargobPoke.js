import { CombatConfig } from '../config/CombatConfig.js';
import { ChargobPack } from './ChargobPack.js';
import { ChargobHandlers } from './ChargobHandlers.js';

// Goading beasts into a charge. The player's "charge" button sets
// unit.chargobWanted: how many beasts are still to be sent. For every wanted
// beast a job exists: three DIFFERENT handlers walk to the beast's rear and
// must stand there, all three together, for pokeSeconds. Only then does the
// beast charge (beast.chargePending = 'poke') and the wanted count drops by
// one. Lowering the count cancels the newest jobs; a job whose handlers are
// not all in place restarts its timer. Nothing happens automatically: the
// handlers really walk and really have to arrive. While they stand there they
// hit the beast now and then (an 'attack' event, for show).
//
// The beast chosen is the frontmost one whose rear point is free of other
// beasts. The handlers walk round the other beasts on the way
// (ChargobHandlers.steer) and are claimed in unit._busyHandlers so the herding
// dispatch leaves them alone.
//
// Job: { beastId, pokerIds: [handlerId], ticks }. Stored on unit._pokeJobs.
// Does nothing once the beasts have been abandoned.

const _obst = [];
const _wp = { x: 0, z: 0 };

function herdFacing(unit) {
  return typeof unit._beastFacing === 'number' ? unit._beastFacing : unit.formationFacing;
}

// True when no other beast of the line stands at the point behind `b`.
function rearClear(b, line) {
  const c = CombatConfig.chargob;
  const rx = b.pos.x - Math.sin(b.facing) * c.pokeDistance;
  const rz = b.pos.z - Math.cos(b.facing) * c.pokeDistance;
  const r2 = c.pokeClearRadius * c.pokeClearRadius;
  for (let i = 0; i < line.length; i++) {
    const o = line[i];
    if (o === b) continue;
    const dx = o.pos.x - rx;
    const dz = o.pos.z - rz;
    if (dx * dx + dz * dz < r2) return false;
  }
  return true;
}

// Frontmost beast without a job, preferring one with a free rear.
function pickBeast(unit, line, jobs) {
  const f = herdFacing(unit);
  const fx = Math.sin(f);
  const fz = Math.cos(f);
  let best = null;
  let bestF = -Infinity;
  let clear = null;
  let clearF = -Infinity;
  for (let i = 0; i < line.length; i++) {
    const b = line[i];
    let taken = false;
    for (let k = 0; k < jobs.length; k++) {
      if (jobs[k].beastId === b.id) { taken = true; break; }
    }
    if (taken) continue;
    const fw = b.pos.x * fx + b.pos.z * fz;
    if (fw > bestF) { bestF = fw; best = b; }
    if (fw > clearF && rearClear(b, line)) { clearF = fw; clear = b; }
  }
  return clear || best;
}

// Tops the job up to `need` handlers, nearest to the rear point first.
function fillPokers(unit, job, rearX, rearZ, need) {
  const busy = unit._busyHandlers;
  while (job.pokerIds.length < need) {
    let best = null;
    let bestD = Infinity;
    const soldiers = unit.soldiers;
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!ChargobHandlers.usable(s) || busy.has(s.id)) continue;
      const dx = s.pos.x - rearX;
      const dz = s.pos.z - rearZ;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best) return;
    job.pokerIds.push(best.id);
    busy.add(best.id);
  }
}

export const ChargobPoke = {
  // Numbers for the UI: beasts left in the line, beasts still wanted, jobs running.
  info(unit) {
    if (unit.companionKind !== 'chargob' || unit.chargobAbandoned) {
      return { available: 0, wanted: 0, jobs: 0 };
    }
    let available = 0;
    for (const c of unit.companions) {
      if (ChargobPack.isInLine(c)) available++;
    }
    return {
      available,
      wanted: unit.chargobWanted | 0,
      jobs: unit._pokeJobs ? unit._pokeJobs.length : 0
    };
  },

  // Left click +1, right click -1. Returns true when the count changed.
  adjust(unit, delta) {
    if (unit.companionKind !== 'chargob' || unit.leavingBattle || unit.chargobAbandoned) return false;
    const available = ChargobPoke.info(unit).available;
    const next = Math.max(0, Math.min(available, (unit.chargobWanted | 0) + delta));
    if (next === unit.chargobWanted) return false;
    unit.chargobWanted = next;
    return true;
  },

  // Per tick, after ChargobHandlers.begin. `line` = the beasts in line.
  update(unit, line, byId, combat) {
    let jobs = unit._pokeJobs;
    if (!jobs) jobs = unit._pokeJobs = [];

    if (unit.chargobAbandoned) {
      jobs.length = 0;
      unit.chargobWanted = 0;
      return;
    }

    if (unit.chargobWanted > line.length) unit.chargobWanted = line.length;

    for (let i = jobs.length - 1; i >= 0; i--) {
      const b = byId.get(jobs[i].beastId);
      if (!b || line.indexOf(b) < 0) jobs.splice(i, 1);
    }
    while (jobs.length > unit.chargobWanted) jobs.pop();
    while (jobs.length < unit.chargobWanted) {
      const b = pickBeast(unit, line, jobs);
      if (!b) break;
      jobs.push({ beastId: b.id, pokerIds: [], ticks: 0 });
    }
    if (jobs.length === 0) return;

    // Walking handlers must not stop short of their poke position.
    unit._settleToleranceBonus = 0;
    unit._settled = false;

    const c = CombatConfig.chargob;
    const need = c.pokersPerBeast;
    const needTicks = Math.max(1, Math.round(c.pokeSeconds * CombatConfig.tickRateHz));
    const reachSq = c.pokeReach * c.pokeReach;
    const busy = unit._busyHandlers;

    for (let j = 0; j < jobs.length; j++) {
      const job = jobs[j];
      const kept = [];
      for (let k = 0; k < job.pokerIds.length; k++) {
        const id = job.pokerIds[k];
        if (ChargobHandlers.usable(byId.get(id)) && !busy.has(id)) {
          kept.push(id);
          busy.add(id);
        }
      }
      job.pokerIds = kept;
    }

    ChargobHandlers.obstacles(unit, _obst);

    for (let j = jobs.length - 1; j >= 0; j--) {
      const job = jobs[j];
      const beast = byId.get(job.beastId);
      const sf = Math.sin(beast.facing);
      const cf = Math.cos(beast.facing);
      const rearX = beast.pos.x - sf * c.pokeDistance;
      const rearZ = beast.pos.z - cf * c.pokeDistance;

      fillPokers(unit, job, rearX, rearZ, need);

      let ready = job.pokerIds.length === need;
      for (let k = 0; k < job.pokerIds.length; k++) {
        const p = byId.get(job.pokerIds[k]);
        p.herdAnchorId = null;
        ChargobHandlers.run(p);
        const lat = (k - (job.pokerIds.length - 1) / 2) * c.pokeSpacing;
        const tx = rearX + cf * lat;
        const tz = rearZ - sf * lat;
        ChargobHandlers.steer(p.pos.x, p.pos.z, tx, tz, _obst, _wp);
        p.formationSlot.x = _wp.x;
        p.formationSlot.z = _wp.z;

        const rx = p.pos.x - beast.pos.x;
        const rz = p.pos.z - beast.pos.z;
        if (rx * rx + rz * rz > reachSq) ready = false;
        else if (rx * sf + rz * cf > 0.3) ready = false;
      }

      job.ticks = ready ? job.ticks + 1 : 0;

      // Show: the handlers hit the beast while they hold it.
      if (ready && combat && job.pokerIds.length > 0 && (job.ticks % 8) === 1) {
        const pid = job.pokerIds[(((job.ticks - 1) / 8) | 0) % job.pokerIds.length];
        combat.events.push({ type: 'attack', attackerId: pid, defenderId: beast.id });
      }

      if (job.ticks >= needTicks) {
        beast.chargePending = 'poke';
        unit.chargobWanted = Math.max(0, unit.chargobWanted - 1);
        jobs.splice(j, 1);
      }
    }
  }
};
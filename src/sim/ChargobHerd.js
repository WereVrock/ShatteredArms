import { CombatConfig } from '../config/CombatConfig.js';
import { ChargobPack } from './ChargobPack.js';
import { ChargobPanic } from './ChargobPanic.js';
import { ChargobTurn } from './ChargobTurn.js';

// The herd of beasts (see ChargobPack) while it is in line. The beasts are
// wild and obey nobody; this module only works out WHERE each beast should be
// and whether it needs help getting there. The movement itself is done by
// handlers pushing / pulling (ChargobHandlerAI, ChargobForces).
//
//   place()        per tick: herd facing, the place of every beast, whether it
//                  has to go there (herdNeed, with hysteresis) and whether it
//                  strayed (beastStray); every beast's formation slot is its
//                  own position so the normal movement leaves it alone
//   afterFacing()  per tick, AFTER FacingSystem: a standing beast keeps the
//                  facing it had (FacingSystem must not turn it towards the
//                  unit's orders), a scuffling beast turns to its victim and
//                  a charging beast turns to its course, all rate-limited
//   scuffle()      cosmetic: now and then a beast snaps at the rear beasts
//
// herdNeed: the beast is farther than looseRadius from its place (settleRadius
// once it panics, panic above panicFleeStart) and stays needy until it is
// within settleRadius. beastStray: farther than strayDistance; ends within
// strayReturn.
//
// The herd PLACES face unit._beastFacing, which follows the unit's facing at
// no more than herdTurnRate rad/s, so the places sweep round instead of
// jumping. The beasts' own facing is separate and never follows the unit.

function normAngle(a) {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function hold(b) {
  ChargobPack.holdPosition(b);
  b.beastWalking = false;
  b.gaitRunning = false;
}

const _slot = { x: 0, z: 0 };

export const ChargobHerd = {
  place(unit, line) {
    const cfg = CombatConfig.chargob;
    ChargobHerd._turnHerd(unit);

    const n = line.length;
    if (n === 0) return;

    const lay = ChargobPack.layout(unit, unit._beastFacing);
    if (!lay.ok) {
      for (let i = 0; i < n; i++) {
        const b = line[i];
        b.herdNeed = false;
        b.beastStray = false;
        hold(b);
      }
      return;
    }

    for (let i = 0; i < n; i++) {
      const b = line[i];
      ChargobPack.slotOf(lay, b, _slot);
      b.herdTx = _slot.x;
      b.herdTz = _slot.z;

      const dx = b.herdTx - b.pos.x;
      const dz = b.herdTz - b.pos.z;
      const d = Math.sqrt(dx * dx + dz * dz);

      if (b.beastStray) {
        if (d < cfg.strayReturn) b.beastStray = false;
      } else if (d > cfg.strayDistance) {
        b.beastStray = true;
      }

      const trigger = ChargobPanic.effective(b) > cfg.panicFleeStart ? cfg.settleRadius : cfg.looseRadius;
      b.herdNeed = b.herdNeed ? d > cfg.settleRadius : d > trigger;

      hold(b);
    }
  },

  // Turns the herd's places towards the unit's facing, at most herdTurnRate rad/s.
  _turnHerd(unit) {
    if (typeof unit._beastFacing !== 'number') {
      unit._beastFacing = unit.formationFacing;
      return;
    }
    const diff = normAngle(unit.formationFacing - unit._beastFacing);
    const maxStep = CombatConfig.chargob.herdTurnRate / CombatConfig.tickRateHz;
    unit._beastFacing += Math.max(-maxStep, Math.min(maxStep, diff));
  },

  // After FacingSystem.
  afterFacing(unit) {
    if (unit.companionKind !== 'chargob') return;
    const c = CombatConfig.chargob;
    const companions = unit.companions;

    for (let i = 0; i < companions.length; i++) {
      const b = companions[i];
      if (!b.isAlive()) continue;

      if (b.chargeActive) {
        ChargobTurn.turn(b, Math.atan2(b.chargeDirX, b.chargeDirZ), c.chargeTurnRate);
        continue;
      }

      if (!ChargobPack.isInLine(b)) continue;

      const v = b.scuffleTicks > 0 ? b.scuffleTarget : null;
      if (v && v.isAlive()) {
        ChargobTurn.turn(b, Math.atan2(v.pos.x - b.pos.x, v.pos.z - b.pos.z), c.beastTurnRate);
        b.beastKeepFacing = b.facing;
        continue;
      }

      const st = b.state;
      if (b.movedThisTick || b.targetId !== null
          || st === 'engaged' || st === 'staggered' || st === 'knockedDown') {
        b.beastKeepFacing = b.facing;
        continue;
      }

      // Standing: undo whatever FacingSystem did, the beast keeps its facing.
      b.facing = b.beastKeepFacing;
      b.desiredFacing = b.beastKeepFacing;
      b.moveFacing = b.beastKeepFacing;
    }
  },

  // Cosmetic scuffles: a beast near the rearmost beasts snaps at one of them.
  // Only 'attack' events are emitted (the swing animation), nobody is hurt.
  scuffle(unit, line, combat) {
    if (!combat) return;
    const cfg = CombatConfig.chargob;
    const half = Math.floor(cfg.scuffleSwingTicks / 2);

    for (let i = 0; i < line.length; i++) {
      const b = line[i];
      if (b.scuffleTicks <= 0) continue;
      b.scuffleTicks--;
      const v = b.scuffleTarget;
      if (!v || !v.isAlive()) {
        b.scuffleTicks = 0;
        b.scuffleTarget = null;
        continue;
      }
      if (b.scuffleTicks === cfg.scuffleSwingTicks - 1 || b.scuffleTicks === half) {
        combat.events.push({ type: 'attack', attackerId: b.id, defenderId: v.id });
      }
      if (b.scuffleTicks === 0) b.scuffleTarget = null;
    }

    unit._scuffleCd = (unit._scuffleCd | 0) - 1;
    if (unit._scuffleCd > 0 || line.length < 2) return;
    unit._scuffleCd = cfg.scuffleMinTicks
      + Math.floor(Math.random() * (cfg.scuffleMaxTicks - cfg.scuffleMinTicks));

    const f = typeof unit._beastFacing === 'number' ? unit._beastFacing : unit.formationFacing;
    const fx = Math.sin(f);
    const fz = Math.cos(f);
    let minF = Infinity;
    for (let i = 0; i < line.length; i++) {
      const fw = line[i].pos.x * fx + line[i].pos.z * fz;
      if (fw < minF) minF = fw;
    }
    const rear = [];
    for (let i = 0; i < line.length; i++) {
      const fw = line[i].pos.x * fx + line[i].pos.z * fz;
      if (fw <= minF + cfg.rowPitch * 0.6) rear.push(line[i]);
    }

    const swings = Math.random() < 0.5 ? 2 : 1;
    const reachSq = cfg.scuffleReach * cfg.scuffleReach;
    for (let s = 0; s < swings; s++) {
      const victim = rear[Math.floor(Math.random() * rear.length)];
      let attacker = null;
      let bestD = reachSq;
      for (let i = 0; i < line.length; i++) {
        const o = line[i];
        if (o === victim || o.scuffleTicks > 0 || o.targetId !== null) continue;
        if (o.state === 'engaged' || o.state === 'staggered' || o.state === 'knockedDown') continue;
        const dx = o.pos.x - victim.pos.x;
        const dz = o.pos.z - victim.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; attacker = o; }
      }
      if (!attacker) continue;
      attacker.scuffleTicks = cfg.scuffleSwingTicks;
      attacker.scuffleTarget = victim;
    }
  }
};
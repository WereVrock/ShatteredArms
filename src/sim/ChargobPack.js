import { Soldier, hash32 } from './Soldier.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { CombatConfig } from '../config/CombatConfig.js';

// Chargob units. A handler unit (type declares
// `chargob: { beastTypeId, handlersPerBeast }`) owns a herd of beasts in
// unit.companions (unit.companionKind === 'chargob'). Beasts are NOT in
// unit.soldiers: the roster counts handlers only and the beasts are rebuilt
// from the handler count every battle, so they are "replenished fully".
//
// A beast is in one of four situations:
//   in line  - alive, stands loosely in front of the handler block
//   charging - chargeActive, runs a fixed course (see ChargobCharge)
//   spent    - chargeSpent, a charge that stalled for good; fights where it stands
//   leaving  - routing/shattered, withdrawing with the unit
//
// Every beast has a fixed herdIndex. Its slot is the herdIndex-th place of
// a loose grid in front of the handlers, with a fixed random offset. Slots
// of dead or charging beasts stay empty: the herd does not close up.
//
// This module owns creation and the herd geometry only. The herd frame is
// measured on the handlers' formation SLOTS (not their positions), in the
// facing the herd currently has (unit._beastFacing, see ChargobHerd).

const MAX_U32 = 4294967295;
const _lay = {
  ok: false, cols: 1, rows: 1, total: 0, latCenter: 0,
  cx: 0, cz: 0, fx: 0, fz: 0, rx: 0, rz: 0, maxF: 0
};

function noise(b, salt) {
  return (hash32((b.id ^ salt) >>> 0) / MAX_U32) * 2 - 1;
}

export const ChargobPack = {
  // Beasts a unit of `handlers` handlers fields.
  beastCount(typeDef, handlers) {
    const cfg = typeDef && typeDef.chargob;
    if (!cfg || handlers <= 0) return 0;
    return Math.ceil(handlers / cfg.handlersPerBeast);
  },

  // True for a beast that stands in the herd (not charging, not spent, not leaving).
  isInLine(b) {
    return b.isAlive()
      && !b.chargeActive
      && !b.chargeSpent
      && !b.beastDetached
      && !b.chargePending
      && b.state !== 'routing'
      && b.state !== 'shattered';
  },

  // Creates the beasts of a freshly built handler unit. No-op for other units.
  attach(unit) {
    const lead = unit.soldiers[0];
    const cfg = lead && lead.unitTypeDef.chargob;
    if (!cfg) return;
    const beastDef = UnitTypes[cfg.beastTypeId];
    if (!beastDef) return;

    unit.companionKind = 'chargob';
    unit.companions.length = 0;
    const n = ChargobPack.beastCount(lead.unitTypeDef, unit.soldiers.length);
    unit._beastTotal = n;
    // The direction panicked beasts want to walk home to, fixed for the battle.
    unit._beastHomeAngle = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const b = new Soldier({
        unitId: unit.id,
        teamId: unit.teamId,
        unitTypeDef: beastDef,
        x: lead.pos.x,
        z: lead.pos.z,
        facing: unit.formationFacing,
        isUndead: false
      });
      b.herdIndex = i;
      b.panicBias = (Math.random() * 2 - 1) * CombatConfig.chargob.panicBiasRange;
      b.wanderTicks = Math.floor(Math.random() * CombatConfig.chargob.wanderIntervalTicks);
      unit.companions.push(b);
    }
    ChargobPack.snap(unit);
  },

  // Frame of the herd at `facing`. Returns a shared scratch object: read it
  // right away, do not keep it. lay.ok is false when no handler lives.
  layout(unit, facing) {
    const lay = _lay;
    lay.ok = false;

    const soldiers = unit.soldiers;
    let n = 0;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s.isAlive()) continue;
      cx += s.formationSlot.x;
      cz += s.formationSlot.z;
      n++;
    }
    if (n === 0) return lay;
    cx /= n;
    cz /= n;

    const fx = Math.sin(facing);
    const fz = Math.cos(facing);
    const rx = Math.cos(facing);
    const rz = -Math.sin(facing);

    let maxF = -Infinity;
    let minL = Infinity;
    let maxL = -Infinity;
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s.isAlive()) continue;
      const dx = s.formationSlot.x - cx;
      const dz = s.formationSlot.z - cz;
      const fw = dx * fx + dz * fz;
      const la = dx * rx + dz * rz;
      if (fw > maxF) maxF = fw;
      if (la < minL) minL = la;
      if (la > maxL) maxL = la;
    }

    const cfg = CombatConfig.chargob;
    const total = Math.max(1, (unit._beastTotal | 0) || unit.companions.length);
    const width = maxL - minL;
    const cols = Math.max(1, Math.min(total, Math.ceil((width + cfg.beastSpacing) / cfg.beastSpacing)));

    lay.cx = cx; lay.cz = cz;
    lay.fx = fx; lay.fz = fz;
    lay.rx = rx; lay.rz = rz;
    lay.maxF = maxF;
    lay.cols = cols;
    lay.rows = Math.ceil(total / cols);
    lay.total = total;
    lay.latCenter = (minL + maxL) / 2;
    lay.ok = true;
    return lay;
  },

  // Lateral position (along the herd's right axis) of column `col` in `row`.
  colLateral(lay, row, col) {
    const inRow = Math.min(lay.cols, lay.total - row * lay.cols);
    return lay.latCenter + (col - (inRow - 1) / 2) * CombatConfig.chargob.beastSpacing;
  },

  // Forward position of `row` (row 0 is the front row).
  rowForward(lay, row) {
    const cfg = CombatConfig.chargob;
    return lay.maxF + cfg.frontGap + (lay.rows - 1 - row) * cfg.rowPitch;
  },

  toWorld(lay, lat, fwd, out) {
    out.x = lay.cx + lay.rx * lat + lay.fx * fwd;
    out.z = lay.cz + lay.rz * lat + lay.fz * fwd;
    return out;
  },

  // Slot of beast `b`: its grid place plus its own fixed random offset.
  slotOf(lay, b, out) {
    const cfg = CombatConfig.chargob;
    const j = b.herdIndex | 0;
    const row = Math.floor(j / lay.cols);
    const col = j % lay.cols;
    const lat = ChargobPack.colLateral(lay, row, col) + noise(b, 0x51ed27) * cfg.looseJitter;
    const fwd = ChargobPack.rowForward(lay, row) + noise(b, 0x2c1b3c) * cfg.looseJitter;
    return ChargobPack.toWorld(lay, lat, fwd, out);
  },

  // Slot = where it stands: the beast does not walk anywhere.
  holdPosition(b) {
    b.formationSlot.x = b.pos.x;
    b.formationSlot.z = b.pos.z;
  },

  // Teleports every beast of the herd to its slot and gives the herd the
  // unit's current facing. Used at build time and by deployment moves.
  snap(unit) {
    if (unit.companionKind !== 'chargob') return;
    unit._beastFacing = unit.formationFacing;
    unit._beastTurn = null;

    const lay = ChargobPack.layout(unit, unit._beastFacing);
    if (!lay.ok) return;

    const slot = { x: 0, z: 0 };
    for (const b of unit.companions) {
      if (!b.isAlive() || b.chargeActive || b.chargeSpent) continue;
      ChargobPack.slotOf(lay, b, slot);
      b.pos.x = slot.x;
      b.pos.z = slot.z;
      b.terrainSafeX = slot.x;
      b.terrainSafeZ = slot.z;
      b.formationSlot = { x: slot.x, z: slot.z };
      b.beastWalking = false;
      b.facing = unit._beastFacing;
      b.desiredFacing = unit._beastFacing;
      b.moveFacing = unit._beastFacing;
      b.currentSpeed = 0;
      b.movedThisTick = false;
    }
  }
};
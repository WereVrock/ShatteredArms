import { Soldier } from './Soldier.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { CombatConfig } from '../config/CombatConfig.js';

// Goblin hounds. A handler unit (type declares `hounds: { typeId, perHandler }`)
// owns a list of COMPANION soldiers (unit.companions). Companions are NOT in
// unit.soldiers: formation, morale, casualty counts, AI and the campaign
// roster never see them. BattleSimulation.getAllSoldiers() includes them, so
// movement, collision, targeting by enemies, combat, projectiles and
// rendering all treat them as ordinary soldiers. HoundSystem drives them.
//
// A leashed hound stays beside its OWNER (one on each side, slightly ahead).
// When the owner is dead it stays behind another hound whose owner lives, and
// when no such hound exists, behind the nearest living handler.
//
// This module owns creation and the leash geometry only.

const _owners = new Map();

function hasLiveOwner(h, byId) {
  const o = byId.get(h.houndOwnerId);
  return !!(o && o.isAlive());
}

export const HoundPack = {
  // Creates the hounds of a freshly built handler unit and places them next
  // to their owners. No-op for units whose type declares no hounds.
  attach(unit) {
    const lead = unit.soldiers[0];
    const cfg = lead && lead.unitTypeDef.hounds;
    if (!cfg) return;
    const houndDef = UnitTypes[cfg.typeId];
    if (!houndDef) return;

    unit.companions.length = 0;
    for (const handler of unit.soldiers) {
      for (let k = 0; k < cfg.perHandler; k++) {
        const hound = new Soldier({
          unitId: unit.id,
          teamId: unit.teamId,
          unitTypeDef: houndDef,
          x: handler.pos.x,
          z: handler.pos.z,
          facing: unit.formationFacing,
          isUndead: false
        });
        hound.houndOwnerId = handler.id;
        hound.houndIndex = k;
        hound.houndMode = 'leashed';
        unit.companions.push(hound);
      }
    }
    HoundPack.snap(unit);
  },

  // Writes into `out` the position `hound` holds around `anchor`: beside its
  // owner, or behind the soldier it follows.
  slotAround(anchor, hound, perHandler, facing, out) {
    const cfg = CombatConfig.hound;
    const isOwner = anchor.id === hound.houndOwnerId;
    const k = hound.houndIndex - (perHandler - 1) / 2;
    const lat = k * (isOwner ? cfg.ownerSide : cfg.buddySide);
    const fwd = isOwner ? cfg.ownerForward : -cfg.buddyBehind;
    const fx = Math.sin(facing);
    const fz = Math.cos(facing);
    const rx = Math.cos(facing);
    const rz = -Math.sin(facing);
    out.x = anchor.pos.x + rx * lat + fx * fwd;
    out.z = anchor.pos.z + rz * lat + fz * fwd;
    return out;
  },

  // The soldier `hound` stays with, or null when nothing of the unit lives.
  anchorFor(hound, unit, byId) {
    const owner = byId.get(hound.houndOwnerId);
    if (owner && owner.isAlive()) return owner;

    const cached = hound.houndBuddyId != null ? byId.get(hound.houndBuddyId) : null;
    if (cached && cached.isAlive() && hasLiveOwner(cached, byId)) return cached;

    let best = null;
    let bestD = Infinity;
    const companions = unit.companions;
    for (let i = 0; i < companions.length; i++) {
      const c = companions[i];
      if (c === hound || !c.isAlive() || !hasLiveOwner(c, byId)) continue;
      const dx = c.pos.x - hound.pos.x;
      const dz = c.pos.z - hound.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best === null) {
      const soldiers = unit.soldiers;
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (!s.isAlive()) continue;
        const dx = s.pos.x - hound.pos.x;
        const dz = s.pos.z - hound.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    hound.houndBuddyId = best ? best.id : null;
    return best;
  },

  // Trims a freshly built unit's pack: handler i (position in unit.soldiers)
  // keeps counts[i] hounds.
  applyCounts(unit, counts) {
    const cfg = unit.soldiers[0]?.unitTypeDef.hounds;
    if (!cfg || !counts) return;
    const keep = new Map();
    for (let i = 0; i < unit.soldiers.length; i++) {
      keep.set(unit.soldiers[i].id, Math.max(0, Math.min(cfg.perHandler, counts[i] ?? cfg.perHandler)));
    }
    unit.companions = unit.companions.filter(
      h => h.houndIndex < (keep.get(h.houndOwnerId) ?? cfg.perHandler)
    );
  },

  // Hounds one handler ends up with after the post-battle regeneration roll.
  regenerate(current, perHandler) {
    const c = CombatConfig.hound;
    const frac = perHandler > 0 ? current / perHandler : 1;
    let p;
    if (frac <= c.regenLowFrac) p = c.regenMaxRate;
    else if (frac >= c.regenHighFrac) p = c.regenMinRate;
    else {
      const t = (frac - c.regenLowFrac) / (c.regenHighFrac - c.regenLowFrac);
      p = c.regenMaxRate + (c.regenMinRate - c.regenMaxRate) * t;
    }
    let n = current;
    for (let i = current; i < perHandler; i++) if (Math.random() < p) n++;
    return n;
  },

  // After a battle: one count per surviving handler (alive or escaped), in
  // unit order, with the regeneration roll applied. A dead handler's hounds
  // are lost. Null for units without hounds.
  survivorCounts(unit) {
    const cfg = unit.soldiers[0]?.unitTypeDef.hounds;
    if (!cfg) return null;
    const perOwner = new Map();
    for (const h of unit.companions) {
      if (h.state === 'dead') continue;
      perOwner.set(h.houndOwnerId, (perOwner.get(h.houndOwnerId) || 0) + 1);
    }
    const out = [];
    for (const handler of unit.soldiers) {
      if (handler.state === 'dead') continue;
      out.push(HoundPack.regenerate(
        Math.min(cfg.perHandler, perOwner.get(handler.id) || 0), cfg.perHandler));
    }
    return out;
  },

  // Teleports every living hound next to its owner. Used at build time and
  // by deployment moves.
  snap(unit) {
    const lead = unit.soldiers[0];
    const cfg = lead && lead.unitTypeDef.hounds;
    if (!cfg || unit.companions.length === 0) return;

    _owners.clear();
    for (const s of unit.soldiers) _owners.set(s.id, s);

    const slot = { x: 0, z: 0 };
    for (const hound of unit.companions) {
      if (!hound.isAlive()) continue;
      const owner = _owners.get(hound.houndOwnerId);
      if (!owner || !owner.isAlive()) continue;
      HoundPack.slotAround(owner, hound, cfg.perHandler, unit.formationFacing, slot);
      hound.pos.x = slot.x;
      hound.pos.z = slot.z;
      hound.formationSlot = { x: slot.x, z: slot.z };
      hound.facing = unit.formationFacing;
      hound.desiredFacing = unit.formationFacing;
      hound.moveFacing = unit.formationFacing;
      hound.currentSpeed = 0;
      hound.movedThisTick = false;
    }
  }
};
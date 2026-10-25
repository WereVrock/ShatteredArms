// Serialise / apply a compact JSON snapshot of mutable unit + soldier
// state. The entire network contract between host and guest.
//
// Not sent (both sides derive it deterministically from the shared
// scenario): maxHp, maxMorale, unitTypeDef, formationOffset, formationRank,
// teamId, isUndead, config values.
//
// Sent: everything mutable that the renderer, the input layer, the HUD,
// or BattleFlowController read.
//
// `attackCooldownTicks` is included because SoldierView drives both the
// melee swing pose and the bow-draw animation off it — without it, guest
// soldiers stand frozen in neutral.

const SOLDIER_STATE_CODES = {
  idle: 0, marching: 1, engaged: 2, ranged: 3, staggered: 4,
  knockedDown: 5, impetuous: 6, routing: 7, shattered: 8,
  dead: 9, extracted: 10
};
const SOLDIER_STATE_NAMES = (() => {
  const out = {};
  for (const [name, code] of Object.entries(SOLDIER_STATE_CODES)) out[code] = name;
  return out;
})();

function r3(v) {
  if (!isFinite(v)) return 0;
  return Math.round(v * 1000) / 1000;
}

export class SnapshotCodec {
  static encode(units, tick) {
    return JSON.stringify({
      t: tick,
      u: units.map(u => ({
        i: u.id,
        f: r3(u.formationFacing),
        mx: r3(u.formationMarchOrigin.x),
        mz: r3(u.formationMarchOrigin.z),
        ox: r3(u.formationOrigin.x),
        oz: r3(u.formationOrigin.z),
        w: r3(u.currentWidthUnits),
        c: u.formationCols,
        h: u.hasActiveOrder ? 1 : 0,
        otx: u.orderTarget ? r3(u.orderTarget.x) : null,
        otz: u.orderTarget ? r3(u.orderTarget.z) : null,
        ft: u.focusTargetUnitId || null,
        ai: u.aiFocusTargetUnitId || null,
        s: u.soldiers.map(s => ({
          i: s.id,
          x: r3(s.pos.x),
          z: r3(s.pos.z),
          f: r3(s.facing),
          hp: r3(s.hp),
          st: SOLDIER_STATE_CODES[s.state] ?? 0,
          sh: r3(s.shieldHp),
          mo: r3(s.morale),
          fa: r3(s.fatigue),
          sr: r3(s.spearRaiseAmount),
          ab: s.airborneTicksLeft,
          ac: s.attackCooldownTicks
        }))
      }))
    });
  }

  static decode(json, unitsById) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || !Array.isArray(data.u)) return 0;

    const soldierById = new Map();
    for (const unit of unitsById.values()) {
      for (const s of unit.soldiers) soldierById.set(s.id, s);
    }

    for (const ud of data.u) {
      const unit = unitsById.get(ud.i);
      if (!unit) continue;

      unit.formationFacing = ud.f;
      unit.formationMarchOrigin.x = ud.mx;
      unit.formationMarchOrigin.z = ud.mz;
      unit.formationOrigin.x = ud.ox;
      unit.formationOrigin.z = ud.oz;
      unit.currentWidthUnits = ud.w;
      unit.formationCols = ud.c;
      unit.hasActiveOrder = !!ud.h;
      unit.orderTarget = ud.otx !== null ? { x: ud.otx, z: ud.otz } : null;
      unit.focusTargetUnitId = ud.ft;
      unit.aiFocusTargetUnitId = ud.ai;
      // unit.selected is deliberately NOT applied here — it is the local
      // peer's own input state, owned by SelectionController, and the
      // remote peer has no authority over it. Transmitting it caused the
      // guest's selection ring to disappear on the next snapshot.

      for (const sd of ud.s) {
        const soldier = soldierById.get(sd.i);
        if (!soldier) continue;
        soldier.pos.x = sd.x;
        soldier.pos.z = sd.z;
        soldier.facing = sd.f;
        soldier.desiredFacing = sd.f;
        soldier.hp = sd.hp;
        soldier.state = SOLDIER_STATE_NAMES[sd.st] ?? 'idle';
        soldier.shieldHp = sd.sh;
        soldier.hasShield = sd.sh > 0;
        soldier.morale = sd.mo;
        soldier.fatigue = sd.fa;
        soldier.spearRaiseAmount = sd.sr;
        soldier.airborneTicksLeft = sd.ab;
        soldier.attackCooldownTicks = sd.ac;
      }
    }

    return data.t || 0;
  }
}
import { CombatConfig } from '../config/CombatConfig.js';
import { Property } from '../config/Properties.js';

// Charge mechanics of one chargob beast (see ChargobPack for the pack).
//
// A beast starts charging for one of four reasons, recorded in
// beast.chargePending until ChargobSystem calls start():
//   'through' - it rolled a charge-through while fighting (afterAttack)
//   'poke'    - three handlers goaded it (ChargobPoke)
//   'wild'    - too few handlers are left to hold the beasts (ChargobSystem)
//   'panic'   - its panic reached the charge threshold (ChargobSystem); it
//               runs in the direction it is looking
//
// The moment a beast starts charging it LEAVES its unit for good
// (beast.beastDetached): nobody controls it, it is no longer selected, drawn
// as part of the unit or counted by the herd. It runs a fixed course at its
// full run speed, bites and throws whatever it passes (ContactAttackSystem +
// the charge bonus of CombatResolutionSystem, ChargobTrample), and the charge
// never ends: the beast ends dead or off the map edge. A beast that is killed
// keeps charging deathChargeSeconds first (deathThroes). A beast that cannot
// move for deflectStallTicks (blocked by terrain) turns by 60-120 degrees and
// carries on.
//
// While charging, Soldier.effectiveMass / effectiveMoveSpeed are multiplied
// by chargeMassMult / chargeSpeedMult.
//
// Properties of a released beast (per-soldier, see RaceConfig.soldierHasProperty):
// EXPENDABLE once charging, WORTHLESS after it hit at least one enemy.

const DEG = Math.PI / 180;
const _buf = [];

// Direction to the nearest enemy inside the cone ahead of the beast, or null.
function steerDirection(beast, grid) {
  const cfg = CombatConfig.chargob;
  const radius = cfg.chargeSearchRadius;
  const cells = Math.ceil(radius / grid.cellSize) + 1;
  const near = grid.queryNearbyIntoExcludingTeam(_buf, beast.pos.x, beast.pos.z, cells, beast.teamId);

  const fx = Math.sin(beast.facing);
  const fz = Math.cos(beast.facing);
  const minCos = Math.cos(cfg.chargeConeHalfDeg * DEG);

  let bestD = radius * radius;
  let bx = 0;
  let bz = 0;
  let found = false;
  for (let i = 0; i < near.length; i++) {
    const o = near[i];
    if (!o.isAlive()) continue;
    const ex = o.pos.x - beast.pos.x;
    const ez = o.pos.z - beast.pos.z;
    const d2 = ex * ex + ez * ez;
    if (d2 < 1e-6 || d2 >= bestD) continue;
    const cos = (ex * fx + ez * fz) / Math.sqrt(d2);
    if (cos < minCos) continue;
    bestD = d2;
    bx = ex;
    bz = ez;
    found = true;
  }
  if (!found) return null;
  const d = Math.sqrt(bestD);
  return { x: bx / d, z: bz / d };
}

export const ChargobCharge = {
  // Charge-through chance of one attack: throughMinChance at full HP, rising
  // to throughMaxChance as the beast loses HP.
  throughChance(beast) {
    const c = CombatConfig.chargob;
    const lost = beast.maxHp > 0 ? 1 - Math.max(0, beast.hp) / beast.maxHp : 0;
    return c.throughMinChance + (c.throughMaxChance - c.throughMinChance) * Math.min(1, lost);
  },

  // Called by CombatResolutionSystem right after a beast resolved an attack.
  // `events` is the system's event list, `fromIndex` where this attack's
  // events start.
  afterAttack(attacker, events, fromIndex) {
    if (!attacker.isAlive()) return;

    if (attacker.chargeActive) {
      if (attacker.chargeHasHit) return;
      for (let i = fromIndex; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'hit' && e.attackerId === attacker.id) {
          ChargobCharge.markHit(attacker);
          return;
        }
      }
      return;
    }

    if (attacker.chargeSpent || attacker.chargePending) return;
    if (Math.random() < ChargobCharge.throughChance(attacker)) {
      attacker.chargePending = 'through';
    }
  },

  markHit(beast) {
    beast.chargeHasHit = true;
    beast.extraProperties = [Property.WORTHLESS];
  },

  // Called by CombatResolutionSystem when a charging beast takes a lethal
  // blow. Returns true while the beast must survive it: the first lethal blow
  // starts deathChargeSeconds of charging with 1 HP, the beast then dies in
  // ChargobCharge.tick.
  deathThroes(beast) {
    if (!beast.chargeDying) {
      beast.chargeDying = true;
      beast.chargeDyingTicks = Math.max(1,
        Math.round(CombatConfig.chargob.deathChargeSeconds * CombatConfig.tickRateHz));
    } else if (beast.chargeDyingTicks <= 0) {
      return false;
    }
    beast.hp = 1;
    return true;
  },

  // Starts the charge and detaches the beast from its unit. mode 'wild' =
  // random direction, 'panic' = straight ahead (the way it looks), otherwise
  // the course locks on the nearest enemy inside the cone ahead (or runs
  // straight ahead). The course only changes when the beast gets stuck.
  start(beast, mode, grid) {
    let dx = Math.sin(beast.facing);
    let dz = Math.cos(beast.facing);
    if (mode === 'wild') {
      const a = Math.random() * Math.PI * 2;
      dx = Math.sin(a);
      dz = Math.cos(a);
    } else if (mode !== 'panic') {
      const t = steerDirection(beast, grid);
      if (t) { dx = t.x; dz = t.z; }
    }

    beast.chargeActive = true;
    beast.beastDetached = true;
    beast.beastStray = false;
    beast.herdNeed = false;
    beast.herdPullWanted = false;
    beast.herdAnchorId = null;
    beast.herdVx = 0;
    beast.herdVz = 0;
    beast.wanderLeft = 0;
    beast.chargeDirX = dx;
    beast.chargeDirZ = dz;
    beast.chargeHasHit = false;
    beast.chargeAimDone = false;
    beast.chargeAimTicks = 0;
    beast.chargePending = null;
    beast.chargeStallTicks = 0;
    beast.chargeLastX = beast.pos.x;
    beast.chargeLastZ = beast.pos.z;
    beast.chargeDying = false;
    beast.chargeDyingTicks = 0;
    beast.beastWalking = false;
    beast.scuffleTicks = 0;
    beast.scuffleTarget = null;
    beast.fleeDirection = { x: dx, z: dz };
    beast.extraProperties = [Property.EXPENDABLE];

    beast.state = 'marching';
    beast.targetId = null;
    beast.isImpetuous = false;
    beast.disengageGraceTicksLeft = 0;
    beast.gaitRunning = true;
    beast.desiredFacing = Math.atan2(dx, dz);
  },

  // A blocked beast turns 60-120 degrees (random side) and runs on.
  deflect(beast) {
    const c = CombatConfig.chargob;
    const a = Math.atan2(beast.chargeDirX, beast.chargeDirZ);
    const turn = (c.deflectMinDeg + Math.random() * (c.deflectMaxDeg - c.deflectMinDeg))
      * DEG * (Math.random() < 0.5 ? -1 : 1);
    const na = a + turn;
    beast.chargeDirX = Math.sin(na);
    beast.chargeDirZ = Math.cos(na);
    beast.fleeDirection = { x: beast.chargeDirX, z: beast.chargeDirZ };
    beast.desiredFacing = na;
    beast.chargeStallTicks = 0;
  },

  // Per-tick upkeep of a charging beast. Returns false when it is gone.
  tick(beast) {
    const cfg = CombatConfig.chargob;
    const b = CombatConfig.mapBounds;
    const m = cfg.edgeMargin;
    if (beast.pos.x <= b.minX + m || beast.pos.x >= b.maxX - m ||
        beast.pos.z <= b.minZ + m || beast.pos.z >= b.maxZ - m) {
      ChargobCharge._die(beast);
      return false;
    }

    if (beast.chargeDying) {
      beast.chargeDyingTicks--;
      if (beast.chargeDyingTicks <= 0) {
        ChargobCharge._die(beast);
        return false;
      }
    }

    const st = beast.state;
    if (st !== 'staggered' && st !== 'knockedDown') {
      beast.state = 'marching';
      beast.targetId = null;
    }
    beast.gaitRunning = true;

    // A beast that cannot move at all (rock, cliff) turns away and runs on.
    // Slow ground (mud) never counts: the limit is tiny.
    if (!beast.chargeDying && beast.state === 'marching' && beast.airborneTicksLeft <= 0) {
      const dx = beast.pos.x - beast.chargeLastX;
      const dz = beast.pos.z - beast.chargeLastZ;
      if (dx * dx + dz * dz < cfg.stallMoveEps * cfg.stallMoveEps) beast.chargeStallTicks++;
      else beast.chargeStallTicks = 0;
      if (beast.chargeStallTicks >= cfg.deflectStallTicks) ChargobCharge.deflect(beast);
    }
    beast.chargeLastX = beast.pos.x;
    beast.chargeLastZ = beast.pos.z;
    return true;
  },

  _die(beast) {
    beast.hp = 0;
    beast.state = 'dead';
    beast.targetId = null;
    beast.chargeActive = false;
    beast.chargeDying = false;
  }
};
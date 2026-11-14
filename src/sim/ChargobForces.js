import { CombatConfig } from '../config/CombatConfig.js';
import { ChargobHandlers } from './ChargobHandlers.js';
import { ChargobPanic } from './ChargobPanic.js';
import { ChargobTurn } from './ChargobTurn.js';

// What moves a beast of the herd. A beast never walks on its own will; every
// tick its velocity is the sum of
//
//   handler push   assigned handlers (soldier.herdAnchorId set) within pushRange
//                  push every beast that has to go somewhere (herdNeed) and
//                  whose way they help: direction away from the handler.
//                  Strength pushForce * (2 - 2^(1-n)) for n handlers
//                  (1, 1.5, 1.75, ...). Panic does NOT weaken it.
//   handler pull   an assigned handler within pullRange of a beast marked
//                  herdPullWanted pulls it towards itself, pullForceMult times
//                  as strong as a push. While pulled, enemy push and the walk
//                  home are ignored: a pull always works.
//   enemy push     enemies within enemyPushRadius push away, scaled by the
//                  panic resistance (0 up to panic 20).
//   walk home      towards the unit's random home direction, scaled by the
//                  panic resistance. A beast the handlers have abandoned
//                  (beastOrphaned: no handler within abandonRange) walks home
//                  at full strength whatever its panic.
//   wander         nothing else moves it: every ~30 s a short 3-4 m walk.
//
// A calm beast that is fighting an enemy (fightsHere) is not moved at all: it
// stands and fights.
//
// The result is stored in beast.herdVx / herdVz (world units per second) and
// applied by apply() after FacingSystem (ChargobSystem.afterFacing). The beast
// turns towards its way at beastTurnRate (ChargobTurn), never instantly.
// herdResist (enemy push + walk home) is read by ChargobHandlerAI to decide
// how many handlers a beast needs.

const _buf = [];

function pushPower(n) {
  if (n <= 0) return 0;
  return CombatConfig.chargob.pushForce * (2 - Math.pow(2, 1 - n));
}

export const ChargobForces = {
  pushPower,

  pullPower(n) {
    return CombatConfig.chargob.pullForceMult * pushPower(n);
  },

  // A calm beast in melee stays where it is and fights. Panicked, strayed and
  // pulled beasts can still be moved out of the fight.
  fightsHere(b) {
    return b.state === 'engaged'
      && !b.beastStray
      && ChargobPanic.effective(b) <= CombatConfig.chargob.panicFleeStart;
  },

  // Per tick for every beast of `line`.
  update(unit, line, grid) {
    for (let i = 0; i < line.length; i++) ChargobForces._compute(unit, line[i], grid);
  },

  _compute(unit, b, grid) {
    const c = CombatConfig.chargob;
    const dt = 1 / CombatConfig.tickRateHz;

    if (ChargobForces.fightsHere(b)) {
      b.herdVx = 0;
      b.herdVz = 0;
      b.herdResist = 0;
      return;
    }

    const pe = ChargobPanic.effective(b);
    const s = ChargobPanic.resistance(pe);

    // --- enemy push ---
    let ex = 0;
    let ez = 0;
    let sumW = 0;
    if (s > 0) {
      const radius = c.enemyPushRadius;
      const cells = Math.ceil(radius / grid.cellSize) + 1;
      const near = grid.queryNearbyIntoExcludingTeam(_buf, b.pos.x, b.pos.z, cells, b.teamId);
      for (let i = 0; i < near.length; i++) {
        const o = near[i];
        if (!o.isAlive()) continue;
        const dx = b.pos.x - o.pos.x;
        const dz = b.pos.z - o.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= radius || d < 0.01) continue;
        const w = 1 - d / radius;
        ex += dx / d * w;
        ez += dz / d * w;
        sumW += w;
      }
    }
    let eMag = 0;
    const eLen = Math.sqrt(ex * ex + ez * ez);
    if (sumW > 0 && eLen > 1e-6) {
      eMag = c.enemyPushForce * s * Math.min(c.enemyPushCap, sumW);
      ex = ex / eLen * eMag;
      ez = ez / eLen * eMag;
    } else {
      ex = 0;
      ez = 0;
    }

    // --- walk home (full strength once the handlers abandoned the beast) ---
    const ha = typeof unit._beastHomeAngle === 'number' ? unit._beastHomeAngle : 0;
    const hMag = c.homeForce * (b.beastOrphaned ? 1 : s);
    const hx = Math.sin(ha) * hMag;
    const hz = Math.cos(ha) * hMag;
    b.herdResist = eMag + hMag;

    // --- handlers ---
    const pr2 = c.pushRange * c.pushRange;
    const pl2 = c.pullRange * c.pullRange;
    const gdx = b.herdTx - b.pos.x;
    const gdz = b.herdTz - b.pos.z;
    const gl = Math.sqrt(gdx * gdx + gdz * gdz);
    const gx = gl > 0.01 ? gdx / gl : 0;
    const gz = gl > 0.01 ? gdz / gl : 0;
    const wantsMove = b.herdNeed || b.beastStray;

    let pushN = 0;
    let pushX = 0;
    let pushZ = 0;
    let pullN = 0;
    let pullX = 0;
    let pullZ = 0;
    const soldiers = unit.soldiers;
    for (let i = 0; i < soldiers.length; i++) {
      const h = soldiers[i];
      if (h.herdAnchorId === null || !ChargobHandlers.usable(h)) continue;
      const dx = b.pos.x - h.pos.x;
      const dz = b.pos.z - h.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > pr2) continue;
      const d = Math.sqrt(d2);

      if (b.herdPullWanted && d2 <= pl2) {
        pullN++;
        if (d > 0.01) {
          pullX -= dx / d;
          pullZ -= dz / d;
        }
        continue;
      }
      if (!wantsMove || d < 0.01) continue;
      const ux = dx / d;
      const uz = dz / d;
      if (gl > 0.01 && (ux * gx + uz * gz) < 0.2) continue;
      pushN++;
      pushX += ux;
      pushZ += uz;
    }

    let vx = 0;
    let vz = 0;
    if (pushN > 0) {
      const len = Math.sqrt(pushX * pushX + pushZ * pushZ);
      if (len > 1e-6) {
        const m = pushPower(pushN);
        vx += pushX / len * m;
        vz += pushZ / len * m;
      }
    }
    if (pullN > 0) {
      const len = Math.sqrt(pullX * pullX + pullZ * pullZ);
      if (len > 1e-6) {
        const m = ChargobForces.pullPower(pullN);
        vx += pullX / len * m;
        vz += pullZ / len * m;
      }
    } else {
      vx += ex + hx;
      vz += ez + hz;
    }

    // --- wander: only when nothing moves the beast ---
    let mag = Math.sqrt(vx * vx + vz * vz);
    const base = b.surfaceMoveSpeed * CombatConfig.movement.globalSpeedScale * c.driveSpeedFrac;
    const idle = mag < 0.05 && pushN === 0 && pullN === 0
      && b.state !== 'engaged' && b.targetId === null && b.airborneTicksLeft <= 0;
    if (idle) {
      if (b.wanderLeft > 0) {
        vx = b.wanderDirX * c.wanderSpeedFrac;
        vz = b.wanderDirZ * c.wanderSpeedFrac;
        mag = c.wanderSpeedFrac;
        b.wanderLeft -= base * c.wanderSpeedFrac * dt;
      } else {
        b.wanderTicks--;
        if (b.wanderTicks <= 0) {
          const a = Math.random() * Math.PI * 2;
          b.wanderDirX = Math.sin(a);
          b.wanderDirZ = Math.cos(a);
          b.wanderLeft = c.wanderMinDist + Math.random() * (c.wanderMaxDist - c.wanderMinDist);
          b.wanderTicks = Math.round(c.wanderIntervalTicks * (0.7 + Math.random() * 0.6));
        }
      }
    } else {
      b.wanderLeft = 0;
    }

    if (mag < 0.01) {
      b.herdVx = 0;
      b.herdVz = 0;
      return;
    }
    const speed = base * Math.min(c.maxDriveFrac, mag);
    b.herdVx = vx / mag * speed;
    b.herdVz = vz / mag * speed;
  },

  // After FacingSystem: moves the beasts by their velocity of this tick and
  // turns them towards their way (rate-limited).
  apply(unit) {
    const c = CombatConfig.chargob;
    const dt = 1 / CombatConfig.tickRateHz;
    const companions = unit.companions;
    for (let i = 0; i < companions.length; i++) {
      const b = companions[i];
      if (!b.isAlive() || b.chargeActive || b.beastDetached) continue;
      const vx = b.herdVx;
      const vz = b.herdVz;
      if (vx === 0 && vz === 0) continue;
      b.herdVx = 0;
      b.herdVz = 0;
      if (b.chargePending) continue;

      const st = b.state;
      if (st === 'staggered' || st === 'knockedDown' || st === 'routing' || st === 'shattered') continue;
      if (b.airborneTicksLeft > 0) continue;
      if (st === 'engaged') {
        b.state = 'marching';
        b.targetId = null;
        b.disengageGraceTicksLeft = CombatConfig.disengage.graceTicks;
      }

      b.pos.x += vx * dt;
      b.pos.z += vz * dt;
      b.movedThisTick = true;
      b.currentSpeed = Math.sqrt(vx * vx + vz * vz);
      ChargobTurn.turn(b, Math.atan2(vx, vz), c.beastTurnRate);
      b.beastKeepFacing = b.facing;
    }
  }
};
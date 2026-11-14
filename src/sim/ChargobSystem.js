import { CombatConfig } from '../config/CombatConfig.js';
import { ChargobPack } from './ChargobPack.js';
import { ChargobCharge } from './ChargobCharge.js';
import { ChargobPoke } from './ChargobPoke.js';
import { ChargobHerd } from './ChargobHerd.js';
import { ChargobHandlers } from './ChargobHandlers.js';
import { ChargobAbandon } from './ChargobAbandon.js';
import { ChargobPanic } from './ChargobPanic.js';
import { ChargobForces } from './ChargobForces.js';
import { ChargobHandlerAI } from './ChargobHandlerAI.js';
import { ChargobTrample } from './ChargobTrample.js';
import { ChargobTurn } from './ChargobTurn.js';

// Per-tick behaviour of chargob beasts (unit.companions of units with
// companionKind 'chargob'). update() runs after the spatial grid is rebuilt
// and BEFORE TargetingSystem; afterFacing() runs right after FacingSystem.
//
// Per unit and tick:
//   1. beasts are sorted: charging (ChargobCharge.tick, already detached),
//      pending charges are started, the rest is "the line" (the herd).
//      A goaded beast ('poke') first stands still and turns to the unit's
//      direction (see _aimPoked); only when it looks that way does the
//      charge start, locking on the nearest enemy inside the 10 degree cone.
//   2. panic is updated (ChargobPanic); a beast at its threshold charges
//      ('panic'), looking the way it looks
//   3. random wild charge when too few handlers are left (below)
//   4. place the herd (ChargobHerd), goad jobs claim handlers (ChargobPoke),
//      the unit AI sends the other handlers to the beasts that need them
//      (ChargobHandlerAI), forces are worked out (ChargobForces)
//   5. unit.chargobHold (read by TargetingSystem): handlers stay out of the
//      fight while a beast stands in the line, EXCEPT while a handler is in
//      melee or an enemy is within meleeContactReach of one; then they fight.
//      The one-off retreat.
// After the units: ChargobTrample throws everybody a charging beast touches.
// afterFacing(): ChargobForces.apply moves and turns the beasts, goaded beasts
// turn to the unit's direction, ChargobHerd.afterFacing sets facings.
//
// A charging beast has left the unit: it does not count as a beast of the
// herd any more (so the handlers fall back when the last beast of the herd is
// gone, even while others still run).
//
// Wild charge: when the handlers left are at most (beasts / 5), once a second
// there is a (1 + (beasts/5 - handlers)) percent chance that one beast
// charges in a random direction. After an abandon the "beasts" are those that
// have no handler within abandonRange, and the handler count is 0. An
// abandoned herd still feels panic; beasts without a handler within
// abandonRange walk home (ChargobForces).

const DEG = Math.PI / 180;

export class ChargobSystem {
  constructor(spatialGrid) {
    this.spatialGrid = spatialGrid;
    this._tick = 0;
    this._line = [];
    this._pool = [];
  }

  update(units, unitsById, soldiersById, combat) {
    this._tick++;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.companionKind !== 'chargob') continue;
      this._updateUnit(unit, soldiersById, combat);
    }
    ChargobTrample.update(units, this._tick);
  }

  afterFacing(units) {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.companionKind !== 'chargob') continue;
      ChargobForces.apply(unit);
      this._aimPoked(unit);
      ChargobHerd.afterFacing(unit);
    }
  }

  // Goaded beasts turn to the unit's direction. When they look that way
  // (aimToleranceDeg) or after aimMaxTicks, chargeAimDone lets the next
  // update() start the charge.
  _aimPoked(unit) {
    const c = CombatConfig.chargob;
    const tol = c.aimToleranceDeg * DEG;
    const companions = unit.companions;
    for (let i = 0; i < companions.length; i++) {
      const b = companions[i];
      if (!b.isAlive() || b.chargeActive || b.chargePending !== 'poke' || b.chargeAimDone) continue;
      b.chargeAimTicks++;
      const rest = ChargobTurn.turn(b, unit.formationFacing, c.aimTurnRate);
      if (rest <= tol || b.chargeAimTicks >= c.aimMaxTicks) b.chargeAimDone = true;
    }
  }

  _updateUnit(unit, byId, combat) {
    ChargobHandlers.begin(unit);

    const line = this._line;
    line.length = 0;
    const companions = unit.companions;
    let liveBeasts = 0;

    for (let i = 0; i < companions.length; i++) {
      const b = companions[i];
      if (!b.isAlive()) continue;
      // Withdrawing with the unit: nothing to manage.
      if (b.state === 'routing' || b.state === 'shattered') continue;

      if (b.chargeActive) {
        ChargobCharge.tick(b);
        continue;
      }
      if (b.chargePending) {
        // A goaded beast first turns to the unit's direction.
        if (b.chargePending === 'poke' && !b.chargeAimDone) {
          ChargobPack.holdPosition(b);
          b.herdVx = 0;
          b.herdVz = 0;
          b.beastWalking = false;
          b.gaitRunning = false;
          liveBeasts++;
          continue;
        }
        ChargobCharge.start(b, this._modeOf(b.chargePending), this.spatialGrid);
        continue;
      }
      liveBeasts++;

      if (b.chargeSpent) {
        ChargobPack.holdPosition(b);
        continue;
      }
      line.push(b);
    }

    const leaving = unit.leavingBattle === true;
    const abandoned = unit.chargobAbandoned === true;
    const handlers = unit.getAliveCount();

    if (!leaving) {
      ChargobPanic.update(unit, line);
      this._panicCharges(line);

      if (abandoned) {
        const pool = this._pool;
        pool.length = 0;
        for (let i = 0; i < line.length; i++) {
          const b = line[i];
          if (!b.beastOrphaned && ChargobAbandon.isFarFromHandlers(unit, b)) b.beastOrphaned = true;
          if (b.beastOrphaned) pool.push(b);
        }
        this._wildCharge(pool, 0, line);
      } else {
        this._wildCharge(line, handlers, line);
      }
    }

    // Handlers hold back while a beast stands in the line, unless they are in
    // a fight: then they fight like any soldier.
    let hold = false;
    if (!leaving && !abandoned && line.length > 0) {
      if (unit._contactTick === undefined || this._tick - unit._contactTick >= 3) {
        unit._handlerContact = ChargobHandlers.inContact(unit, this.spatialGrid);
        unit._contactTick = this._tick;
      }
      hold = !unit._handlerContact;
    }
    unit.chargobHold = hold;

    // The last beast of the herd is gone: the handlers fall back once.
    if (!leaving && !abandoned && liveBeasts === 0 && companions.length > 0 && !unit._chargobRetreated) {
      unit._chargobRetreated = true;
      this._retreat(unit, handlers);
    }

    if (leaving) return;

    // Abandoned beasts have no handlers: only panic, enemies and the walk home move them.
    if (abandoned) {
      for (let i = 0; i < line.length; i++) {
        const b = line[i];
        b.herdNeed = false;
        b.beastStray = false;
        b.herdPullWanted = false;
        ChargobPack.holdPosition(b);
        b.beastWalking = false;
        b.gaitRunning = false;
      }
      ChargobForces.update(unit, line, this.spatialGrid);
      return;
    }

    ChargobHerd.place(unit, line);
    ChargobPoke.update(unit, line, byId, combat);
    ChargobHandlerAI.dispatch(unit, line, byId, combat);
    ChargobForces.update(unit, line, this.spatialGrid);
    ChargobHerd.scuffle(unit, line, combat);
  }

  _modeOf(pending) {
    if (pending === 'wild') return 'wild';
    if (pending === 'panic') return 'panic';
    return 'steer';
  }

  // Beasts whose panic reached their threshold charge at once and leave the line.
  _panicCharges(line) {
    for (let i = line.length - 1; i >= 0; i--) {
      const b = line[i];
      if (!ChargobPanic.shouldCharge(b)) continue;
      ChargobCharge.start(b, 'panic', this.spatialGrid);
      line.splice(i, 1);
    }
  }

  // Too few handlers to hold the beasts: one beast of `pool` may break loose.
  // The beast also leaves `line`.
  _wildCharge(pool, handlers, line) {
    if (pool.length === 0) return;
    if ((this._tick % CombatConfig.tickRateHz) !== 0) return;
    const c = CombatConfig.chargob;
    const threshold = pool.length / c.wildThresholdDivisor;
    if (handlers > threshold) return;
    const pct = c.wildBasePct + (threshold - handlers);
    if (Math.random() * 100 >= pct) return;

    const b = pool[Math.floor(Math.random() * pool.length)];
    const k = line.indexOf(b);
    if (k >= 0) line.splice(k, 1);
    ChargobCharge.start(b, 'wild', this.spatialGrid);
  }

  // Walks the handlers back, keeping their facing. Skipped when the unit
  // already has an order (the player's, or the AI's, wins).
  _retreat(unit, handlers) {
    if (handlers === 0 || unit.hasActiveOrder || unit.focusTargetUnitId) return;
    const c = unit.getCenter();
    const f = unit.formationFacing;
    const d = CombatConfig.chargob.retreatDistance;
    unit.issueMoveOrder(c.x - Math.sin(f) * d, c.z - Math.cos(f) * d, f);
  }
}
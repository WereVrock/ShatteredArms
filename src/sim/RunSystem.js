// Decides, once per tick, which units and soldiers are running.
// The only writer of unit.gaitRunning, soldier.gaitRunning and
// soldier.gaitHoldTicks.
//
// Unit level (so the block keeps one pace):
//   - unit.runEnabled (player button / AI), and the unit can run;
//   - it has an active move or attack order;
//   - fewer than RunConfig.maxEngagedFraction of its soldiers are in melee;
//   - average fatigue passes the stop / resume hysteresis.
// Soldier level:
//   - can run (not a thrall, not a foot skeleton), state idle or marching.
// Once a unit is running, every walking soldier of it runs — no release
// check, no approach slowdown. A "run" order runs all the way.
//
// Called at the start of MovementSystem.update.
import { RunConfig } from '../config/RunConfig.js';
import { Gait } from './Gait.js';
import { CombatConfig } from '../config/CombatConfig.js';

export class RunSystem {
  constructor() {
    this._seen = new Set();
  }

  update(allSoldiers, unitsById) {
    const seen = this._seen;
    seen.clear();
    for (let i = 0; i < allSoldiers.length; i++) {
      const id = allSoldiers[i].unitId;
      if (seen.has(id)) continue;
      seen.add(id);
      const unit = unitsById ? unitsById.get(id) : null;
      if (unit) this._updateUnit(unit);
    }
  }

  _updateUnit(unit) {
    const alive = unit.getAliveSoldiers();
    if (alive.length === 0) {
      unit.gaitRunning = false;
      return;
    }

    const unitRuns = this._unitRuns(unit, alive);
    unit.gaitRunning = unitRuns;

    const delay = RunConfig.spearLowerDelayTicks;
    for (let i = 0; i < alive.length; i++) {
      const s = alive[i];
      const runs = (unitRuns && this._soldierRuns(s)) || this._crewCatchUp(s, alive);
      s.gaitRunning = runs;
      if (runs) s.gaitHoldTicks = delay;
      else if (s.gaitHoldTicks > 0) s.gaitHoldTicks--;
      else s.gaitHoldTicks = 0;
    }
  }

_unitRuns(unit, alive) {
    // Debug trace. Enable from the browser console: window.__runDebug = true
    // Logs only when the reason changes, plus a speed sample every 30 ticks
    // while running. Inert (no allocation) when the flag is off.
    const dbg = typeof window !== 'undefined' && window.__runDebug === true;
    const stop = (reason) => {
      if (dbg && unit._runWhy !== reason) {
        unit._runWhy = reason;
        console.log(`[run] unit=${unit.id} NOT running: ${reason}`);
      }
      return false;
    };

    if (!unit.runEnabled) {
      unit._runExhausted = false;
      return stop('runEnabled is false');
    }
    if (!Gait.unitCanRun(unit)) {
      unit._runExhausted = false;
      return stop('unit cannot run (foot skeleton / no type)');
    }
    if (!unit.hasActiveOrder && !unit.focusTargetUnitId) {
      return stop('no active move/attack order');
    }

    let engaged = 0;
    let fatigueSum = 0;
    for (let i = 0; i < alive.length; i++) {
      const s = alive[i];
      if (s.isInMelee()) engaged++;
      fatigueSum += s.fatigue;
    }
    if (engaged / alive.length >= RunConfig.maxEngagedFraction) {
      return stop(`too many engaged (${engaged}/${alive.length})`);
    }

    const avg = fatigueSum / alive.length;
    if (unit._runExhausted) {
      if (avg >= RunConfig.resumeFatigue) unit._runExhausted = false;
      else return stop(`exhausted, avg fatigue ${avg.toFixed(1)}`);
    } else if (avg <= RunConfig.stopFatigue) {
      unit._runExhausted = true;
      return stop(`fatigue too low ${avg.toFixed(1)}`);
    }

    if (dbg) {
      unit._runWhy = 'RUNNING';
      unit._runDbgTick = ((unit._runDbgTick | 0) + 1) % 30;
      if (unit._runDbgTick === 1) {
        const s0 = alive[0];
        console.log(
          `[run] unit=${unit.id} RUNNING state=${s0.state} gaitRunning=${s0.gaitRunning} ` +
          `eff=${s0.effectiveMoveSpeed.toFixed(3)} terrainMult=${s0.terrainSpeedMult.toFixed(3)} ` +
          `actual=${s0.actualMoveSpeed.toFixed(3)} currentSpeed=${s0.currentSpeed.toFixed(3)} ` +
          `released=${unit.isMarchReleased(s0.id)}`
        );
      }
    }
    return true;
  }

  // A crew shooter that has fallen off its slot (its partner moved on, or
  // it was re-paired) runs back to it, whatever the unit's run setting.
  _crewCatchUp(s, soldiers) {
    if (s.crewRole !== 'shooter') return false;
    if (s.state !== 'idle' && s.state !== 'marching' && s.state !== 'ranged') return false;
    if (!Gait.soldierCanRun(s)) return false;
    const d = CombatConfig.crew?.catchUpDistance ?? 1.5;
    // Far from its carrier (its partner): run to it. An unpaired shooter
    // runs back to its own formation slot instead.
    let tx = s.formationSlot.x;
    let tz = s.formationSlot.z;
    if (s.crewPartnerId !== null) {
      for (let i = 0; i < soldiers.length; i++) {
        if (soldiers[i].id === s.crewPartnerId) {
          tx = soldiers[i].pos.x;
          tz = soldiers[i].pos.z;
          break;
        }
      }
    }
    const dx = tx - s.pos.x;
    const dz = tz - s.pos.z;
    return dx * dx + dz * dz > d * d;
  }

_soldierRuns(soldier) {
    // Run whenever the unit is running, the soldier's gait allows it, and
    // the soldier is actually walking. No release check, no approach
    // slowdown: "run" is a direct instruction, not a suggestion. The block
    // release that happens automatically once the anchor reaches
    // breakoffRange must NOT quietly convert the last leg to a walk — the
    // old release/directMarchStopDist gates did exactly that and are gone.
    //
    // Mounted were already unconditional before this change; they are now
    // covered by the same one-line rule as infantry.
    if (!Gait.soldierCanRun(soldier)) return false;
    if (soldier.state !== 'marching' && soldier.state !== 'idle') return false;
    return true;
  }
}
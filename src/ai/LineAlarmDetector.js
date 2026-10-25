// Detects "our line is under attack" so line units can stop setting up and
// start fighting. Without this, a line unit that is not itself in melee keeps
// executing its approach / hold logic (defence hold, shared-slot cohesion,
// plan 'hold' role) while a neighbour is being ground down alone.
//
// Triggers (either one):
//   1. A line unit (non-cavalry, non-ranged) has at least
//      AIConfig.lineAlarmEngagedFraction of its living soldiers in melee.
//   2. A non-cavalry, non-ranged, non-routing enemy unit is within
//      AIConfig.lineAlarmEnemyDist of any line unit's center. Cavalry is
//      excluded on purpose: a spear wall should not break formation to chase
//      horse that is merely passing by.
//
// Sticky: once triggered the alarm stays on for AIConfig.lineAlarmHoldTicks
// so the line does not flicker between assault and hold from one decision
// cycle to the next.
//
// Pure read of world state plus one hold timer. It does not issue orders;
// TeamAI publishes the result as worldCtx.lineUnderAttack and LineBehavior
// reacts to it.
import { AIConfig } from '../config/AIConfig.js';
import { isCavalry, isRanged } from '../config/UnitClasses.js';
import { unitTypeOf } from './behaviorUtils.js';
import { AIDebugLog } from './AIDebugLog.js';

function isMostlyRouting(unit) {
  const alive = unit.getAliveSoldiers();
  if (alive.length === 0) return true;
  let routing = 0;
  for (const s of alive) {
    if (s.isRouting) routing++;
  }
  return routing / alive.length >= 0.5;
}

export class LineAlarmDetector {
  constructor() {
    this._activeUntilTick = -1;
    this._active = false;
  }

  // lineUnits: this team's living melee line units (non-cavalry, non-ranged).
  // enemyUnits: living enemy units.
  // Returns true while the alarm is active.
  update(lineUnits, enemyUnits, tick) {
    const reason = this._findTrigger(lineUnits, enemyUnits);
    if (reason) {
      this._activeUntilTick = tick + AIConfig.lineAlarmHoldTicks;
    }

    const active = tick <= this._activeUntilTick;
    if (active !== this._active) {
      AIDebugLog.log('linealarm', tick,
        active ? `ALARM ON ${reason}` : 'ALARM OFF');
    }
    this._active = active;
    return active;
  }

  // Returns a short description of what tripped the alarm, or null.
  _findTrigger(lineUnits, enemyUnits) {
    const engagedBar = AIConfig.lineAlarmEngagedFraction;
    for (const unit of lineUnits) {
      if (unit.isDefeated()) continue;
      const alive = unit.getAliveSoldiers();
      if (alive.length === 0) continue;

      let engaged = 0;
      for (const s of alive) {
        if (s.isInMelee()) engaged++;
      }
      const fraction = engaged / alive.length;
      if (fraction >= engagedBar) {
        return `unit=${unit.id} engagedFraction=${fraction.toFixed(2)}`;
      }
    }

    const maxDistSq = AIConfig.lineAlarmEnemyDist * AIConfig.lineAlarmEnemyDist;
    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      const type = unitTypeOf(enemy);
      if (!type || isCavalry(type) || isRanged(type)) continue;
      if (isMostlyRouting(enemy)) continue;

      const ec = enemy.getCenter();
      for (const unit of lineUnits) {
        if (unit.isDefeated()) continue;
        const c = unit.getCenter();
        const dx = ec.x - c.x;
        const dz = ec.z - c.z;
        if (dx * dx + dz * dz <= maxDistSq) {
          return `enemy=${enemy.id} near unit=${unit.id}`;
        }
      }
    }

    return null;
  }
}
// Detects "our melee line is being shot by a stronger ranged force that
// nothing is dealing with", so the line can break formation and go after the
// shooters instead of standing in the arrow rain.
//
// Condition (all required, held continuously for rangedPressureMinHoldTicks):
//   1. At least one enemy ranged unit (alive, not mostly routing, nonzero
//      ranged power) is within rangedRange * rangedPressureExposureMult of
//      any of our line units.
//   2. Enemy team ranged power >= own team ranged power *
//      rangedPressureRatio (same Unit.getRangedPower basis as the stance
//      flip in TeamAI). Zero own power counts as outgunned.
//   3. That specific shooter is not already being engaged by us:
//        - archers: a non-fragile own ranged unit whose focus target is the
//          shooter and which is within rangedRange of it, or
//        - cavalry: a non-fragile own cavalry unit committed to the shooter,
//          or one that ChargeReadiness says would land a clean charge on it.
//      A cavalry unit blocked by a spear corridor does NOT count as cover.
//
// Sticky: once tripped it stays on for rangedPressureHoldTicks so the line
// does not flicker between assault and normal behavior.
//
// Pure read of world state plus a small hold timer. It issues no orders;
// TeamAI publishes the returned shooter list as worldCtx.rangedPressureTargets
// and LineBehavior reacts to it.
import { AIConfig } from '../config/AIConfig.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { isCavalry, isRanged, getRangedRange } from '../config/UnitClasses.js';
import { unitTypeOf, isFragile } from './behaviorUtils.js';
import { ChargeReadiness } from './ChargeReadiness.js';
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

function distanceBetween(a, b) {
  const ca = a.getCenter();
  const cb = b.getCenter();
  const dx = ca.x - cb.x;
  const dz = ca.z - cb.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function sumRangedPower(units) {
  let sum = 0;
  for (const u of units) {
    if (u.isDefeated()) continue;
    sum += u.getRangedPower();
  }
  return sum;
}

export class RangedPressureDetector {
  constructor() {
    this._conditionSinceTick = null;
    this._activeUntilTick = -1;
    this._active = false;
  }

  // ctx: { tick, lineUnits, ownUnits, enemyUnits, intents, worldCtx }
  // Returns an array of unengaged enemy shooter units while the break is
  // active, or null when it is not.
  update(ctx) {
    const { tick, lineUnits, ownUnits, enemyUnits, intents, worldCtx } = ctx;

    const shooters = this._exposedShooters(lineUnits, enemyUnits);
    const ownPower = sumRangedPower(ownUnits);
    const enemyPower = sumRangedPower(enemyUnits);
    const outgunned = enemyPower > 0 &&
      (ownPower <= 0 || enemyPower >= ownPower * AIConfig.rangedPressureRatio);
    const sticky = tick <= this._activeUntilTick;

    let unengaged = [];
    if (shooters.length > 0 && (outgunned || sticky)) {
      unengaged = shooters.filter(
        s => !this._isEngaged(s, ownUnits, enemyUnits, intents, worldCtx)
      );
    }

    if (outgunned && unengaged.length > 0) {
      if (this._conditionSinceTick === null) this._conditionSinceTick = tick;
      if (tick - this._conditionSinceTick >= AIConfig.rangedPressureMinHoldTicks) {
        this._activeUntilTick = tick + AIConfig.rangedPressureHoldTicks;
      }
    } else {
      this._conditionSinceTick = null;
    }

    const active = tick <= this._activeUntilTick && unengaged.length > 0;
    if (active !== this._active) {
      AIDebugLog.log('rangedpressure', tick,
        active
          ? `BREAK ON shooters=[${unengaged.map(u => u.id).join(',')}] ` +
            `ownPower=${ownPower.toFixed(1)} enemyPower=${enemyPower.toFixed(1)}`
          : 'BREAK OFF');
    }
    this._active = active;

    return active ? unengaged : null;
  }

  // Enemy ranged units able to fire at any of our line units right now.
  //
  // Per-shooter range: "exposed" means the shooter can actually reach our
  // line, which is a question about ITS range, not the global one. A
  // goblin archer at 12 range covering a spear unit 20 units away is not
  // a shooter we need to break formation for — it cannot hit anyone.
  _exposedShooters(lineUnits, enemyUnits) {
    const out = [];
    if (lineUnits.length === 0) return out;

    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      const type = unitTypeOf(enemy);
      if (!type || !isRanged(type)) continue;
      if (isMostlyRouting(enemy)) continue;
      if (enemy.getRangedPower() <= 0) continue;

      const shooterRange = getRangedRange(type);
      const maxDist = shooterRange * AIConfig.rangedPressureExposureMult;
      const maxSq = maxDist * maxDist;

      const ec = enemy.getCenter();
      for (const lineUnit of lineUnits) {
        if (lineUnit.isDefeated()) continue;
        const lc = lineUnit.getCenter();
        const dx = ec.x - lc.x;
        const dz = ec.z - lc.z;
        if (dx * dx + dz * dz <= maxSq) {
          out.push(enemy);
          break;
        }
      }
    }
    return out;
  }

  // Is any of our archers or cavalry already dealing with this shooter?
  //
  // The archer engagement check uses the ARCHER's own range, not the
  // global: a short-ranged archer focused on a shooter it cannot actually
  // reach does not count as cover — the line still needs to break.
  _isEngaged(shooter, ownUnits, enemyUnits, intents, worldCtx) {
    for (const own of ownUnits) {
      if (own.isDefeated()) continue;
      const type = unitTypeOf(own);
      if (!type) continue;
      if (isFragile(own, AIConfig.fragileMoraleThreshold)) continue;

      if (isRanged(type)) {
        const ownRange = getRangedRange(type);
        if (own.aiFocusTargetUnitId === shooter.id &&
            distanceBetween(own, shooter) <= ownRange) {
          return true;
        }
      }

      if (isCavalry(type)) {
        if (this._cavalryEngages(own, shooter, enemyUnits, intents, worldCtx)) {
          return true;
        }
      }
    }
    return false;
  }

  _cavalryEngages(cavUnit, shooter, enemyUnits, intents, worldCtx) {
    const intent = intents.get(cavUnit.id);
    if (intent.phase === 'committed' && intent.targetUnitId === shooter.id) return true;
    if (intent.phase === 'regrouping') return false;

    const readiness = ChargeReadiness.assess(cavUnit, shooter, enemyUnits, 0, worldCtx);
    return !!readiness.willLandClean;
  }
}
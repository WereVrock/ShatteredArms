// AI decisions about when a unit should run. Stateless.
//
// Running is fast but tiring, and spearmen raise their spears while running
// (they need about 2 s after stopping before they can lower them again). So
// the smart rules are:
//   - mounted units run to charge, to get out of a fight (regroup) and to
//     cover ground; short moves walk;
//   - archers run to reposition;
//   - melee infantry run to close distance, but stop running well before
//     contact so they arrive formed with their weapons ready (spearmen
//     earlier than the rest), and never run on defence stance;
//   - nobody starts running when the unit is already tired
//     (AIConfig.runMinFatigue); RunSystem enforces hard exhaustion.
// A tier with runSmart === false (weakened) skips all of that: it runs
// whenever the goal is far, however tired it is and however close the enemy.
import { AIConfig } from '../config/AIConfig.js';
import { isMounted, isRanged, isSpearmen, getRangedRange } from '../config/UnitClasses.js';
import { Gait } from '../sim/Gait.js';
import { nearestUnit, centerTowardUnit, unitTypeOf } from './behaviorUtils.js';

function avgFatigue(unit) {
  const alive = unit.getAliveSoldiers();
  if (alive.length === 0) return 0;
  let sum = 0;
  for (const s of alive) sum += s.fatigue;
  return sum / alive.length;
}

function isSmart(ctx) {
  return !ctx || !ctx.tierCfg || ctx.tierCfg.runSmart !== false;
}

export const RunDirector = {
  // A move-to-point order for `unit` toward (gx, gz). ctx = TeamAI worldCtx (may be null).
  forMove(unit, intent, gx, gz, ctx) {
    if (!Gait.unitCanRun(unit)) return false;

    const c = unit.getCenter();
    const dist = Math.hypot(gx - c.x, gz - c.z);
    const type = unitTypeOf(unit);
    const mounted = !!(type && isMounted(type));

    // Getting out of a fight: always run, however short the way.
    if (mounted && intent && intent.phase === 'regrouping' && dist >= 3) return true;

    if (dist < AIConfig.runMinGoalDist) return false;
    if (!isSmart(ctx)) return true;
    if (avgFatigue(unit) < AIConfig.runMinFatigue) return false;
    if (mounted) return true;
    if (type && isRanged(type)) return true;
    if (ctx && ctx.stance === 'defence') return false;

    const nearest = ctx && ctx.enemyUnits ? nearestUnit(unit, ctx.enemyUnits) : null;
    if (!nearest) return true;
    const { dist: enemyDist } = centerTowardUnit(unit, nearest);
    const stop = (type && isSpearmen(type))
      ? AIConfig.runStopEnemyDistSpear
      : AIConfig.runStopEnemyDistOther;
    return enemyDist > stop;
  },

  // A committed cavalry charge: the charge needs speed, so run unless exhausted.
  forCharge(unit, ctx) {
    if (!Gait.unitCanRun(unit)) return false;
    if (!isSmart(ctx)) return true;
    return avgFatigue(unit) >= AIConfig.runCavalryChargeMinFatigue;
  },

  // A ranged unit ordered to focus a target (it marches to its own standoff).
  forFocus(unit, target, ctx) {
    if (!Gait.unitCanRun(unit)) return false;
    const type = unitTypeOf(unit);
    const { dist } = centerTowardUnit(unit, target);
    const range = type ? getRangedRange(type) : 0;
    if (dist <= range * AIConfig.runFocusRangeMult) return false;
    if (!isSmart(ctx)) return true;
    return avgFatigue(unit) >= AIConfig.runMinFatigue;
  }
};
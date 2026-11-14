import { SpearWallConfig } from '../config/SpearWallConfig.js';
import { ShieldBlockCalculator } from './ShieldBlockCalculator.js';
import { SpearWall } from './SpearWall.js';

// Finds the second-rank spearmen who may strike an enemy that just attacked
// `defender`. Pure query: the roll, the cooldown and the strike itself are
// CombatResolutionSystem's job.

export const SecondRankSupport = {
  // Fills and returns `out` (cleared first).
  collect(defender, attacker, unitsById, out) {
    out.length = 0;
    const cfg = SpearWallConfig.supportStrike;
    if (!cfg || !(cfg.chance > 0)) return out;
    const unit = unitsById ? unitsById.get(defender.unitId) : null;
    if (!unit) return out;

    const friendSq = cfg.reachToFriendly * cfg.reachToFriendly;
    const enemySq = cfg.reachToEnemy * cfg.reachToEnemy;
    const soldiers = unit.soldiers;

    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (s === defender) continue;
      if (s.formationRank !== cfg.rank) continue;
      if (s.attackCooldownTicks > 0) continue;
      if (!s.isAlive()) continue;
      if (s.unitTypeDef.weaponType !== 'spear') continue;
      const st = s.state;
      if (st === 'routing' || st === 'shattered' || st === 'knockedDown' || st === 'staggered') continue;
      if (s.airborneTicksLeft > 0) continue;
      if (SpearWall.isSpearRaised(s)) continue;

      const fx = s.pos.x - defender.pos.x;
      const fz = s.pos.z - defender.pos.z;
      if (fx * fx + fz * fz > friendSq) continue;
      const ex = s.pos.x - attacker.pos.x;
      const ez = s.pos.z - attacker.pos.z;
      if (ex * ex + ez * ez > enemySq) continue;
      if (ShieldBlockCalculator.computeAngleOffShield(s, attacker.pos) > cfg.arcDeg) continue;

      out.push(s);
    }
    return out;
  }
};
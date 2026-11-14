import { CombatConfig } from '../config/CombatConfig.js';
import { SpearWallConfig } from '../config/SpearWallConfig.js';
import { ShieldBlockCalculator } from './ShieldBlockCalculator.js';
import { SpearWall } from './SpearWall.js';

// Charge brace. A charge only meets a braced wall when:
//   - the struck soldier is a spearman, standing still, facing the charger,
//     not knocked down and with his own spear unraised; and
//   - among the spearmen of his unit's FRONT ranks (SpearWallConfig.brace)
//     within `neighbourhood` of him, enough have unraised spears.
// Returns the unraised share (0..1) when braced, else 0. CombatResolution
// scales the counter damage with it.
//
// Routers do not hold the line and are not counted. Knocked down, staggered
// and airborne men are counted but not as unraised.

export const SpearBrace = {
  assess(defender, chargerPos, unitsById) {
    if (defender.unitTypeDef.weaponType !== 'spear') return 0;
    if (defender.state === 'knockedDown') return 0;
    if (defender.movedThisTick) return 0;
    if (SpearWall.isSpearRaised(defender)) return 0;
    const angleOff = ShieldBlockCalculator.computeAngleOffShield(defender, chargerPos);
    if (angleOff > CombatConfig.brace.frontalArcDeg) return 0;

    const unit = unitsById ? unitsById.get(defender.unitId) : null;
    if (!unit) return 1; // no unit context: personal brace only

    const cfg = SpearWallConfig.brace;
    const reachSq = cfg.neighbourhood * cfg.neighbourhood;
    const soldiers = unit.soldiers;
    let total = 0;
    let unraised = 0;

    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (s.formationRank >= cfg.ranks) continue;
      if (!s.isAlive()) continue;
      if (s.state === 'routing' || s.state === 'shattered') continue;
      if (s.unitTypeDef.weaponType !== 'spear') continue;
      const dx = s.pos.x - defender.pos.x;
      const dz = s.pos.z - defender.pos.z;
      if (dx * dx + dz * dz > reachSq) continue;

      total++;
      if (s.state === 'knockedDown' || s.state === 'staggered') continue;
      if (s.airborneTicksLeft > 0) continue;
      if (SpearWall.isSpearRaised(s)) continue;
      unraised++;
    }

    if (total === 0) return 0;
    const share = unraised / total;
    return share + 1e-6 >= cfg.minUnraisedFraction ? share : 0;
  }
};
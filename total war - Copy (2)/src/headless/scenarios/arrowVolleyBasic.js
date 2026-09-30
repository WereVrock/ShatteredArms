// Baseline: arrows fire, travel, and damage the target.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'arrow-volley-basic',
  name: 'Arrow: basic volley fires and damages',
  description:
    'BASELINE. 20 blue archers at (0,-15) fire at 12 red shieldless spears ' +
    'at (0,0). No AI on either side — archers auto-acquire via TargetingSystem. ' +
    'Read the health line: ranged.fire > 0, ranged.hit > 0, ranged.death > 0. ' +
    'If fire is 0, RangedCombatSystem is not spawning projectiles. If hit or ' +
    'death are 0, ProjectileSystem is not advancing/colliding/damaging.',
  maxTicks: 400,
  aiTeams: [],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -15, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('red-spear-1', 'red', 'spearmanNoShield', 0, 0, FACE_NORTH, { rows: 3, cols: 4 })
    ];
  }
};
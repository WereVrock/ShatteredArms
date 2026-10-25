// Variant sanity: shieldless inherits all weapon/category behavior, only loses shield block.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'shieldless-vs-shielded',
  name: 'Shieldless spear vs shielded spear',
  description: 'Variant sanity check: shieldless inherits all weapon/category behavior, only loses shield block.',
  maxTicks: 500,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', 0, -10, FACE_SOUTH),
      unit('red-spear-noshield-1', 'red', 'spearmanNoShield', 0, 10, FACE_NORTH)
    ];
  }
};
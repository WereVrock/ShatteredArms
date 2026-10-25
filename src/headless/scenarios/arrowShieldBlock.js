// Arrows hitting a shielded unit should produce block events.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'arrow-shield-block',
  name: 'Arrow: shields block incoming arrows',
  description:
    'SHIELD BLOCK. 20 blue archers fire at a red SHIELDED spear unit. Arrows ' +
    'arrive from the target\'s front arc (archers south, target facing north). ' +
    'Read the health line: ranged.block > 0 and possibly ranged.shieldBreak > 0. ' +
    'If block is 0 while hit > 0, ShieldBlockCalculator is not being called on ' +
    'arrow collision.',
  maxTicks: 400,
  aiTeams: [],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -15, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('red-spear-1', 'red', 'spearman', 0, 0, FACE_NORTH, { rows: 3, cols: 4 })
    ];
  }
};
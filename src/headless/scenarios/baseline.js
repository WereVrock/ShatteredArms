// Standard playtest shape regression: spear + sword + archer per side.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'baseline',
  name: 'Baseline: mixed battle',
  description: 'Spear + sword + archer per side. Regression test for the standard playtest shape.',
  maxTicks: 1200,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', -3, -12, FACE_SOUTH),
      unit('blue-sword-1', 'blue', 'swordsman', 0, -12, FACE_SOUTH),
      unit('blue-archer-1', 'blue', 'archer', 0, -15, FACE_SOUTH),

      unit('red-spear-1', 'red', 'spearman', -3, 12, FACE_NORTH),
      unit('red-sword-1', 'red', 'swordsman', 0, 12, FACE_NORTH),
      unit('red-archer-1', 'red', 'archer', 0, 15, FACE_NORTH)
    ];
  }
};
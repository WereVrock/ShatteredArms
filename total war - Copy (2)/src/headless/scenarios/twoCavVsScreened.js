// Two red cav, one spear screen, one archer unit. Tests sibling coordination.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'two-cav-vs-screened',
  name: 'Two cavalry vs screened archers',
  description: 'Two red cav, one spear screen, one archer unit. Tests sibling coordination and disengage independently.',
  maxTicks: 900,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', 0, -12, FACE_SOUTH),
      unit('blue-archer-1', 'blue', 'archer', 0, -15, FACE_SOUTH),

      unit('red-cav-1', 'red', 'cavalry', -3, 12, FACE_NORTH),
      unit('red-cav-2', 'red', 'cavalry', 3, 12, FACE_NORTH)
    ];
  }
};
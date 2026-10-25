// Symmetric infantry. Tests A1 line cohesion under pure melee.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'line-clash',
  name: 'Line clash: spear vs spear',
  description: 'Symmetric infantry. Tests A1 line cohesion under pure melee.',
  maxTicks: 1200,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', -4, -10, FACE_SOUTH),
      unit('blue-spear-2', 'blue', 'spearman', 0, -10, FACE_SOUTH),
      unit('blue-spear-3', 'blue', 'spearman', 4, -10, FACE_SOUTH),

      unit('red-spear-1', 'red', 'spearman', -4, 10, FACE_NORTH),
      unit('red-spear-2', 'red', 'spearman', 0, 10, FACE_NORTH),
      unit('red-spear-3', 'red', 'spearman', 4, 10, FACE_NORTH)
    ];
  }
};
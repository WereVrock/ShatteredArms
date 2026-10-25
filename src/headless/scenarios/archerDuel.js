// Ranged only. Tests focus fire and volley behavior with no melee.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'archer-duel',
  name: 'Archer duel',
  description: 'Ranged only. Tests focus fire and volley behavior with no melee.',
  maxTicks: 800,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -18, FACE_SOUTH),
      unit('red-archer-1', 'red', 'archer', 0, 18, FACE_NORTH)
    ];
  }
};
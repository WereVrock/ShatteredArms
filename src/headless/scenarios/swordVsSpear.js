// Tests sword-vs-spear-from-front damage penalty and attack-speed nullification.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'sword-vs-spear',
  name: 'Sword vs spear (frontal)',
  description: 'Tests sword-vs-spear-from-front damage penalty and attack-speed nullification.',
  maxTicks: 500,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', 0, -10, FACE_SOUTH),
      unit('red-sword-1', 'red', 'swordsman', 0, 10, FACE_NORTH)
    ];
  }
};
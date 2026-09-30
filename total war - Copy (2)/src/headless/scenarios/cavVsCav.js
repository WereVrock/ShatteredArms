// Cavalry vs cavalry head-on. Both sides commit against a target that can also brace.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'cav-vs-cav',
  name: 'Cavalry duel',
  description: 'Cav vs cav head-on. Both sides commit against a target that can also brace.',
  maxTicks: 600,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-cav-1', 'blue', 'cavalry', 0, -14, FACE_SOUTH),
      unit('red-cav-1', 'red', 'cavalry', 0, 14, FACE_NORTH)
    ];
  }
};
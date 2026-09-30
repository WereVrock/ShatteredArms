// Pure charge. AI should commit and close cleanly.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'cav-vs-exposed-archers',
  name: 'Cavalry vs exposed archers',
  description: 'Pure charge. AI should commit and close cleanly.',
  maxTicks: 600,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -12, FACE_SOUTH),
      unit('red-cav-1', 'red', 'cavalry', 0, 12, FACE_NORTH)
    ];
  }
};
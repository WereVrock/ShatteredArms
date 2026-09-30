// Spear screen starts far enough back that cav commits, then spears move in.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'cav-vs-screened-archers-wide',
  name: 'Cavalry vs screened archers (wide gap)',
  description: 'Spears positioned far enough that the cav commits, then spears move to screen. Stress-tests abort-on-approach.',
  maxTicks: 900,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', 0, -18, FACE_SOUTH),
      unit('blue-archer-1', 'blue', 'archer', 0, -14, FACE_SOUTH),
      unit('red-cav-1', 'red', 'cavalry', 0, 14, FACE_NORTH)
    ];
  }
};
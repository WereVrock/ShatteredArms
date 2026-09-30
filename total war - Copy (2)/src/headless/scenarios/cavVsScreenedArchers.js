// Archers behind a spear screen. Tests abort-on-approach and disengage-on-contact.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'cav-vs-screened-archers',
  name: 'Cavalry vs screened archers',
  description: 'Archers behind a spear unit. Tests abort-on-approach and disengage-on-contact.',
  maxTicks: 800,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', 0, -12, FACE_SOUTH),
      unit('blue-archer-1', 'blue', 'archer', 0, -15, FACE_SOUTH),
      unit('red-cav-1', 'red', 'cavalry', 0, 12, FACE_NORTH)
    ];
  }
};
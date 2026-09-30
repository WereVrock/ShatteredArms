// No clean charge exists. ChargeReadiness should abort every time.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'cav-vs-spear-line',
  name: 'Cavalry vs spear line',
  description: 'No clean charge exists. ChargeReadiness should abort every time.',
  maxTicks: 400,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', 0, -12, FACE_SOUTH),
      unit('red-cav-1', 'red', 'cavalry', 0, 12, FACE_NORTH)
    ];
  }
};
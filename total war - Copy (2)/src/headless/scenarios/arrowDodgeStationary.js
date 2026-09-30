// Control for the dodge test. Target does not move.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'arrow-dodge-stationary',
  name: 'Arrow dodge — control (stationary target)',
  description:
    'DODGE CONTROL. 20 blue archers at (0,-20) fire at 9 stationary red ' +
    'cavalry at (0,0). Because the target does not move, arrows aimed at its ' +
    'center at fire time are still near its center on arrival. Note the ' +
    'ranged.hit and ranged.death counts. Compare against ' +
    '"arrow-dodge-strafing" — same layout, but the target strafes.',
  maxTicks: 500,
  aiTeams: [],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -20, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('red-cav-1', 'red', 'cavalryNoShield', 0, 0, FACE_NORTH, { rows: 3, cols: 3 })
    ];
  }
};
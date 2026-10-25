// Control: friendly at the arc's apex. Arrows should sail over.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'arrow-friendly-mid-corridor',
  name: 'Arrow: mid-corridor friendly (arc protects)',
  description:
    'MID-CORRIDOR FRIENDLY (control). 20 blue archers at (0,-20) fire at a red ' +
    'spear unit at (0,0). A blue melee unit sits directly on the flight path at ' +
    '(0,-10) — the arc\'s apex, where y≈5.0. Arrows are ~3.3 world units above ' +
    'the body band [0.1, 1.7] there, so the friendly must NOT be hit. Read the ' +
    'end snapshot: blue-melee-1 should be at full strength. If it takes any ' +
    'casualties, arrows are flying flatter than the arc model specifies, or the ' +
    'body-band check is failing to reject high-y projectiles.',
  maxTicks: 500,
  aiTeams: [],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -20, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('blue-melee-1', 'blue', 'spearmanNoShield', 0, -10, FACE_SOUTH, { rows: 3, cols: 4 }),
      unit('red-spear-1', 'red', 'spearmanNoShield', 0, 0, FACE_NORTH, { rows: 3, cols: 4 })
    ];
  }
};
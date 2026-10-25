// Adjacent friendly unit takes arrows. Proves cross-unit friendly fire works.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'arrow-friendly-fire-cross-unit',
  name: 'Arrow: cross-unit friendly fire',
  description:
    'FRIENDLY FIRE (cross-unit). 20 blue archers at (0,-18) fire at a red ' +
    'spear target. A small blue melee unit sits at (2.5,-18) — same z as the ' +
    'archers, same +Z-facing direction, a DIFFERENT unit id. Arrows leaving the ' +
    'archer line pass through the blue melee formation at body height and hit ' +
    'it. Read the end snapshot: blue-melee-1 should be BELOW its start count. ' +
    'If it is full, the same-unit skip is over-broad (excluding all friendlies ' +
    'rather than only the shooter\'s own unit).',
  maxTicks: 400,
  aiTeams: [],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -18, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('blue-melee-1', 'blue', 'spearmanNoShield', 2.5, -18, FACE_SOUTH, { rows: 2, cols: 4 }),
      unit('red-spear-1', 'red', 'spearmanNoShield', 0, 0, FACE_NORTH, { rows: 3, cols: 4 })
    ];
  }
};
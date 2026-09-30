// Multi-rank archer formation. Same-unit skip must prevent self-hits.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'arrow-same-unit-skip',
  name: 'Arrow: same-unit self-hit is prevented',
  description:
    'SAME-UNIT SKIP. 20 blue archers in a 2x10 formation fire at a distant red ' +
    'target. Arrows leave the archer chest at body height (y=1.0) and would clip ' +
    'the front rank from the back rank if the same-unit skip were absent. Read ' +
    'the end snapshot: blue-archer-1 should be at 20/20. If it drops below 20, ' +
    'ProjectileSystem is not skipping the shooter\'s own unit.',
  maxTicks: 400,
  aiTeams: [],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -15, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('red-spear-1', 'red', 'spearmanNoShield', 0, 0, FACE_NORTH, { rows: 3, cols: 4 })
    ];
  }
};
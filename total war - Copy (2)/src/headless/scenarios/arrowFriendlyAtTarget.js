// Friendly just inside the target scatter disc, outside melee range.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'arrow-friendly-at-target',
  name: 'Arrow: friendly inside the target scatter disc',
  description:
    'FRIENDLY AT TARGET. 20 blue archers at (0,-20) fire at a 4-wide red ' +
    'spear line at (0,0). A SINGLE blue cavalry soldier sits at (0,-1.7), ' +
    'inside the archer scatter disc (radius 1.8 around the red unit\'s center) ' +
    'but OUTSIDE melee range: nearest red soldier is at (0.35,0), distance ' +
    '~1.735 > engagementRange 1.6. Cavalry is used deliberately — its ' +
    'discipline is "high", so its impetuousChance is 0 and it will never ' +
    'charge into melee. Regular infantry rolls impetuous (15%/tick while ' +
    'inside chargeSpotRange 3.5) and eventually closes the gap, contaminating ' +
    'the test with spear damage. Read the end snapshot: blue-melee-1 should ' +
    'take casualties from ARROWS ONLY. Isolate by grepping dmg=9.0 hits on ' +
    'blue-melee-1\'s soldier ID; melee damage would be dmg=12.0 from red ' +
    'spears, and there should be none. If blue-melee-1 is at full strength, ' +
    'arrows are not being resolved against the physical landing point.',
  maxTicks: 500,
  aiTeams: [],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -20, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('blue-melee-1', 'blue', 'cavalryNoShield', 0, -1.7, FACE_SOUTH, { rows: 1, cols: 1 }),
      unit('red-spear-1', 'red', 'spearmanNoShield', 0, 0, FACE_NORTH, { rows: 1, cols: 4 })
    ];
  }
};
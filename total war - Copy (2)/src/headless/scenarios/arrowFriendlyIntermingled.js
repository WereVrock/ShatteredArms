// Friendly in actual melee contact with the target. Arrows hit whoever is there.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'arrow-friendly-intermingled',
  name: 'Arrow: friendly intermingled with target in melee',
  description:
    'FRIENDLY IN MELEE. 20 blue archers at (0,-20) fire at a red spear unit at ' +
    '(0,0). A blue melee unit at (0,-0.5) is in melee contact with red from tick ' +
    '0 — the two formations overlap. Arrows descending into the disc cannot ' +
    'distinguish friend from foe; whoever is at the impact point takes the hit. ' +
    'This is the realistic "archers shoot into a melee" case. IMPORTANT: because ' +
    'the units are in melee from tick 0, the health line CANNOT separate arrow ' +
    'damage from spear damage — both units will show casualties either way. To ' +
    'confirm arrows are hitting the friendly, grep the log for dmg=9.0 events on ' +
    'blue-melee soldier IDs (arrows) vs dmg=12.0 events (red spear melee). Both ' +
    'should appear. What to look for as a FAILURE: blue-melee takes NO dmg=9.0 ' +
    'hits at all (arrows are being filtered from landing on friendlies); or red ' +
    'spear takes NO dmg=9.0 hits (arrows are being absorbed by the friendly ' +
    'formation before reaching the intended target).',
  maxTicks: 500,
  aiTeams: [],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -20, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('blue-melee-1', 'blue', 'spearmanNoShield', 0, -0.5, FACE_SOUTH, { rows: 3, cols: 4 }),
      unit('red-spear-1', 'red', 'spearmanNoShield', 0, 0, FACE_NORTH, { rows: 3, cols: 4 })
    ];
  }
};
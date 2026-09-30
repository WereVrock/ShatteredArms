// Test: enemy has decisive cavalry superiority. Red archers should hug the line.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'archer-hug-enemy-cav-superiority',
  name: 'Archer hug-line: enemy cavalry superiority (test)',
  description:
    'TEST for the cavalry-cover rule. Red has NO cavalry; blue has TWO cavalry ' +
    'units. BattleAssessment should compute skirmishersWithoutCavalryCover=true ' +
    '(ownCavalryCount=0 < enemyCavalryCount*0.667), so red archers hold just ' +
    'in front of the red spear line instead of advancing. Red archers start at ' +
    'z=+20, 8 units behind the red spear line at z=+12; expected behavior is ' +
    'they walk BACKWARD to z≈+10 (anchor + skirmisherForwardHugOffset) and hold ' +
    'there. Enable verbose logging and look for skirmish lines with "NO_CAV_COVER ' +
    'hug-line ownCav=0 enemyCav=30" (or similar). If archers instead advance past ' +
    'the spear line toward z≈0, the flag is not being set or the fall-through ' +
    'bug is still present.',
  maxTicks: 900,
  aiTeams: ['red'],
  build() {
    return [
      unit('red-spear-1', 'red', 'spearman', 0, 12, FACE_NORTH),
      unit('red-archer-1', 'red', 'archer', 0, 20, FACE_NORTH),

      unit('blue-spear-1', 'blue', 'spearman', 0, -12, FACE_SOUTH),
      unit('blue-cav-1', 'blue', 'cavalry', -4, -15, FACE_SOUTH),
      unit('blue-cav-2', 'blue', 'cavalry', 4, -15, FACE_SOUTH)
    ];
  }
};
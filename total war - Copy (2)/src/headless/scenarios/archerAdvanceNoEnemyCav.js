// Control: enemy has no cavalry. Red archers should advance to standoff.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'archer-advance-no-enemy-cav',
  name: 'Archer advance: no enemy cavalry (control)',
  description:
    'CONTROL for the cavalry-cover rule. Red has a cavalry unit; blue has NONE. ' +
    'BattleAssessment should compute skirmishersWithoutCavalryCover=false (enemy ' +
    'cavalry count is 0), so red archers advance to archerStandoffDist from the ' +
    'nearest blue unit instead of hugging the red spear line. Red archers start ' +
    'at z=+20, 8 units behind the red spear line at z=+12; expected behavior is ' +
    'they walk forward past the spear line toward z≈0. Enable verbose logging and ' +
    'look for skirmish lines with CTX_MOVE / NOCTX_ADVANCE and NO "NO_CAV_COVER" ' +
    'entries — the flag must stay OFF here.',
  maxTicks: 900,
  aiTeams: ['red'],
  build() {
    return [
      unit('red-spear-1', 'red', 'spearman', 0, 12, FACE_NORTH),
      unit('red-archer-1', 'red', 'archer', 0, 20, FACE_NORTH),
      unit('red-cav-1', 'red', 'cavalry', 3, 22, FACE_NORTH),

      unit('blue-spear-1', 'blue', 'spearman', 0, -12, FACE_SOUTH),
      unit('blue-archer-1', 'blue', 'archer', 0, -15, FACE_SOUTH)
    ];
  }
};
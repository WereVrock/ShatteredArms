// ===== CustomBattleBuilder.js =====
// Builds a scenario object from two arbitrary rosters (blue = player,
// red = AI). Same build() -> Unit[] shape as PlayableScenarios, but the
// unit list is supplied by the caller instead of hardcoded. Used by the
// main menu's Custom Battle setup screen.
//
// Roster entry shape (matches CampaignBattleBuilder's):
//   { id, typeId, aliveCount, maxCount, isUndead }

import { layoutRoster } from './RosterLayout.js';
import { CampaignConfig } from '../campaign/CampaignConfig.js';

const FACE_SOUTH = 0;
const FACE_NORTH = Math.PI;

export function buildCustomScenario(blueRoster, redRoster) {
  return {
    id: 'custom-battle',
    name: 'Custom Battle',
    description: '',
    playerTeamId: 'blue',
    aiTeamIds: ['red'],
    // Match campaign behavior: without this, a custom battle that opens
    // with the AI at a numerical disadvantage collapses into a rout
    // before any real fight happens.
    valiantDefenceTeamIds: ['red'],
    cameraTarget: { x: 0, z: 0 },
    cameraDistance: 44,
    cameraPitch: 0.95,
    build() {
      const units = [];
      units.push(...layoutRoster(blueRoster, 'blue', CampaignConfig.playerBaseZ, FACE_SOUTH));
      units.push(...layoutRoster(redRoster, 'red', CampaignConfig.aiBaseZ, FACE_NORTH));
      return units;
    }
  };
}
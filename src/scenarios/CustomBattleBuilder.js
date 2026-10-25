// ===== CustomBattleBuilder.js =====
// Builds a scenario object from two arbitrary rosters (blue, red) and a
// player-team selection. Same build() -> Unit[] shape as PlayableScenarios,
// but the unit list is supplied by the caller instead of hardcoded. Used by
// the main menu's Custom Battle setup screen.
//
// Roster entry shape (matches CampaignBattleBuilder's):
//   { id, typeId, aliveCount, maxCount, isUndead }
//
// playerTeamId is 'blue', 'red', or null. null puts BOTH teams under AI
// control (spectator mode). aiTeamIds is derived from it — every team that
// is not the player goes to the AI. All AI teams receive valiantDefence,
// matching the campaign's rationale: a custom battle that opens with one
// side at a numerical disadvantage should not collapse into a rout before
// any real fight happens.

import { layoutRoster } from './RosterLayout.js';
import { CampaignConfig } from '../campaign/CampaignConfig.js';
import { DEFAULT_AI_TIER } from '../config/AITierConfig.js';

const FACE_SOUTH = 0;
const FACE_NORTH = Math.PI;

const ALL_TEAM_IDS = ['blue', 'red'];

export function buildCustomScenario(blueRoster, redRoster, playerTeamId = 'blue', aiTierByTeamId = null) {
  // Normalise: only 'blue', 'red', or null are valid. Anything else falls
  // back to 'blue' so a stale persisted value can't produce a scenario
  // with no recognised player.
  const normalisedPlayer = (playerTeamId === 'red' || playerTeamId === null)
    ? playerTeamId
    : 'blue';

  const aiTeamIds = normalisedPlayer
    ? ALL_TEAM_IDS.filter(id => id !== normalisedPlayer)
    : ALL_TEAM_IDS.slice(); // both AI

  // Per-team AI difficulty. Defaults both entries here rather than
  // leaving the field absent, so BattleAI's per-team lookup
  // (`tierNameByTeamId[teamId]`) always resolves to a valid value
  // regardless of whether the caller supplied a map. Unknown tier ids
  // are forwarded as-is and fall back to the default inside
  // getTierConfig() at BattleAI construction time.
  const tiers = {
    blue: (aiTierByTeamId && aiTierByTeamId.blue) || DEFAULT_AI_TIER,
    red:  (aiTierByTeamId && aiTierByTeamId.red)  || DEFAULT_AI_TIER
  };

  return {
    id: 'custom-battle',
    name: 'Custom Battle',
    description: '',
    playerTeamId: normalisedPlayer,
    aiTeamIds,
    // Every AI team gets valiantDefence — see file header.
    valiantDefenceTeamIds: aiTeamIds.slice(),
    // Per-team difficulty, read by BattleAI via opts.tierNameByTeamId.
    // Emitted even when the roster is player-vs-player; harmless and
    // keeps the scenario shape uniform.
    aiTierByTeamId: tiers,
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
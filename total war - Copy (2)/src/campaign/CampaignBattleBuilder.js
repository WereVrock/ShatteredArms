// ===== CampaignBattleBuilder.js =====
import { UnitFamilies } from './UnitFamilies.js';
import { CampaignConfig } from './CampaignConfig.js';
import { layoutRoster } from '../scenarios/RosterLayout.js';

// Builds a scenario object for main.js's startScenario from a campaign state,
// plus the AI roster generator used when a battle begins. The scenario's
// build() places the player roster and the current AI roster on the field.
//
// Formation layout itself lives in src/scenarios/RosterLayout.js — shared
// with CustomBattleBuilder.

const FACE_SOUTH = 0;
const FACE_NORTH = Math.PI;

export function buildCampaignScenario(state) {
  return {
    id: `campaign-battle-${state.battleIndex}`,
    name: `Campaign — Battle ${state.battleIndex + 1}`,
    description: '',
    playerTeamId: 'blue',
    aiTeamIds: ['red'],
    // Campaign AI never adopts wholesale 'retreat' posture — it holds and
    // fights at full effort regardless of being outnumbered (see
    // BattleAssessment / TeamAI docs). Without this, a campaign battle that
    // opens with the AI at a numerical disadvantage collapses into a rout
    // before any real fight happens, which plays badly and reads as a bug.
    valiantDefenceTeamIds: ['red'],
    cameraTarget: { x: 0, z: 0 },
    cameraDistance: 44,
    cameraPitch: 0.95,
    build() {
      return buildUnits(state);
    }
  };
}

// AI unit count for a given battle index. Uses the handcrafted schedule
// while available, then grows linearly by aiCountGrowthPerBattle from the
// last scheduled value.
function aiCountForBattle(battleIndex) {
  const schedule = CampaignConfig.aiCountSchedule;
  if (battleIndex < schedule.length) return schedule[battleIndex];
  const overflow = battleIndex - schedule.length + 1;
  return schedule[schedule.length - 1] +
    overflow * CampaignConfig.aiCountGrowthPerBattle;
}

// Fresh AI roster for the given battle index. Types are random; isUndead is
// rolled per unit.
export function generateAIRoster(battleIndex) {
  const count = aiCountForBattle(battleIndex);
  const types = UnitFamilies.allTypeIds();
  const entries = [];
  for (let i = 0; i < count; i++) {
    const typeId = types[Math.floor(Math.random() * types.length)];
    const size = CampaignConfig.defaultSizes[typeId];
    entries.push({
      id: `ai-${battleIndex}-${i}`,
      typeId,
      aliveCount: size,
      maxCount: size,
      isUndead: Math.random() < CampaignConfig.aiUndeadChance
    });
  }
  return entries;
}

function buildUnits(state) {
  const units = [];
  const playerRoster = state.roster.filter(e => e.aliveCount > 0);
  const aiRoster = state.aiRoster;

  units.push(...layoutRoster(playerRoster, 'blue', CampaignConfig.playerBaseZ, FACE_SOUTH));
  units.push(...layoutRoster(aiRoster, 'red', CampaignConfig.aiBaseZ, FACE_NORTH));

  return units;
}
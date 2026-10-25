// ===== RosterLayout.js =====
// Shared roster placement used by both CampaignBattleBuilder and
// CustomBattleBuilder. Pure layout: given a list of roster entries
// ({ id, typeId, aliveCount, isUndead }), a team id, a base Z and a
// facing, produces Unit instances placed in one or more ranks side by
// side. Ranks stack behind the front rank; "behind" follows the facing
// (units facing south put later ranks at lower z).

import { FormationFactory } from '../sim/FormationFactory.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { CampaignConfig } from '../campaign/CampaignConfig.js';

export function layoutRoster(roster, teamId, baseZ, facing) {
  const units = [];
  if (roster.length === 0) return units;

  const perRank = CampaignConfig.maxUnitsPerRank;
  const cosFacing = Math.cos(facing);

  for (let i = 0; i < roster.length; i++) {
    const rank = Math.floor(i / perRank);
    const col = i % perRank;
    const inThisRank = Math.min(perRank, roster.length - rank * perRank);
    const rankWidth = (inThisRank - 1) * CampaignConfig.unitSpacing;
    const x = -rankWidth / 2 + col * CampaignConfig.unitSpacing;
    // Behind = -facing direction. cos(facing) is +1 for south, -1 for north.
    const z = baseZ - rank * CampaignConfig.rankSpacing * cosFacing;

    const entry = roster[i];
    units.push(buildUnit(entry, teamId, x, z, facing, !!entry.isUndead));
  }
  return units;
}

function buildUnit(entry, teamId, x, z, facing, isUndead) {
  return FormationFactory.createUnitWithCount({
    id: entry.id,
    teamId,
    unitTypeDef: UnitTypes[entry.typeId],
    originX: x,
    originZ: z,
    facing,
    count: entry.aliveCount,
    spacing: CampaignConfig.formationSpacing,
    isUndead
  });
}
// Shared roster placement used by both CampaignBattleBuilder and
// CustomBattleBuilder. Pure layout: given a list of roster entries
// ({ id, typeId, aliveCount, isUndead }), a team id, a base Z and a
// facing, produces Unit instances placed in one or more ranks side by
// side. Ranks stack behind the front rank; "behind" follows the facing
// (units facing south put later ranks at lower z).
//
// Spacing adapts to unit size. A unit's footprint grows with its soldier
// count: more columns (width) and more rows (depth). So:
//   - neighbours in a rank are spaced by
//     max(unitSpacing, half-widths + unitClearance),
//   - gaps between ranks are max(rankSpacing, deepest unit in either
//     neighbouring rank + rankClearance).
// For small units both reduce to the fixed unitSpacing / rankSpacing.

import { FormationFactory } from '../sim/FormationFactory.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { CampaignConfig } from '../campaign/CampaignConfig.js';

const DEFAULT_RANK_CLEARANCE = 0.5;
const DEFAULT_UNIT_CLEARANCE = 1.0;

export function layoutRoster(roster, teamId, baseZ, facing) {
  const units = [];
  if (roster.length === 0) return units;

  const perRank = CampaignConfig.maxUnitsPerRank;
  const cosFacing = Math.cos(facing);
  const footprints = roster.map(footprintOf);
  const rankOffsets = computeRankOffsets(footprints, perRank);

  for (let rank = 0; rank * perRank < roster.length; rank++) {
    const start = rank * perRank;
    const end = Math.min(roster.length, start + perRank);
    const xs = computeRankXs(footprints, start, end);
    // Behind = -facing direction. cos(facing) is +1 for south, -1 for north.
    const z = baseZ - rankOffsets[rank] * cosFacing;

    for (let i = start; i < end; i++) {
      const entry = roster[i];
      units.push(buildUnit(entry, teamId, xs[i - start], z, facing, !!entry.isUndead));
    }
  }
  return units;
}

// Width (side to side) and depth (front row to back row) of one entry.
function footprintOf(entry) {
  const typeDef = UnitTypes[entry.typeId];
  if (!typeDef) return { width: 0, depth: 0 };
  const spacing = CampaignConfig.formationSpacing;
  return {
    width: FormationFactory.widthForCount(entry.aliveCount, typeDef, spacing),
    depth: FormationFactory.depthForCount(entry.aliveCount, typeDef, spacing)
  };
}

// X centre of each unit in footprints[start..end), the rank centred on x=0.
function computeRankXs(footprints, start, end) {
  const clearance = CampaignConfig.unitClearance ?? DEFAULT_UNIT_CLEARANCE;
  const xs = [0];
  for (let i = start + 1; i < end; i++) {
    const gap = Math.max(
      CampaignConfig.unitSpacing,
      (footprints[i - 1].width + footprints[i].width) / 2 + clearance
    );
    xs.push(xs[xs.length - 1] + gap);
  }
  const shift = xs[xs.length - 1] / 2;
  return xs.map(x => x - shift);
}

// Distance of each rank from the front rank, in world units.
function computeRankOffsets(footprints, perRank) {
  const rankCount = Math.ceil(footprints.length / perRank);
  const clearance = CampaignConfig.rankClearance ?? DEFAULT_RANK_CLEARANCE;
  const offsets = [0];

  let previousDepth = rankDepth(footprints, 0, perRank);
  for (let rank = 1; rank < rankCount; rank++) {
    const depth = rankDepth(footprints, rank, perRank);
    const gap = Math.max(
      CampaignConfig.rankSpacing,
      Math.max(previousDepth, depth) + clearance
    );
    offsets.push(offsets[rank - 1] + gap);
    previousDepth = depth;
  }
  return offsets;
}

// Deepest unit in a rank.
function rankDepth(footprints, rank, perRank) {
  const start = rank * perRank;
  const end = Math.min(footprints.length, start + perRank);
  let depth = 0;
  for (let i = start; i < end; i++) depth = Math.max(depth, footprints[i].depth);
  return depth;
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
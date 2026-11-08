// Roster size scaling. Pure logic, no DOM.
//
// A roster entry's soldier count has no upper limit. The type's BASE size
// (its default recruitment size) is the step the +/- buttons move by: a
// human spearman (base 15) goes 15 -> 30 -> 45 -> ..., a goblin spearman
// (base 30) goes 30 -> 60 -> 90 -> ... A unit cannot be stepped down below
// its base size.
//
// The entry shape ({ id, typeId, isUndead, aliveCount, maxCount }) is
// unchanged, so persisted setups and network roster messages stay
// compatible.
//
// Shared by CustomBattleSetup and MPLobby so both screens agree on what
// "base size" means and on how a count changes.

import { UnitTypes } from '../config/UnitTypes.js';
import { CampaignConfig } from '../campaign/CampaignConfig.js';
import { raceOf } from '../config/RaceConfig.js';

// Human baseline used when a type has no explicit defaultSizes entry.
const HUMAN_BASELINE_SIZE = 15;

// Soldier count of a fresh unit of this type. An explicit
// CampaignConfig.defaultSizes entry wins; types without one fall back to
// the human baseline scaled by the race's unitSizeMultiplier, so a goblin
// without an explicit entry still fields twice a human's soldiers.
export function baseSizeFor(typeDef) {
  const configured = CampaignConfig.defaultSizes[typeDef.id];
  if (configured) return configured;
  const raceMult = raceOf(typeDef).unitSizeMultiplier ?? 1;
  return Math.max(1, Math.round(HUMAN_BASELINE_SIZE * raceMult));
}

// Everything a UI needs to draw a size control for an entry. `base` is the
// step size; a unit at or below its base size cannot be stepped down.
export function sizeStateOf(entry) {
  const typeDef = UnitTypes[entry.typeId];
  const count = Math.max(1, entry.aliveCount || 1);
  const base = typeDef ? baseSizeFor(typeDef) : count;
  return { base, count, canDecrease: count > base };
}

// Moves the entry up or down by one base size, mutating it in place.
// Returns true when the counts actually changed.
export function stepSoldierCount(entry, delta) {
  const { base, count, canDecrease } = sizeStateOf(entry);

  let next = count;
  if (delta > 0) next = count + base;
  else if (canDecrease) next = Math.max(base, count - base);

  if (entry.aliveCount === next && entry.maxCount === next) return false;
  entry.aliveCount = next;
  entry.maxCount = next;
  return true;
}
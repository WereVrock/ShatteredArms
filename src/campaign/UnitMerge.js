// ===== UnitMerge.js =====
// Pure data rules for merging roster entries (player roster and AI roster)
// and for reinforcing merged units. No UI, no sim.
//
// Merge rules:
//   - Same typeId and same isUndead flag. The champion retinue never merges.
//   - aliveCount and maxCount are summed.
//   - XP is the soldier-weighted average of the two units' TOTAL XP
//     (threshold of the current level + extra XP gained past it), and the
//     level is re-derived from that number. Entries that carry no
//     progression fields (AI roster entries) are merged without XP.
//   - A merged unit is fielded if either source unit was fielded.
//
// Reinforce rules:
//   - A reinforce costs ONE unmerged unit's full price and restores at most
//     one unmerged unit's worth of soldiers, never beyond maxCount.

import { CampaignConfig } from './CampaignConfig.js';
import { UNIT_LEVEL_THRESHOLDS, unitLevelForXp } from './UnitXp.js';

function hasProgress(entry) {
  return entry.xp !== undefined || entry.level !== undefined;
}

// Total accumulated XP of an entry. Uses the level's threshold as a floor
// so entries created at a level without XP (e.g. the Mercenary Captains'
// starting rider) do not lose their level when merged.
function totalXp(entry) {
  const level = Math.max(1, Math.floor(entry.level || 1));
  const idx = Math.min(level, UNIT_LEVEL_THRESHOLDS.length) - 1;
  const levelFloor = UNIT_LEVEL_THRESHOLDS[idx] || 0;
  return Math.max(entry.xp || 0, levelFloor);
}

function weight(entry) {
  return Math.max(0, entry.aliveCount || 0);
}

export function canMerge(a, b) {
  if (!a || !b || a === b || a.id === b.id) return false;
  if (a.hasChampion || b.hasChampion) return false;
  return a.typeId === b.typeId && !!a.isUndead === !!b.isUndead;
}

// Soldier-weighted average of both entries' total XP.
export function mergedXp(a, b) {
  const wa = weight(a);
  const wb = weight(b);
  const total = wa + wb;
  if (total <= 0) return (totalXp(a) + totalXp(b)) / 2;
  return (totalXp(a) * wa + totalXp(b) * wb) / total;
}

// Folds `source` into `target` (target keeps its id). Does NOT remove
// `source` from any array; see mergeInRoster for that. Returns false when
// the pair cannot merge.
export function mergeInto(target, source) {
  if (!canMerge(target, source)) return false;

  const progress = hasProgress(target) || hasProgress(source);
  const xp = progress ? mergedXp(target, source) : null;

  target.aliveCount += source.aliveCount;
  target.maxCount += source.maxCount;

  if (xp !== null) {
    target.xp = xp;
    target.level = unitLevelForXp(xp);
  }

  if (target.fielded !== undefined || source.fielded !== undefined) {
    target.fielded = target.fielded !== false || source.fielded !== false;
  }
  return true;
}

// Merges the entry `sourceId` into the entry `targetId` of `roster` and
// removes the source from the array. Returns false if nothing happened.
export function mergeInRoster(roster, targetId, sourceId) {
  const target = roster.find(e => e.id === targetId);
  const source = roster.find(e => e.id === sourceId);
  if (!target || !source) return false;
  if (!mergeInto(target, source)) return false;
  const idx = roster.indexOf(source);
  if (idx >= 0) roster.splice(idx, 1);
  return true;
}

// Soldier count of one unmerged unit of this entry's type.
export function unmergedSize(entry) {
  const base = CampaignConfig.defaultSizes[entry.typeId];
  if (typeof base === 'number' && base > 0) return Math.min(base, entry.maxCount);
  return entry.maxCount;
}

// How many soldiers one reinforce would restore.
export function reinforceAmount(entry) {
  const missing = Math.max(0, entry.maxCount - entry.aliveCount);
  return Math.min(missing, unmergedSize(entry));
}

// Applies one reinforce to the entry. Returns the number of soldiers added.
export function reinforce(entry) {
  const amount = reinforceAmount(entry);
  entry.aliveCount += amount;
  return amount;
}
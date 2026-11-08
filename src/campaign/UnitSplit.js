// ===== UnitSplit.js =====
// Pure data rules for splitting one roster entry into two. No UI, no sim.
//
// Two split modes:
//   base - detach one unmerged unit's worth of soldiers (the type's default
//          size, see UnitMerge.unmergedSize) into a new entry.
//   half - detach floor(maxCount / 2) into a new entry; the original keeps
//          the larger half.
//
// Rules:
//   - The champion retinue never splits.
//   - Both pieces must keep at least 1 max slot and 1 living soldier, so a
//     unit needs aliveCount >= 2 to be split.
//   - Living soldiers are divided in proportion to the two max sizes, then
//     nudged so neither piece ends up empty.
//   - Both pieces keep the source's level and XP. Merging them back yields
//     the same XP again (see UnitMerge.mergedXp).
//   - The detached piece is inserted right after the source in the roster.
//     Placing it fielded or in reserve is the caller's job (see
//     CampaignArmy.placeNew).

import { unmergedSize } from './UnitMerge.js';

export const SplitMode = Object.freeze({
  BASE: 'base',
  HALF: 'half'
});

// Max size of the piece that breaks away from the source.
function detachedMaxFor(entry, mode) {
  if (mode === SplitMode.BASE) return unmergedSize(entry);
  if (mode === SplitMode.HALF) return Math.floor(entry.maxCount / 2);
  return 0;
}

// Divides `alive` living soldiers between a piece with max `maxA` and a
// piece with max `maxB`. Returns [aliveA, aliveB].
function allocateAlive(alive, maxA, maxB) {
  const total = maxA + maxB;
  let a = Math.min(maxA, Math.round(alive * maxA / total));
  let b = alive - a;
  if (b > maxB) {
    b = maxB;
    a = alive - b;
  }
  if (alive >= 2) {
    if (a === 0) {
      a = 1;
      b = alive - 1;
    } else if (b === 0) {
      b = 1;
      a = alive - 1;
    }
  }
  return [a, b];
}

// Describes what a split would produce, or null when the split is not
// allowed. Does not modify the entry.
export function previewSplit(entry, mode) {
  if (!entry || entry.hasChampion) return null;
  if (!(entry.aliveCount >= 2)) return null;

  const detachedMax = detachedMaxFor(entry, mode);
  const keptMax = entry.maxCount - detachedMax;
  if (detachedMax < 1 || keptMax < 1) return null;

  const [detachedAlive, keptAlive] = allocateAlive(
    entry.aliveCount, detachedMax, keptMax
  );
  return { detachedMax, keptMax, detachedAlive, keptAlive };
}

export function canSplit(entry, mode) {
  return previewSplit(entry, mode) !== null;
}

function freshId(roster, source) {
  const used = new Set(roster.map(e => String(e.id)));
  let n = 1;
  while (used.has(`split-${source.typeId}-${n}`)) n++;
  return `split-${source.typeId}-${n}`;
}

// Splits the entry `entryId` of `roster` in place. The source shrinks, a
// new entry is inserted after it and returned. Returns null when the split
// is not allowed or the entry does not exist.
export function splitInRoster(roster, entryId, mode) {
  const idx = roster.findIndex(e => e.id === entryId);
  if (idx < 0) return null;

  const source = roster[idx];
  const plan = previewSplit(source, mode);
  if (!plan) return null;

  const detached = {
    ...source,
    id: freshId(roster, source),
    aliveCount: plan.detachedAlive,
    maxCount: plan.detachedMax
  };

  source.aliveCount = plan.keptAlive;
  source.maxCount = plan.keptMax;

  roster.splice(idx + 1, 0, detached);
  return detached;
}
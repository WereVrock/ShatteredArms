// ===== AIRosterCap.js =====
// Adds a purchased unit to an AI roster while honouring the unit cap.
//
// Under the cap the unit is simply appended. At the cap the AI first tries
// to make room by merging its weakest same-type pair, then appends. If no
// pair can merge, the unit is only accepted when it merges into an existing
// entry of the same type. Otherwise the purchase is refused and the caller
// must not spend gold.
//
// Pure data. AI entries are { id, typeId, aliveCount, maxCount, isUndead }.

import { canMerge, mergeInto, mergeInRoster } from './UnitMerge.js';

// Merges the two weakest entries of the best mergeable group (smallest
// combined size). The stronger entry keeps its id. Returns true on merge.
function mergeWeakestPair(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = e.typeId + '|' + (e.isUndead ? 1 : 0);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  let best = null;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => a.aliveCount - b.aliveCount);
    const size = sorted[0].aliveCount + sorted[1].aliveCount;
    if (!best || size < best.size) best = { weak: sorted[0], strong: sorted[1], size };
  }
  if (!best) return false;
  return mergeInRoster(entries, best.strong.id, best.weak.id);
}

export const AIRosterCap = {
  // Returns true when the candidate was placed (appended or merged).
  tryAdd(entries, candidate, cap) {
    if (entries.length < cap) {
      entries.push(candidate);
      return true;
    }
    if (mergeWeakestPair(entries)) {
      entries.push(candidate);
      return true;
    }
    const target = entries.find(e => canMerge(e, candidate));
    if (target) {
      mergeInto(target, candidate);
      return true;
    }
    return false;
  }
};
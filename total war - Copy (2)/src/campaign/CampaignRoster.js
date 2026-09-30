import { UnitFamilies } from './UnitFamilies.js';
import { CampaignConfig } from './CampaignConfig.js';

// Persistent roster of player-owned units across a campaign. Entries are
// plain objects:
//   { id, typeId, aliveCount, maxCount }
//
// `maxCount` is the size the unit was recruited at. "Recover" restores
// aliveCount to maxCount. A fresh unit starts at full strength.
//
// All operations here are pure data manipulation. No UI, no sim.

function newEntry(typeId, isUndead) {
  const size = CampaignConfig.defaultSizes[typeId];
  return {
    id: 'camp-' + Math.random().toString(36).slice(2, 10),
    typeId,
    isUndead: !!isUndead,
    aliveCount: size,
    maxCount: size
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const CampaignRoster = {
  // Fresh pool of `size` { typeId } entries. Duplicates are allowed — this
  // pool is a menu of options, not a strict set. Shuffled so display order
  // is random every time.
  generateInitialPool(size) {
    const types = UnitFamilies.allTypeIds();
    const pool = [];
    for (let i = 0; i < size; i++) {
      pool.push({ typeId: types[Math.floor(Math.random() * types.length)] });
    }
    return shuffle(pool);
  },

  // Build a roster from indices picked out of the pool.
  fromInitialPicks(pool, selectedIndices) {
    return selectedIndices.map(i => newEntry(pool[i].typeId));
  },

  // Build a roster from an explicit list of unit offers, each shaped
  // { typeId, isUndead }. Used by the sequential initial picker.
  fromOffers(offers) {
    return offers.map(o => newEntry(o.typeId, o.isUndead));
  },

  // Legacy helper: build from bare type ids (all living).
  fromTypeIds(typeIds) {
    return typeIds.map(t => newEntry(t, false));
  },

  addUnit(roster, typeId, isUndead) {
    roster.push(newEntry(typeId, isUndead));
  },

  // Write the post-battle alive counts back into the roster. `result` maps
  // roster entry id -> alive count.
  applyBattleResult(roster, result) {
    for (const entry of roster) {
      if (result[entry.id] !== undefined) {
        entry.aliveCount = Math.max(0, result[entry.id]);
      }
    }
  },

  // Drop entries whose unit was wiped out. Returns a new array.
  removeDestroyed(roster) {
    return roster.filter(e => e.aliveCount > 0);
  },

  recoverUnit(roster, entryId) {
    const entry = roster.find(e => e.id === entryId);
    if (!entry) return;
    entry.aliveCount = entry.maxCount;
  },

  hasRecoverableUnit(roster) {
    return roster.some(e => e.aliveCount < e.maxCount);
  }
};
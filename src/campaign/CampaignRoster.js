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
    maxCount: size,
    // Unit progression. XP accrues post-battle from the sum of all this
    // unit's soldiers' combat XP; level drives the per-level bonuses
    // applied at battle build time (see UnitXp.js and
    // CampaignBattleBuilder.applyPlayerUnitLevels).
    xp: 0,
    level: 1
  };
}

// Champion retinue entry. Same shape as a normal roster entry, plus a
// `hasChampion: true` marker the battle builder uses to find the entry
// and post-process the laid-out unit into a champion unit. The retinue
// type never appears in the recruitment pool (see UnitFamilies), so a
// normal entry can never accidentally carry this flag.
//
// The entry's size is 1 (the champion) + initialBodyguards. Bodyguard
// losses persist across battles just like any other unit's casualties —
// the champion can end up fighting alone if their guard is ground down.
function newChampionEntry(championDef) {
  const size = 1 + (championDef.initialBodyguards || 0);
  return {
    id: 'champ-' + Math.random().toString(36).slice(2, 10),
    typeId: championDef.unitTypeId,
    isUndead: false,
    aliveCount: size,
    maxCount: size,
    hasChampion: true,
    // Display override: this entry reads as the champion's name
    // ("Goblin Warlord"), not the retinue type's default label
    // ("Hobgoblin Retinue"). UI readers check this field first.
    customName: championDef.displayName,
    // The champion's retinue levels with the same rules as any other
    // unit. The retinue is a melee class, so it earns +10 max morale
    // per level — which then gets overridden by the champion's own
    // morale=200 setter, so the champion does not exceed 200 and the
    // guards benefit as normal.
    xp: 0,
    level: 1
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

  // Adds a fresh unit to the roster and returns the new entry, so callers
  // that need to post-process the entry (set a starting level, tag it)
  // can do so without a second lookup.
  addUnit(roster, typeId, isUndead) {
    const entry = newEntry(typeId, isUndead);
    roster.push(entry);
    return entry;
  },

  // Adds the champion's retinue entry. Returns the new entry so the caller
  // can record its id on the Champion instance. Idempotent on a roster
  // that already contains a champion entry — the caller is expected to
  // only call this once per campaign (see CampaignFlow.startNewCampaign).
  addChampionUnit(roster, championDef) {
    const entry = newChampionEntry(championDef);
    roster.push(entry);
    return entry;
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
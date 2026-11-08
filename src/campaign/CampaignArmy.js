// ===== CampaignArmy.js =====
// Pure data rules for the player's army: unit cap, fielded vs. reserve
// split, and the operations that move units between the two.
//
// A roster entry carries an optional `fielded` flag. Missing or true means
// fielded; only an explicit false means reserve. That keeps saves written
// before the cap existed fully fielded until normalize() trims them.
//
// The champion retinue (entry.hasChampion) is always fielded: the campaign
// treats a missing champion unit as a dead champion.

import { CampaignConfig } from './CampaignConfig.js';

function isFielded(entry) {
  return entry.fielded !== false;
}

// Healthiest first: highest aliveCount/maxCount, ties broken by the larger
// unit. To field the MOST DEPLETED units first instead, swap ra and rb.
function byFillPriority(a, b) {
  const ra = a.aliveCount / Math.max(1, a.maxCount);
  const rb = b.aliveCount / Math.max(1, b.maxCount);
  return (rb - ra) || (b.aliveCount - a.aliveCount);
}

export const CampaignArmy = {
  // Unit cap for the current commander. A champion def may declare its own
  // unitCap (Goblin Warlord: 12); everyone else uses the campaign default.
  capFor(champion) {
    const cap = champion && champion.def ? champion.def.unitCap : null;
    return typeof cap === 'number' ? cap : CampaignConfig.unitCap;
  },

  isFielded,

  fieldedEntries(roster) {
    return roster.filter(isFielded);
  },

  reserveEntries(roster) {
    return roster.filter(e => !isFielded(e));
  },

  fieldedCount(roster) {
    let n = 0;
    for (const e of roster) if (isFielded(e)) n++;
    return n;
  },

  openSlots(roster, cap) {
    return Math.max(0, cap - this.fieldedCount(roster));
  },

  // Units that actually join a battle, in roster order.
  fieldedForBattle(roster) {
    return roster.filter(e => isFielded(e) && e.aliveCount > 0);
  },

  // Decides where a freshly bought entry (already pushed to the roster) goes:
  // fielded while slots remain, reserve otherwise.
  placeNew(roster, entry, cap) {
    let n = 0;
    for (const e of roster) {
      if (e !== entry && isFielded(e)) n++;
    }
    entry.fielded = n < cap;
  },

  // Moves one entry into or out of the fielded set. Returns true on change.
  setFielded(roster, entryId, fielded, cap) {
    const entry = roster.find(e => e.id === entryId);
    if (!entry) return false;
    if (isFielded(entry) === fielded) return false;
    if (!fielded && entry.hasChampion) return false;
    if (fielded && this.openSlots(roster, cap) <= 0) return false;
    entry.fielded = fielded;
    return true;
  },

  // Swaps the fielded state of a fielded and a reserve entry.
  swap(roster, idA, idB) {
    const a = roster.find(e => e.id === idA);
    const b = roster.find(e => e.id === idB);
    if (!a || !b) return false;
    const aFielded = isFielded(a);
    const bFielded = isFielded(b);
    if (aFielded === bFielded) return false;
    const fieldedOne = aFielded ? a : b;
    if (fieldedOne.hasChampion) return false;
    a.fielded = bFielded;
    b.fielded = aFielded;
    return true;
  },

  // Fills every open slot from the reserve, healthiest units first.
  // Returns the number of units moved.
  fillOpenSlots(roster, cap) {
    const candidates = roster
      .filter(e => !isFielded(e) && e.aliveCount > 0)
      .sort(byFillPriority);
    let open = this.openSlots(roster, cap);
    let moved = 0;
    for (const e of candidates) {
      if (open <= 0) break;
      e.fielded = true;
      open--;
      moved++;
    }
    return moved;
  },

  // Repairs a roster that violates the cap (old saves, cheats): the champion
  // is forced fielded, then the last non-champion fielded entries are moved
  // to reserve until the fielded count fits.
  normalize(roster, cap) {
    for (const e of roster) {
      if (e.hasChampion) e.fielded = true;
    }
    let over = this.fieldedCount(roster) - cap;
    for (let i = roster.length - 1; i >= 0 && over > 0; i--) {
      const e = roster[i];
      if (isFielded(e) && !e.hasChampion) {
        e.fielded = false;
        over--;
      }
    }
  }
};
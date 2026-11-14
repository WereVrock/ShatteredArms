import { UnitTypes } from '../config/UnitTypes.js';
import { HoundPack } from '../sim/HoundPack.js';

// Per-handler hound counts of roster entries. An entry of a handler type
// carries `houndCounts`: one number per living handler (index = handler's
// position in the unit), the hounds that handler still owns. Missing numbers
// count as a full pack, so a fresh unit, a reinforced handler or an entry
// from an older save simply has all its hounds.
//
// Pure data rules plus two bridges to the simulation:
//   record()       after a battle: writes the survivors' counts (with the
//                  regeneration roll, see HoundPack.survivorCounts).
//   applyToUnits() at battle build: trims each unit's pack to its counts.

function perHandler(typeId) {
  return UnitTypes[typeId]?.hounds?.perHandler ?? 0;
}

export const HoundRoster = {
  hasHounds(entry) {
    return !!entry && perHandler(entry.typeId) > 0;
  },

  // Counts for `n` handlers, clamped to the pack size.
  normalized(entry, n) {
    const per = perHandler(entry.typeId);
    const src = Array.isArray(entry.houndCounts) ? entry.houndCounts : [];
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(Math.max(0, Math.min(per, src[i] ?? per)));
    }
    return out;
  },

  // Counts of a merged entry (target's handlers first, then the source's).
  merged(target, source) {
    return [
      ...HoundRoster.normalized(target, target.aliveCount),
      ...HoundRoster.normalized(source, source.aliveCount)
    ];
  },

  // After a battle: stores the surviving handlers' counts on the entries of
  // the player's handler units.
  record(roster, simUnits) {
    for (const unit of simUnits) {
      if (unit.teamId !== 'blue') continue;
      if (!unit.soldiers[0]?.unitTypeDef.hounds) continue;
      const entry = roster.find(e => e.id === unit.id);
      if (!entry) continue;
      const counts = HoundPack.survivorCounts(unit);
      if (counts) entry.houndCounts = counts;
    }
  },

  // At battle build: trims the packs of freshly built player units.
  applyToUnits(units, roster) {
    for (const unit of units) {
      if (!unit.soldiers[0]?.unitTypeDef.hounds) continue;
      const entry = roster.find(e => e.id === unit.id);
      if (!entry || !HoundRoster.hasHounds(entry)) continue;
      HoundPack.applyCounts(unit, HoundRoster.normalized(entry, unit.soldiers.length));
    }
  }
};
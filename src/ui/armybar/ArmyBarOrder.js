// Pure logic: the player's preferred card order, as a list of unit ids.
// No DOM. New units are appended in the order they first appear; units that
// vanish are simply skipped (their ids are harmless leftovers).

export class ArmyBarOrder {
  constructor() {
    this.ids = [];
  }

  // Returns a new array of `units` sorted by the stored order. Unknown
  // units are registered at the end first, so the initial order is the
  // order the scenario supplied them in.
  sort(units) {
    const known = new Set(this.ids);
    for (const u of units) {
      if (!known.has(u.id)) {
        this.ids.push(u.id);
        known.add(u.id);
      }
    }
    const rank = new Map();
    for (let i = 0; i < this.ids.length; i++) rank.set(this.ids[i], i);
    return units.slice().sort((a, b) => rank.get(a.id) - rank.get(b.id));
  }

  // Same as sort(), but every squad is made contiguous: all members appear
  // where the squad's first member sits in the stored order, keeping their
  // relative order. squadIdFor(unitId) returns undefined for ungrouped units.
  arrange(units, squadIdFor) {
    const ordered = this.sort(units);

    const membersBySquad = new Map();
    for (const u of ordered) {
      const squadId = squadIdFor(u.id);
      if (squadId === undefined) continue;
      let list = membersBySquad.get(squadId);
      if (!list) {
        list = [];
        membersBySquad.set(squadId, list);
      }
      list.push(u);
    }

    const out = [];
    const emitted = new Set();
    for (const u of ordered) {
      if (emitted.has(u.id)) continue;
      const squadId = squadIdFor(u.id);
      if (squadId === undefined) {
        out.push(u);
        emitted.add(u.id);
        continue;
      }
      for (const member of membersBySquad.get(squadId)) {
        out.push(member);
        emitted.add(member.id);
      }
    }
    return out;
  }

  // Makes the stored order match what the player currently sees. Called
  // before a drop so moves are relative to the screen, not to stale
  // adjacency. Ids not on screen keep their relative order at the end.
  normalize(displayIds) {
    const shown = new Set(displayIds);
    this.ids = displayIds.concat(this.ids.filter((id) => !shown.has(id)));
  }

  // Moves `draggedId` next to `targetId`. Returns true if the order changed.
  move(draggedId, targetId, placeAfter) {
    if (draggedId === targetId) return false;
    const from = this.ids.indexOf(draggedId);
    if (from < 0 || this.ids.indexOf(targetId) < 0) return false;

    this.ids.splice(from, 1);
    let to = this.ids.indexOf(targetId);
    if (placeAfter) to++;
    this.ids.splice(to, 0, draggedId);
    return true;
  }

  // Moves a whole block of ids (a squad) next to `anchorId`, keeping the
  // block's internal order. Returns true if the order changed.
  moveBlock(blockIds, anchorId, placeAfter) {
    const block = new Set(blockIds);
    if (block.has(anchorId)) return false;

    const rest = this.ids.filter((id) => !block.has(id));
    const at = rest.indexOf(anchorId);
    if (at < 0) return false;

    const members = this.ids.filter((id) => block.has(id));
    rest.splice(placeAfter ? at + 1 : at, 0, ...members);
    this.ids = rest;
    return true;
  }

  // Reorders the given units by keyFn(unit), ascending. The sort is stable,
  // so units with the same key keep their current relative order. Ids of
  // units not in `units` are kept at the end.
  sortByKey(units, keyFn) {
    this.sort(units);

    const keyById = new Map();
    for (const u of units) keyById.set(u.id, String(keyFn(u)));

    const present = this.ids.filter((id) => keyById.has(id));
    const others = this.ids.filter((id) => !keyById.has(id));
    present.sort((a, b) => keyById.get(a).localeCompare(keyById.get(b)));
    this.ids = present.concat(others);
  }
}
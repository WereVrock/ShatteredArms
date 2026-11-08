// Pure logic: RTS-style control groups 1-9. Maps a digit to a set of unit
// ids. A unit may belong to several groups. No DOM, no selection logic.
// `version` is bumped on every change so views can refresh cheaply.

export class ArmyControlGroups {
  constructor() {
    this.groups = new Map();
    this.version = 0;
  }

  // Replaces the group's contents. An empty list is ignored so pressing
  // Ctrl+digit with nothing selected cannot wipe a group by accident.
  assign(digit, unitIds) {
    if (!unitIds || unitIds.length === 0) return;
    this.groups.set(digit, new Set(unitIds));
    this.version++;
  }

  add(digit, unitIds) {
    if (!unitIds || unitIds.length === 0) return;
    const set = this.groups.get(digit) || new Set();
    for (const id of unitIds) set.add(id);
    this.groups.set(digit, set);
    this.version++;
  }

  unitIds(digit) {
    const set = this.groups.get(digit);
    return set ? Array.from(set) : [];
  }

  size(digit) {
    const set = this.groups.get(digit);
    return set ? set.size : 0;
  }

  // Badge text for a card: the digits of every group the unit is in,
  // ascending, e.g. "1 3". Empty string when ungrouped.
  labelFor(unitId) {
    const digits = [];
    for (const [digit, set] of this.groups) {
      if (set.has(unitId)) digits.push(digit);
    }
    digits.sort((a, b) => a - b);
    return digits.join(' ');
  }
}
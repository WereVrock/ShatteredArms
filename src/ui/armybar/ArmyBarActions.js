// Selection-side actions shared by the digit hotkeys, the toolbar's 1-9
// buttons and the squad tabs. No DOM. The only outbound calls are
// selectionController.selectUnit() and the optional focus callback.

const DOUBLE_TAP_MS = 350;

export class ArmyBarActions {
  constructor({ groups, getUnits, selectionController, onUnitFocus }) {
    this.groups = groups;
    this.getUnits = getUnits;
    this.selectionController = selectionController;
    this.onUnitFocus = onUnitFocus;
    this._lastDigit = 0;
    this._lastTime = 0;
  }

  // Stores the currently selected units in the control group.
  assignSelected(digit, additive) {
    const ids = this.getUnits().filter((u) => u.selected).map((u) => u.id);
    if (additive) this.groups.add(digit, ids);
    else this.groups.assign(digit, ids);
  }

  // Selects the control group. Tapping the same digit twice quickly (or
  // double-clicking its button) also centres the camera on its first unit.
  recall(digit, additive) {
    const byId = new Map();
    for (const u of this.getUnits()) byId.set(u.id, u);

    const targets = [];
    for (const id of this.groups.unitIds(digit)) {
      const u = byId.get(id);
      if (u) targets.push(u);
    }
    const living = targets.filter((u) => u.getAliveSoldiers().length > 0);
    if (living.length === 0) return;

    this.selectUnits(living, additive);

    const now = performance.now();
    const isDoubleTap = !additive
      && digit === this._lastDigit
      && now - this._lastTime < DOUBLE_TAP_MS;
    this._lastDigit = digit;
    this._lastTime = now;
    if (isDoubleTap && this.onUnitFocus) this.onUnitFocus(living[0]);
  }

  // Selects every given living unit. Only the very first call may replace
  // the selection; later calls add. Already-selected units are skipped so
  // a toggling selectUnit cannot deselect them.
  selectUnits(units, additive) {
    const targets = units.filter((u) => u.getAliveSoldiers().length > 0);
    for (let i = 0; i < targets.length; i++) {
      const u = targets[i];
      const additiveCall = additive || i > 0;
      if (additiveCall && u.selected) continue;
      this.selectionController.selectUnit(u, additiveCall);
    }
  }

// Card click. A unit in a squad selects its whole squad first; clicking
  // again while the whole squad is selected narrows to that one unit.
  //   squadUnits  every Unit of the card's squad, or null for a loose card
  //   wholeSquad  true for a collapsed squad, whose one card stands for all
  clickCard(unit, additive, squadUnits, wholeSquad) {
    const members = squadUnits
      ? squadUnits.filter((u) => u.getAliveSoldiers().length > 0)
      : [];
    if (members.length < 2) {
      this.selectionController.selectUnit(unit, additive);
      return;
    }

    if (additive) {
      if (unit.selected && !wholeSquad) this.selectionController.selectUnit(unit, true);
      else this.selectUnits(members, true);
      return;
    }

    const allSelected = members.every((u) => u.selected);
    if (wholeSquad || !allSelected) this.selectUnits(members, false);
    else this.selectionController.selectUnit(unit, false);
  }

  // Selects every living unit of the same type as `unit`, replacing the
  // current selection. typeKeyFn(unit) returns the type's identity.
  selectSameType(unit, typeKeyFn) {
    const key = typeKeyFn(unit);
    const same = this.getUnits().filter((u) => typeKeyFn(u) === key);
    this.selectUnits(same, false);
  }

}
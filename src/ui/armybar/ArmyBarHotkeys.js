// Digit-key control groups for the army bar.
//   Ctrl/Cmd + 1..9          assign selected units to the group
//   Ctrl/Cmd + Shift + 1..9  add selected units to the group
//   1..9                     select the group
//   Shift + 1..9             add the group to the current selection
//   double-tap 1..9          also centre the camera on the group
// Uses e.code so Shift does not turn digits into symbols. The behaviour
// itself lives in ArmyBarActions (shared with the toolbar buttons).
//
// One listener per owner element: #armyBar is reused across battles, so a
// new view replaces the previous view's listener. A hidden bar (turn-based
// local multiplayer) does not react to keys.

import { ArmyBarActions } from './ArmyBarActions.js';

const activeByOwner = new WeakMap();

export class ArmyBarHotkeys {
  constructor({ owner, groups, getUnits, selectionController, onUnitFocus }) {
    this.owner = owner;
    this.actions = new ArmyBarActions({
      groups,
      getUnits,
      selectionController,
      onUnitFocus
    });
    this._onKeyDown = (e) => this._handleKeyDown(e);
  }

  attach() {
    const previous = activeByOwner.get(this.owner);
    if (previous && previous !== this) previous.dispose();
    activeByOwner.set(this.owner, this);
    document.addEventListener('keydown', this._onKeyDown);
  }

  dispose() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (activeByOwner.get(this.owner) === this) activeByOwner.delete(this.owner);
  }

  _handleKeyDown(e) {
    if (e.repeat || e.altKey) return;
    if (this.owner.style.display === 'none') return;

    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }

    const match = /^Digit([1-9])$/.exec(e.code);
    if (!match) return;
    const digit = Number(match[1]);

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.actions.assignSelected(digit, e.shiftKey);
      return;
    }

    this.actions.recall(digit, e.shiftKey);
  }
}
// DOM controller for drag-to-reorder. Two kinds of things can be dragged:
// a card (one unit) and a squad tab (a whole squad). It owns only the
// pointer handling and the drop indicator; what a drop means is decided by
// the onDrop callback, so ids are passed through exactly as the view
// supplied them (never parsed back out of dataset strings).
//
//   onDrop({ kind: 'card' | 'squad', id, targetId, placeAfter })
//   isValidTarget(kind, id, targetUnitId) -> boolean   (optional)
//
// targetId is the unit id of the card the drop lands next to. Which card
// that is comes from ArmyBarDropTarget (nearest card, not only exact hits).

import { findDropTarget } from './ArmyBarDropTarget.js';

const DRAG_THRESHOLD_PX = 4;
const CLASS_DRAGGING = 'army-card-dragging';
const CLASS_BAR_ACTIVE = 'army-bar-drag-active';
const CLASS_DROP_BEFORE = 'army-card-drop-before';
const CLASS_DROP_AFTER = 'army-card-drop-after';

export class ArmyBarDrag {
  constructor(rootElement, onDrop, isValidTarget = null) {
    this.root = rootElement;
    this.onDrop = onDrop;
    this.isValidTarget = isValidTarget;
    this._cardIdByEl = new WeakMap();
    this._drag = null;
    this._onMove = (e) => this._handleMove(e);
    this._onUp = () => this._finish(true);
    this._onCancel = () => this._finish(false);
  }

  attach(cardEl, unitId) {
    this._cardIdByEl.set(cardEl, unitId);
    this._bind(cardEl, 'card', unitId);
  }

  attachSquad(chipEl, squadId) {
    this._bind(chipEl, 'squad', squadId);
  }

  _bind(el, kind, id) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Buttons inside a squad tab keep their own clicks.
      if (e.target.closest && e.target.closest('button')) return;

      this._detach();
      this._drag = {
        kind,
        id,
        el,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        targetEl: null,
        placeAfter: false
      };
      document.addEventListener('pointermove', this._onMove);
      document.addEventListener('pointerup', this._onUp);
      document.addEventListener('pointercancel', this._onCancel);
    });
  }

  _handleMove(e) {
    const d = this._drag;
    if (!d) return;

    if (!d.active) {
      const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (moved < DRAG_THRESHOLD_PX) return;
      d.active = true;
      d.el.classList.add(CLASS_DRAGGING);
      this.root.classList.add(CLASS_BAR_ACTIVE);
    }

    this._updateTarget(d, e.clientX, e.clientY);
  }

  _updateTarget(d, x, y) {
    const accept = (cardEl) => {
      const id = this._cardIdByEl.get(cardEl);
      if (id === undefined) return false;
      return !this.isValidTarget || this.isValidTarget(d.kind, d.id, id);
    };
    const hit = findDropTarget(this.root, d.el, x, y, accept);

    this._clearIndicator(d);
    d.targetEl = hit ? hit.el : null;
    if (!hit) return;

    d.placeAfter = hit.placeAfter;
    hit.el.classList.add(hit.placeAfter ? CLASS_DROP_AFTER : CLASS_DROP_BEFORE);
  }

  _clearIndicator(d) {
    if (!d || !d.targetEl) return;
    d.targetEl.classList.remove(CLASS_DROP_BEFORE, CLASS_DROP_AFTER);
  }

  _finish(drop) {
    const d = this._drag;
    this._detach();
    this._drag = null;
    if (!d || !d.active) return;

    this._clearIndicator(d);
    d.el.classList.remove(CLASS_DRAGGING);
    this.root.classList.remove(CLASS_BAR_ACTIVE);

    if (drop && d.targetEl && this.onDrop) {
      const targetId = this._cardIdByEl.get(d.targetEl);
      if (targetId !== undefined) {
        this.onDrop({
          kind: d.kind,
          id: d.id,
          targetId,
          placeAfter: d.placeAfter
        });
      }
    }
    this._swallowNextClick();
  }

  // Releasing a drag still fires a click (on a card, or on a squad tab);
  // swallow it at the document so a drag never doubles as a selection.
  _swallowNextClick() {
    const stop = (e) => e.stopPropagation();
    document.addEventListener('click', stop, true);
    setTimeout(() => document.removeEventListener('click', stop, true), 0);
  }

  _detach() {
    document.removeEventListener('pointermove', this._onMove);
    document.removeEventListener('pointerup', this._onUp);
    document.removeEventListener('pointercancel', this._onCancel);
  }

  dispose() {
    this._detach();
    this._drag = null;
  }
}
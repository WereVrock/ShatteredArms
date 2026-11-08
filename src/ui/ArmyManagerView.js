// ===== ArmyManagerView.js =====
// Modal for arranging the campaign army. Two areas:
//   Fielded  - units that join the next battle (shows open slots)
//   Reserve  - units that stay home; only shown while it holds units
//
// Interaction (HTML5 drag and drop):
//   - drag a card to the other area to move it
//   - drop a card on a card of the same type to merge them (valid merge
//     targets glow while dragging)
//   - drop a reserve card on a fielded card to swap them
//   - double-click a card to send it to the other area
//   - "Split" on a card opens a menu with the split options the controller
//     offered for it
//   - "Fill open slots" fills the open slots from the reserve
//
// Pure UI. It renders what config.getModel() returns and reports gestures
// through callbacks that answer true (changed) or false (rejected).
//
// config = {
//   getModel() -> { cap, fielded: Card[], reserve: Card[], openSlots, canFill },
//   canMerge(dragId, targetId) -> boolean,
//   onDropOnCard(dragId, targetId) -> boolean,
//   onDropOnPane(dragId, 'fielded' | 'reserve') -> boolean,
//   onSplit(id, mode) -> boolean,
//   onFill() -> boolean,
//   onCardRightClick(id, element),
//   onClose()
// }
// Card = { id, name, imageHtml, level, aliveCount, maxCount, depleted, locked,
//          splits: [{ mode, label, detail }] }
//
// Styles live in ArmyManagerStyles.js (all classes prefixed `amv-`).

import { attachRankBadge } from './UnitRank.js';
import { ensureArmyManagerStyles } from './ArmyManagerStyles.js';
import { ArmySplitMenu } from './ArmySplitMenu.js';
import { hasMergePair, mergeAllUnits } from './ArmyMergeAll.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class ArmyManagerView {
  constructor() {
    ensureArmyManagerStyles();
    this.root = el('div', 'amv-root');
    this._splitMenu = new ArmySplitMenu(this.root);
    this.root.addEventListener('mousedown', (e) => this._onRootMouseDown(e));
    document.body.appendChild(this.root);

    this._config = null;
    this._dragId = null;
  }

  isOpen() {
    return this.root.style.display === 'flex';
  }

  show(config) {
    this._config = config;
    this._dragId = null;
    this._render();
    this.root.style.display = 'flex';
    if (!this._onKeyDown) this._onKeyDown = (e) => this._handleKey(e);
    document.addEventListener('keydown', this._onKeyDown);
  }

  close() {
    if (!this.isOpen()) return;
    this._splitMenu.close();
    this.root.style.display = 'none';
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
    const cb = this._config ? this._config.onClose : null;
    this._config = null;
    this._dragId = null;
    if (cb) cb();
  }

  // Escape closes the split menu first, then the modal.
  _handleKey(e) {
    if (e.code !== 'Escape' || !this.isOpen()) return;
    if (this._splitMenu.isOpen()) {
      this._splitMenu.close();
      return;
    }
    this.close();
  }

  // A click outside an open split menu only dismisses the menu. The next
  // click on the backdrop closes the modal.
  _onRootMouseDown(e) {
    if (this._splitMenu.isOpen()) {
      const onMenu = this._splitMenu.contains(e.target);
      const onSplitBtn = e.target.closest && e.target.closest('.amv-split-btn');
      if (!onMenu && !onSplitBtn) {
        this._splitMenu.close();
        if (e.target === this.root) return;
      }
    }
    if (e.target === this.root) this.close();
  }

  // --- rendering ---------------------------------------------------------

  _render() {
    const cfg = this._config;
    if (!cfg) return;
    this._splitMenu.close();
    this._endDrag();
    const model = cfg.getModel();
    const hasReserve = model.reserve.length > 0;

    this.root.innerHTML = '';
    const panel = el('div', 'amv-panel');
    panel.appendChild(this._buildHeader());

    const body = el('div', 'amv-body');
    body.appendChild(this._buildFieldedPane(model, hasReserve));
    if (hasReserve) body.appendChild(this._buildReservePane(model));
    panel.appendChild(body);

    panel.appendChild(this._buildFooter());
    this.root.appendChild(panel);
  }

  _buildHeader() {
    const header = el('div', 'amv-header');
    const text = el('div', 'amv-header-text');
    text.appendChild(el('div', 'amv-title', 'Manage army'));
    text.appendChild(el('div', 'amv-subtitle',
      'Only units in the Fielded area join the next battle.'));
    header.appendChild(text);

    const close = el('button', 'amv-close', '\u00d7');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    header.appendChild(close);
    return header;
  }

  _buildFieldedPane(model, hasReserve) {
    const { pane, head, grid } = this._createPane(
      'fielded', 'Fielded', `${model.fielded.length}/${model.cap}`,
      'Joins the next battle'
    );

    const mergeAll = el('button', 'amv-btn', 'Merge all');
    mergeAll.type = 'button';
    mergeAll.disabled = !hasMergePair(this._config, model);
    mergeAll.title = 'Merge every group of same-type units as far as the rules allow';
    mergeAll.addEventListener('click', () => {
      this._apply(() => mergeAllUnits(this._config) > 0, mergeAll);
    });
    head.appendChild(mergeAll);

    const fill = el('button', 'amv-btn', 'Fill open slots');
    fill.type = 'button';
    fill.disabled = !model.canFill;
    fill.title = 'Move the healthiest reserve units into every open slot';
    fill.addEventListener('click', () => {
      this._apply(() => this._config.onFill(), fill);
    });
    head.appendChild(fill);

    for (const card of model.fielded) {
      grid.appendChild(this._buildCard(card, 'fielded', hasReserve));
    }
    for (let i = 0; i < model.openSlots; i++) {
      grid.appendChild(el('div', 'amv-slot', 'Open slot'));
    }
    return pane;
  }

  _buildReservePane(model) {
    const { pane, grid } = this._createPane(
      'reserve', 'Reserve', String(model.reserve.length),
      'Stays home. Will not join the next battle'
    );
    for (const card of model.reserve) {
      grid.appendChild(this._buildCard(card, 'reserve', true));
    }
    return pane;
  }

  _buildFooter() {
    const footer = el('div', 'amv-footer');
    footer.appendChild(el('div', 'amv-hint',
      'Drag a unit onto another of the same type to merge them. '
      + 'Drag between areas to change who fights, or double-click a unit '
      + 'to send it to the other area. Use Split to break a unit in two.'));
    const done = el('button', 'amv-btn amv-primary', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => this.close());
    footer.appendChild(done);
    return footer;
  }

  _createPane(key, title, count, note) {
    const pane = el('div', 'amv-pane' + (key === 'reserve' ? ' amv-reserve' : ''));
    const head = el('div', 'amv-pane-head');
    const titleEl = el('div', 'amv-pane-title', title);
    titleEl.appendChild(el('span', 'amv-pane-count', count));
    head.appendChild(titleEl);
    head.appendChild(el('div', 'amv-pane-note', note));
    pane.appendChild(head);

    const grid = el('div', 'amv-grid');
    pane.appendChild(grid);

    this._bindPaneDrop(pane, key);
    return { pane, head, grid };
  }

  _buildCard(card, paneKey, hasReserve) {
    const node = el('div', 'amv-card' + (card.locked ? ' amv-locked' : ''));
    node.dataset.id = card.id;
    node.title = card.locked
      ? `${card.name}: commander retinue, always fielded and cannot merge`
      : `${card.name}: drag to move or merge, double-click to send to the other area`;

    const icon = el('div', 'amv-card-icon');
    icon.innerHTML = card.imageHtml || '';
    attachRankBadge(icon, card.level);
    node.appendChild(icon);

    node.appendChild(el('div', 'amv-card-name', card.name));
    node.appendChild(el('div',
      'amv-card-count' + (card.depleted ? ' amv-depleted' : ''),
      `${card.aliveCount}/${card.maxCount}`));
    if (card.locked) node.appendChild(el('div', 'amv-card-tag', 'Commander'));

    if (card.splits && card.splits.length > 0) {
      node.appendChild(this._buildSplitButton(card));
    }

    if (!card.locked) {
      node.draggable = true;
      node.addEventListener('dragstart', (e) => {
        this._splitMenu.close();
        this._dragId = card.id;
        e.dataTransfer.setData('text/plain', card.id);
        e.dataTransfer.effectAllowed = 'move';
        // Deferred so the browser snapshots the undimmed card as drag image.
        setTimeout(() => {
          if (this._dragId !== card.id) return;
          node.classList.add('amv-dragging');
          this._markMergeTargets(card.id);
        }, 0);
      });
      node.addEventListener('dragend', () => this._endDrag());

      node.addEventListener('dblclick', () => {
        const to = paneKey === 'fielded' ? 'reserve' : 'fielded';
        if (to === 'reserve' && !hasReserve) return;
        this._apply(() => this._config.onDropOnPane(card.id, to), node);
      });
    }

    node.addEventListener('dragover', (e) => {
      if (!this._dragId || this._dragId === card.id) return;
      e.preventDefault();
      node.classList.add('amv-drop-hover');
    });
    node.addEventListener('dragleave', () => node.classList.remove('amv-drop-hover'));
    node.addEventListener('drop', (e) => {
      if (!this._dragId || this._dragId === card.id) return;
      e.preventDefault();
      e.stopPropagation();
      const dragId = this._dragId;
      this._apply(() => this._config.onDropOnCard(dragId, card.id), node);
    });

    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this._config && this._config.onCardRightClick) {
        this._config.onCardRightClick(card.id, node);
      }
    });

    return node;
  }

  _buildSplitButton(card) {
    const btn = el('button', 'amv-split-btn', 'Split');
    btn.type = 'button';
    btn.title = 'Split this unit into two';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._splitMenu.isOpenFor(card.id)) {
        this._splitMenu.close();
        return;
      }
      this._splitMenu.open(card, btn, (mode, item) => {
        this._apply(() => (
          this._config && this._config.onSplit
            ? this._config.onSplit(card.id, mode)
            : false
        ), item);
      });
    });
    // Without this a double-click on the button would also send the card
    // to the other area.
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    return btn;
  }

  // --- drag helpers ------------------------------------------------------

  _bindPaneDrop(pane, key) {
    pane.addEventListener('dragover', (e) => {
      if (!this._dragId) return;
      e.preventDefault();
      pane.classList.add('amv-drop-hover');
    });
    pane.addEventListener('dragleave', (e) => {
      if (!pane.contains(e.relatedTarget)) pane.classList.remove('amv-drop-hover');
    });
    pane.addEventListener('drop', (e) => {
      if (!this._dragId) return;
      e.preventDefault();
      const dragId = this._dragId;
      this._apply(() => this._config.onDropOnPane(dragId, key), pane);
    });
  }

  _markMergeTargets(dragId) {
    const cfg = this._config;
    if (!cfg) return;
    for (const n of this.root.querySelectorAll('.amv-card')) {
      const id = n.dataset.id;
      if (id !== dragId && cfg.canMerge(dragId, id)) n.classList.add('amv-merge-target');
    }
  }

  _endDrag() {
    this._dragId = null;
    const marked = this.root.querySelectorAll(
      '.amv-merge-target, .amv-dragging, .amv-drop-hover'
    );
    for (const n of marked) {
      n.classList.remove('amv-merge-target', 'amv-dragging', 'amv-drop-hover');
    }
  }

  // Runs a gesture callback. On success the whole view re-renders from the
  // model; on rejection the target shakes and nothing else changes.
  _apply(fn, target) {
    const ok = fn();
    this._endDrag();
    if (ok) {
      this._render();
      return;
    }
    target.classList.remove('amv-reject');
    void target.offsetWidth;
    target.classList.add('amv-reject');
    setTimeout(() => target.classList.remove('amv-reject'), 300);
  }
}
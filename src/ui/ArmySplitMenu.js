// ===== ArmySplitMenu.js =====
// Small popup listing the split options of one army-manager card. Pure UI:
// it renders the options it is given and reports the picked mode through a
// callback. The host element must be the full-viewport fixed root of the
// army manager so viewport coordinates can be used for positioning.
//
// card = { id, name, splits: [{ mode, label, detail }] }

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class ArmySplitMenu {
  constructor(host) {
    this.host = host;
    this._menu = null;
    this._ownerId = null;
  }

  isOpen() {
    return this._menu !== null;
  }

  isOpenFor(cardId) {
    return this._menu !== null && this._ownerId === cardId;
  }

  contains(node) {
    return this._menu !== null && this._menu.contains(node);
  }

  // onPick(mode, itemElement) fires when an option is clicked.
  open(card, anchor, onPick) {
    this.close();

    const menu = el('div', 'amv-menu');
    menu.appendChild(el('div', 'amv-menu-title', `Split ${card.name}`));

    for (const opt of card.splits) {
      const item = el('button', 'amv-menu-item');
      item.type = 'button';
      item.appendChild(el('span', 'amv-menu-label', opt.label));
      item.appendChild(el('span', 'amv-menu-detail', opt.detail));
      item.addEventListener('click', () => onPick(opt.mode, item));
      menu.appendChild(item);
    }

    this.host.appendChild(menu);
    this._menu = menu;
    this._ownerId = card.id;
    this._position(menu, anchor);
  }

  close() {
    if (this._menu && this._menu.parentNode) {
      this._menu.parentNode.removeChild(this._menu);
    }
    this._menu = null;
    this._ownerId = null;
  }

  // Below the anchor when it fits, above it otherwise; clamped to the
  // viewport horizontally.
  _position(menu, anchor) {
    const margin = 8;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();

    let left = Math.min(a.left, window.innerWidth - m.width - margin);
    left = Math.max(margin, left);

    let top = a.bottom + 4;
    if (top + m.height > window.innerHeight - margin) {
      top = Math.max(margin, a.top - m.height - 4);
    }

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }
}
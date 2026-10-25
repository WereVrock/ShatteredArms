// ===== CardPickerView.js =====
// Generic card-list picker. Renders a title, optional subtitle, an optional
// info block, a list of cards, and either a multi-select confirm button, a
// single-select dispatch, or a shop-style action button + continue button.
// Optional back button. Pure UI: reads a view-model config and calls
// callbacks. Never mutates sim or campaign state itself.
//
// Card shape:
//   { id, name, description?, imageHtml?, disabled?,
//     power?, typeId?, isUndead?, aliveCount?, maxCount?, teamId? }
//
// `power` is optional. When a finite number, it is displayed as a small
// badge in the card's top-right corner (see PowerBadge.appendPowerBadge).
// The other unit-descriptive fields (typeId, isUndead, aliveCount,
// maxCount, teamId) are opaque to this view — they are forwarded verbatim
// to onCardRightClick, which is how the caller (CampaignFlow) knows enough
// to build a preview for the UnitInfoPanel. CardPickerView does not read
// or interpret them.
//
// Interaction modes (in priority order):
//
//   mode: 'multi'
//     Cards toggle a selection set; a confirm button dispatches
//     onConfirm(selectedIds).
//
//   onCardAction(cardDef, cardElement) supplied
//     "Shop" style: clicking a card fires onCardAction WITHOUT closing or
//     advancing. The caller re-invokes show() if it needs to re-render.
//     A separate onContinue button (if supplied) dispatches the transition.
//
//   onSelect(id) supplied
//     Single-select: clicking a card dispatches immediately.
//
// `infoElement` is an optional DOM node inserted between the subtitle and
// the card list. Callers use it to render side info (campaign gold +
// roster, etc.) without teaching this view about any domain objects.
//
// `onCardRightClick(cardDef, cardElement)` is optional. When supplied,
// right-clicking any card fires it with the card's view-model and the
// live DOM element. preventDefault() suppresses the browser context menu,
// which would otherwise cover the panel that just opened.
import { insertPowerStatsAbove } from './PowerBadge.js';

export class CardPickerView {
  constructor(rootElement) {
    this.root = rootElement;
  }

  show(options) {
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');

    const panel = document.createElement('div');
    panel.className = 'menu-panel';

    if (options.title) {
      const title = document.createElement('h1');
      title.className = 'menu-title';
      title.textContent = options.title;
      panel.appendChild(title);
    }
    if (options.subtitle) {
      const sub = document.createElement('p');
      sub.className = 'menu-subtitle';
      sub.textContent = options.subtitle;
      panel.appendChild(sub);
    }

    if (options.infoElement) {
      panel.appendChild(options.infoElement);
    }

    const list = document.createElement('div');
    list.className = 'menu-list';
    const isHorizontal = options.orientation === 'horizontal';
    if (isHorizontal) list.classList.add('horizontal');

    const isMulti = options.mode === 'multi';
    const selected = new Set(options.selectedIds || []);
    const minSel = options.minSelections ?? 1;
    const maxSel = options.maxSelections ?? Infinity;
    const onCardRightClick = options.onCardRightClick || null;
    const onCardAction = options.onCardAction || null;
    let confirmBtn = null;

    function refreshMultiState() {
      for (const el of list.children) {
        el.classList.toggle('selected', selected.has(el.dataset.cardId));
      }
      if (confirmBtn) {
        const ok = selected.size >= minSel && selected.size <= maxSel;
        confirmBtn.disabled = !ok;
        confirmBtn.textContent = `${options.confirmLabel || 'Confirm'} (${selected.size}/${maxSel === Infinity ? '?' : maxSel})`;
      }
    }

    for (const cardDef of (options.cards || [])) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'menu-card';
      if (isHorizontal) card.classList.add('horizontal-choice');
      card.disabled = !!cardDef.disabled;
      card.dataset.cardId = cardDef.id;

      const name = document.createElement('div');
      name.className = 'menu-card-name';
      name.textContent = cardDef.name;
      card.appendChild(name);

      if (cardDef.description) {
        const desc = document.createElement('div');
        desc.className = 'menu-card-desc';
        desc.textContent = cardDef.description;
        card.appendChild(desc);
      }

      let imageEl = null;
      if (cardDef.imageHtml) {
        imageEl = document.createElement('div');
        imageEl.className = 'campaign-pick-icon';
        imageEl.innerHTML = cardDef.imageHtml;
        card.appendChild(imageEl);
      }

      // Stat row (power + soldier count), placed in normal flow just
      // above the image so it never overlaps the portrait. Either value
      // may be absent; the helper skips each missing badge independently.
      if (imageEl) {
        insertPowerStatsAbove(imageEl, {
          power: cardDef.power,
          soldiers: cardDef.soldiers
        });
      }

      card.addEventListener('click', () => {
        if (card.disabled) return;
        if (isMulti) {
          if (selected.has(cardDef.id)) selected.delete(cardDef.id);
          else selected.add(cardDef.id);
          refreshMultiState();
        } else if (onCardAction) {
          onCardAction(cardDef, card);
        } else if (options.onSelect) {
          options.onSelect(cardDef.id);
        }
      });

      // Right-click → caller-provided handler. Fires on every card
      // regardless of disabled state; the browser's default menu is
      // suppressed so it cannot cover the panel the handler just opened.
      //
      // Known limitation: on some browsers a <button disabled> swallows
      // mouse events entirely, so right-click on a disabled card may not
      // fire. Enabled cards are unaffected.
      if (onCardRightClick) {
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          onCardRightClick(cardDef, card);
        });
      }

      list.appendChild(card);
    }

    panel.appendChild(list);

    if (isMulti) {
      confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'menu-card menu-confirm';
      confirmBtn.disabled = true;
      confirmBtn.textContent = options.confirmLabel || 'Confirm';
      confirmBtn.addEventListener('click', () => {
        if (confirmBtn.disabled) return;
        options.onConfirm(Array.from(selected));
      });
      panel.appendChild(confirmBtn);
      refreshMultiState();
    }

    if (options.onContinue) {
      const cont = document.createElement('button');
      cont.type = 'button';
      cont.className = 'menu-card menu-confirm';
      cont.textContent = options.continueLabel || 'Continue';
      cont.addEventListener('click', () => options.onContinue());
      panel.appendChild(cont);
    }

    if (options.onBack) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'menu-card menu-back';
      back.textContent = options.backLabel || '← Back';
      back.addEventListener('click', () => options.onBack());
      panel.appendChild(back);
    }

    this.root.appendChild(panel);
  }

  hide() {
    this.root.classList.add('hidden');
  }
}
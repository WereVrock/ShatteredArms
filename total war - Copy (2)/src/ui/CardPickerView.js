// Generic card-list picker. Renders a title, optional subtitle, a list of
// cards, and either a multi-select confirm button or immediate single-select
// dispatch. Optional back button. Pure UI: reads a view-model config and
// calls callbacks. Never mutates sim or campaign state itself.
//
// Card shape: { id, name, description?, imageHtml?, disabled? }
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

    const list = document.createElement('div');
    list.className = 'menu-list';
    const isHorizontal = options.orientation === 'horizontal';
    if (isHorizontal) list.classList.add('horizontal');

    const isMulti = options.mode === 'multi';
    const selected = new Set(options.selectedIds || []);
    const minSel = options.minSelections ?? 1;
    const maxSel = options.maxSelections ?? Infinity;
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

      if (cardDef.imageHtml) {
        const image = document.createElement('div');
        image.className = 'campaign-pick-icon';
        image.innerHTML = cardDef.imageHtml;
        card.appendChild(image);
      }

      card.addEventListener('click', () => {
        if (card.disabled) return;
        if (isMulti) {
          if (selected.has(cardDef.id)) selected.delete(cardDef.id);
          else selected.add(cardDef.id);
          refreshMultiState();
        } else if (options.onSelect) {
          options.onSelect(cardDef.id);
        }
      });

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
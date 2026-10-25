// ===== AITierPicker.js =====
// Small inline segmented control: "AI Difficulty: [Best] [Weakened]".
//
// Two modes, chosen by the constructor options:
//
//   GLOBAL (default) — no `value` supplied. Reads and writes the shared
//     AITierPreference store and subscribes to it, so every picker on
//     every screen that uses this mode stays in sync and the choice
//     survives a page reload. This is what ScenarioMenu embeds.
//
//   CONTROLLED — `value` is a tier id string. The picker does NOT read
//     or write AITierPreference and does NOT subscribe. On click it
//     fires `onChange(newId)` and repaints itself against the new value.
//     Multiple controlled pickers can coexist with independent
//     selections. This is what CustomBattleSetup uses for its per-team
//     AI pickers.
//
// Two named options only. A difficulty tier is a named preset, not a
// slider — adding a third option would push the player toward thinking
// about the tier design rather than picking a side. Two labels fit on
// one line at panel width and read as a binary choice.
//
// `compact: true` shrinks padding and shortens the label to "AI:" for
// inline placement inside a team header row. The default styling is what
// the scenario menu uses.
//
// Lifecycle: menu screens that re-render on every click must call
// dispose() on the previous picker(s) before creating new ones — global
// mode registers an AITierPreference subscription, and leaking one per
// render is a real leak. ScenarioMenu.show() and
// CustomBattleSetup._render() both follow the dispose-then-rebuild
// pattern.

import { AITierPreference } from '../config/AITierPreference.js';

const OPTIONS = [
  {
    id: 'best_possible',
    label: 'Best',
    title: 'The AI plays at its strongest — full threat-based disengage, '
         + 'router chases with all checks, no self-defeating decisions.'
  },
  {
    id: 'weakened',
    label: 'Weakened',
    title: 'The AI plays with visible holes — fixed-timer cavalry disengage, '
         + 'uninformed router chases, ignores the cavalry-balance read.'
  }
];

// Resting / active button colours, hoisted so the enter/leave handlers
// and _apply() cannot drift. Filled strings rather than a class because
// the widget is small enough to keep self-contained — no stylesheet to
// inject, no risk of a name collision with existing .menu-card rules.
const BTN_REST_BG = '#1e2430';
const BTN_REST_BORDER = '#3a4a5e';
const BTN_REST_TEXT = '#aab';
const BTN_ACTIVE_BG = '#26354a';
const BTN_ACTIVE_BORDER = '#6a8ac0';
const BTN_ACTIVE_TEXT = '#e6eef8';

export class AITierPicker {
  constructor(options = {}) {
    // Mode selection. `value` must be a string to enable controlled
    // mode; an explicit null/undefined value falls back to global mode
    // so callers can pass `value: someMaybeUndefined` without
    // accidentally switching modes.
    this._controlled = typeof options.value === 'string';
    this._value = this._controlled ? options.value : null;
    this._onChange = options.onChange || null;
    this._compact = !!options.compact;

    this.el = document.createElement('div');
    this.el.className = 'ai-tier-picker';
    this.el.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'gap:' + (this._compact ? '4px' : '8px'),
      'margin:' + (this._compact ? '0' : '10px 0 14px'),
      'user-select:none'
    ].join(';');

    const label = document.createElement('span');
    label.textContent = this._compact ? 'AI:' : 'AI Difficulty';
    label.style.cssText = [
      'font-size:' + (this._compact ? '10px' : '11px'),
      'color:#8a9ab0',
      'letter-spacing:' + (this._compact ? '0.8px' : '1.4px'),
      'text-transform:uppercase'
    ].join(';');
    this.el.appendChild(label);

    this._buttons = new Map();

    const padV  = this._compact ? '3px'  : '5px';
    const padH  = this._compact ? '10px' : '16px';
    const fontSize = this._compact ? '11px' : '12px';

    for (const opt of OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = opt.label;
      btn.title = opt.title;
      btn.style.cssText = [
        'padding:' + padV + ' ' + padH,
        'font-family:inherit',
        'font-size:' + fontSize,
        'letter-spacing:0.6px',
        'border-radius:4px',
        'border:1px solid ' + BTN_REST_BORDER,
        'background:' + BTN_REST_BG,
        'color:' + BTN_REST_TEXT,
        'cursor:pointer',
        'transition:background 0.1s, border-color 0.1s, color 0.1s'
      ].join(';');

      btn.addEventListener('click', () => this._select(opt.id));
      // Hover only brightens the unselected option. Hovering the already-
      // active option would fight with the active styling, so it is
      // explicitly a no-op there.
      btn.addEventListener('mouseenter', () => {
        if (this._activeId() !== opt.id) btn.style.background = '#28303e';
      });
      btn.addEventListener('mouseleave', () => {
        if (this._activeId() !== opt.id) btn.style.background = BTN_REST_BG;
      });

      this._buttons.set(opt.id, btn);
      this.el.appendChild(btn);
    }

    this._apply();

    // Only the global-mode picker subscribes. A controlled picker has no
    // shared source of truth to follow — the caller drives it via
    // setValue() or by disposing and re-creating it.
    this._unsub = this._controlled
      ? null
      : AITierPreference.subscribe(() => this._apply());
  }

  // The tier id this picker currently treats as active. Global mode
  // reads the store; controlled mode reads its own cached value.
  _activeId() {
    return this._controlled ? this._value : AITierPreference.get();
  }

  _select(id) {
    if (this._controlled) {
      if (id === this._value) return;
      this._value = id;
      this._apply();
      if (this._onChange) this._onChange(id);
    } else {
      AITierPreference.set(id);
    }
  }

  // External update for controlled mode. No-op on the global picker,
  // which has AITierPreference as its source of truth. Useful when an
  // outside event (a reset, a loaded save) needs to move the picker
  // without a full re-render.
  setValue(id) {
    if (!this._controlled) return;
    if (id === this._value) return;
    this._value = id;
    this._apply();
  }

  _apply() {
    const active = this._activeId();
    for (const [id, btn] of this._buttons) {
      const isActive = id === active;
      btn.style.background  = isActive ? BTN_ACTIVE_BG     : BTN_REST_BG;
      btn.style.borderColor = isActive ? BTN_ACTIVE_BORDER : BTN_REST_BORDER;
      btn.style.color       = isActive ? BTN_ACTIVE_TEXT   : BTN_REST_TEXT;
    }
  }

  dispose() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}
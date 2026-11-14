// ===== src/ui/MenuBattleToggle.js =====
// ===== MenuBattleToggle.js =====
// Small "Disable Animation" checkbox shown only on the main menu.
// Reads and writes SettingsStore.menuBattleView, and reports the new
// value through onChange.
//
// Semantics:
//   checkbox UNCHECKED  -> menuBattleView = true  -> animation plays
//   checkbox CHECKED    -> menuBattleView = false -> still snapshot shown
//
// The onChange callback receives the ENABLED flag (true = animated,
// false = still), so downstream consumers do not need to know about
// the inverted checkbox convention.
//
// Positioned bottom-center so it does not overlap the buttons panel.
import { SettingsStore } from './settings/SettingsStore.js';

export class MenuBattleToggle {
  constructor({ onChange } = {}) {
    this._onChange = onChange || null;

    this.el = document.createElement('label');
    this.el.title =
      'When ticked, the main-menu battle background is replaced by a ' +
      'still snapshot (saves GPU). Untick to play the animated scene.';
    this.el.style.cssText = [
      'position:fixed',
      'left:50%',
      'transform:translateX(-50%)',
      'bottom:8px',
      'z-index:2000',
      'display:none',
      'align-items:center',
      'gap:6px',
      'height:30px',
      'padding:0 10px',
      'box-sizing:border-box',
      'background:linear-gradient(180deg,#2a2218 0%,#1a140e 100%)',
      'border:1px solid #6a4a1e',
      'border-radius:4px',
      'box-shadow:inset 0 0 0 1px #5a3a10',
      'color:#e8dcc0',
      "font-family:'Palatino Linotype','Book Antiqua',Palatino,Georgia,serif",
      'font-size:12px',
      'letter-spacing:0.4px',
      'cursor:pointer',
      'user-select:none'
    ].join(';');

    this._cb = document.createElement('input');
    this._cb.type = 'checkbox';
    this._cb.style.cssText = 'cursor:pointer;margin:0;';
    // Checked = animation DISABLED (menuBattleView === false). Matches
    // the "Disable Animation" label: ticking the box turns the animated
    // background off and shows the still snapshot instead.
    this._cb.checked = SettingsStore.get().menuBattleView === false;
    // Checked = disabled. Store the inverse (menuBattleView=true means
    // "animation enabled"), and forward the "enabled" flag to onChange
    // so downstream consumers keep the previous semantic: true =
    // animated, false = still image.
    this._cb.addEventListener('change', () => {
      const enabled = !this._cb.checked;
      SettingsStore.set('menuBattleView', enabled);
      if (this._onChange) this._onChange(enabled);
    });
    this.el.appendChild(this._cb);

    const text = document.createElement('span');
    text.textContent = 'Disable Animation';
    this.el.appendChild(text);

    // Sync the checkbox if the value is changed from elsewhere (FPS
    // auto-disable, a future settings-panel entry, a preset, etc.).
    // Cheap — set() fires only on actual changes.
    this._unsub = SettingsStore.subscribe(() => {
      this._cb.checked = SettingsStore.get().menuBattleView === false;
    });
  }

  show() {
    if (!this.el.parentNode) document.body.appendChild(this.el);
    this.el.style.display = 'flex';
  }

  hide() {
    this.el.style.display = 'none';
  }

  dispose() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}
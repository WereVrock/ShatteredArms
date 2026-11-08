// ===== CampViewToggle.js =====
// Small “Animated 3D camp” tick shown on every campaign screen that has the
// camp backdrop. Pure UI: it reads / writes SettingsStore.campView3d and
// reports the new value through onChange. It knows nothing about the camp
// renderer. Lives on document.body (bottom-right, left of the fullscreen
// button) so it survives picker re-renders that wipe #mainMenu.

import { SettingsStore } from './settings/SettingsStore.js';

export class CampViewToggle {
constructor({ onChange } = {}) {
this._onChange = onChange || null;

this.el = document.createElement('label');
this.el.title = 'Untick to show a still picture of the camp instead of the animated 3D scene (saves GPU).';
this.el.style.cssText = [
  'position:fixed',
  'right:46px',
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
this._cb.checked = SettingsStore.get().campView3d !== false;
this._cb.addEventListener('change', () => {
  SettingsStore.set('campView3d', this._cb.checked);
  if (this._onChange) this._onChange(this._cb.checked);
});
this.el.appendChild(this._cb);

const text = document.createElement('span');
text.textContent = 'Animated 3D camp';
this.el.appendChild(text);

// Keep the box in sync if the value is changed elsewhere.
this._unsub = SettingsStore.subscribe(() => {
  this._cb.checked = SettingsStore.get().campView3d !== false;
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
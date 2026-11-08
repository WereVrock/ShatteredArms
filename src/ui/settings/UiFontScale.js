import { SettingsStore } from './SettingsStore.js';

// Applies the "Font size" UI setting. The chosen scale is written to the
// --ui-font-scale CSS variable on the root element, and the zoom rule below
// scales the main menu, the top bar and the settings dialog by it.
// No game logic lives here.

const STYLE_ID = 'ui-font-scale-styles';

const STYLE_TEXT = `
  #mainMenu, #topBar {
    zoom: var(--ui-font-scale, 1);
  }
`;

export const UiFontScale = {
  OPTIONS: [
    { value: '1',    label: 'Normal' },
    { value: '1.15', label: 'Large' },
    { value: '1.3',  label: 'Larger' },
    { value: '1.5',  label: 'Huge' }
  ],

  init() {
    this._ensureStyles();
    this.apply();
    SettingsStore.subscribe((settings, key) => {
      // key is null when the store is reset to defaults.
      if (key === null || key === 'uiFontScale') this.apply();
    });
  },

  apply() {
    const raw = parseFloat(SettingsStore.get().uiFontScale);
    const scale = Number.isFinite(raw) && raw > 0 ? raw : 1;
    document.documentElement.style.setProperty('--ui-font-scale', String(scale));
  },

  _ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = STYLE_TEXT;
    document.head.appendChild(el);
  }
};
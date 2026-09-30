// ===== SettingsPanel.js =====
// The settings dialog. Two pages, swapped in place inside one modal shell:
//   root      — a list of category entries (currently just "Graphics")
//   graphics  — the Shadows / Ground texture / Grass / Field boundary / Fog
//               toggles
//
// Pure DOM overlay — knows only about SettingsStore, not about the game,
// the renderer, or the scene. One instance per page, opened from both the
// main menu and the in-game pause menu.
//
// Every toggle reads and writes SettingsStore directly. Applying the change
// to the running scene is not this class's job — SceneSetup is subscribed
// to SettingsStore by main.js and reacts on its own. Adding a new toggle
// therefore needs no change here beyond one _buildToggleRow call.
//
// Styled with inline styles so the panel works regardless of any external
// stylesheet. Palette matches the pause menu (dark slate with a light
// accent) so the two panels read as one family.
import { SettingsStore } from './SettingsStore.js';

export class SettingsPanel {
  constructor() {
    this._panel = null;

    // Toggle-row references. Non-null only while the graphics page is
    // mounted; nulled when returning to the root page so _syncFromStore
    // does not touch detached DOM nodes.
    this._shadowsToggle = null;
    this._groundToggle = null;
    this._grassToggle = null;
    this._fieldEdgeToggle = null;
    this._fogToggle = null;
    this._doubleClickToggle = null;

    this.el = this._buildShell();
    document.body.appendChild(this.el);

    this._unsub = SettingsStore.subscribe(() => this._syncFromStore());
    this._showMain();
  }

  // Always lands on the root page — so reopening the dialog never drops the
  // player back into a submenu they left open in a previous session.
  open() {
    this.el.style.display = 'flex';
    this._showMain();
  }

  close() {
    this.el.style.display = 'none';
  }

  get isOpen() {
    return this.el.style.display === 'flex';
  }

  dispose() {
    if (this._unsub) this._unsub();
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  // --- shell ----------------------------------------------------------------

  _buildShell() {
    const root = document.createElement('div');
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0, 0, 0, 0.55)',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '100',
      fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      color: '#e8e8e8'
    });

    // Backdrop click closes. mousedown (not click) so a drag that starts
    // inside the panel and releases on the backdrop does not close it.
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close();
    });

    this._panel = document.createElement('div');
    Object.assign(this._panel.style, {
      background: '#1e222a',
      border: '1px solid #384050',
      borderRadius: '8px',
      padding: '20px 24px',
      minWidth: '340px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
    });
    root.appendChild(this._panel);

    return root;
  }

  // --- pages ----------------------------------------------------------------

  _showMain() {
    this._clearToggleRefs();
    this._panel.innerHTML = '';
    this._panel.appendChild(this._buildTitleRow('Settings'));
    this._panel.appendChild(this._buildNavRow('Graphics', () => this._showGraphics()));
    this._panel.appendChild(this._buildNavRow('Gameplay', () => this._showGameplay()));
  }

  _showGraphics() {
    this._clearToggleRefs();
    this._panel.innerHTML = '';
    this._panel.appendChild(this._buildTitleRow('Graphics'));

    this._shadowsToggle = this._buildToggleRow('Shadows', 'shadows');
    this._panel.appendChild(this._shadowsToggle);

    this._groundToggle = this._buildToggleRow('Ground texture', 'groundTexture');
    this._panel.appendChild(this._groundToggle);

    this._grassToggle = this._buildToggleRow('Grass', 'grass');
    this._panel.appendChild(this._grassToggle);

    this._fieldEdgeToggle = this._buildToggleRow('Field boundary', 'fieldEdge');
    this._panel.appendChild(this._fieldEdgeToggle);

    this._fogToggle = this._buildToggleRow('Fog', 'fog');
    this._panel.appendChild(this._fogToggle);

    this._panel.appendChild(this._buildBackRow(() => this._showMain()));

    this._syncFromStore();
  }

  _showGameplay() {
    this._clearToggleRefs();
    this._panel.innerHTML = '';
    this._panel.appendChild(this._buildTitleRow('Gameplay'));

    this._doubleClickToggle = this._buildToggleRow(
      'Double-click: direct march',
      'doubleClickDirectMarch'
    );
    this._panel.appendChild(this._doubleClickToggle);

    this._panel.appendChild(this._buildBackRow(() => this._showMain()));

    this._syncFromStore();
  }

  _clearToggleRefs() {
    this._shadowsToggle = null;
    this._groundToggle = null;
    this._grassToggle = null;
    this._fieldEdgeToggle = null;
    this._fogToggle = null;
    this._doubleClickToggle = null;
  }

  // --- builders -------------------------------------------------------------

  _buildTitleRow(titleText) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '12px'
    });

    const title = document.createElement('h2');
    title.textContent = titleText;
    Object.assign(title.style, {
      margin: '0',
      fontSize: '18px',
      fontWeight: '600'
    });
    row.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00d7'; // multiplication sign, reads as an X
    Object.assign(closeBtn.style, {
      background: 'transparent',
      border: 'none',
      color: '#e8e8e8',
      fontSize: '24px',
      lineHeight: '1',
      cursor: 'pointer',
      padding: '0 4px'
    });
    closeBtn.addEventListener('click', () => this.close());
    row.appendChild(closeBtn);

    return row;
  }

  // A clickable row that navigates deeper into the settings tree. Reads as
  // a sibling of the toggle rows (same height and border) with a chevron
  // on the right signalling "opens something".
  _buildNavRow(labelText, onClick) {
    const row = document.createElement('button');
    row.type = 'button';
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      width: '100%',
      padding: '10px 0',
      border: 'none',
      borderBottom: '1px solid #2a2f3a',
      background: 'transparent',
      color: '#e8e8e8',
      fontSize: '14px',
      fontFamily: 'inherit',
      cursor: 'pointer',
      textAlign: 'left'
    });
    row.addEventListener('mouseenter', () => { row.style.color = '#ffffff'; });
    row.addEventListener('mouseleave', () => { row.style.color = '#e8e8e8'; });
    row.addEventListener('click', onClick);

    const text = document.createElement('span');
    text.textContent = labelText;
    row.appendChild(text);

    const chevron = document.createElement('span');
    chevron.textContent = '\u203a'; // single right-pointing angle quote
    chevron.style.fontSize = '18px';
    chevron.style.opacity = '0.6';
    row.appendChild(chevron);

    return row;
  }

  // A label + checkbox row. The whole row is the label, so clicking anywhere
  // on it toggles the checkbox. The checkbox is stored on the row so
  // _syncFromStore can find it without re-querying the DOM.
  _buildToggleRow(labelText, settingsKey) {
    const row = document.createElement('label');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 0',
      borderBottom: '1px solid #2a2f3a',
      cursor: 'pointer',
      userSelect: 'none'
    });

    const text = document.createElement('span');
    text.textContent = labelText;
    text.style.fontSize = '14px';
    row.appendChild(text);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.style.cursor = 'pointer';
    checkbox.addEventListener('change', () => {
      SettingsStore.set(settingsKey, checkbox.checked);
    });
    row.appendChild(checkbox);

    row._checkbox = checkbox;
    return row;
  }

  _buildBackRow(onClick) {
    const row = document.createElement('button');
    row.type = 'button';
    Object.assign(row.style, {
      display: 'block',
      width: '100%',
      marginTop: '12px',
      padding: '8px 0',
      border: '1px solid #384050',
      borderRadius: '6px',
      background: '#2a2f3a',
      color: '#e8e8e8',
      fontSize: '14px',
      fontFamily: 'inherit',
      cursor: 'pointer',
      textAlign: 'center'
    });
    row.addEventListener('mouseenter', () => { row.style.background = '#343a48'; });
    row.addEventListener('mouseleave', () => { row.style.background = '#2a2f3a'; });
    row.textContent = '\u2190 Back';
    row.addEventListener('click', onClick);
    return row;
  }

  // --- state sync -----------------------------------------------------------

  _syncFromStore() {
    const s = SettingsStore.get();
    // Toggle refs are null whenever their page is not mounted, so these
    // guards double as "is the page visible" checks.
    if (this._shadowsToggle)     this._shadowsToggle._checkbox.checked     = !!s.shadows;
    if (this._groundToggle)      this._groundToggle._checkbox.checked      = !!s.groundTexture;
    if (this._grassToggle)       this._grassToggle._checkbox.checked       = !!s.grass;
    if (this._fieldEdgeToggle)   this._fieldEdgeToggle._checkbox.checked   = !!s.fieldEdge;
    if (this._fogToggle)         this._fogToggle._checkbox.checked         = !!s.fog;
    if (this._doubleClickToggle) this._doubleClickToggle._checkbox.checked = !!s.doubleClickDirectMarch;
  }
}
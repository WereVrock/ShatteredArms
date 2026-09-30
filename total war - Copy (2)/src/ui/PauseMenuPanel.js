// ===== PauseMenuPanel.js =====
// The small in-game menu that the HUD menu button opens. Three actions:
//   Close             — dismiss this panel, back to the battle
//   Settings          — open the shared SettingsPanel on top
//   Exit to Main Menu — tear down the battle and return to the main menu
//
// Exit is delegated via callback because this class has no knowledge of the
// game's teardown. The caller (main.js) supplies a function that does
// whatever "return to main menu" means for this game — clear persistence,
// reload, swap overlays. That keeps the panel pure UI.
//
// onClose fires whenever the panel is dismissed (Close button, backdrop
// click, or programmatic close). The caller uses it to restore whatever
// pause state was active before the menu opened. It does NOT fire on
// Exit-to-Main-Menu's internal close-and-reload — see _handleExit.
//
// The SettingsPanel is normally supplied by the caller as a shared instance
// so the main menu and pause menu open the same dialog. When omitted (e.g.
// for testing), the panel lazily creates and owns its own.
import { SettingsPanel } from './settings/SettingsPanel.js';

export class PauseMenuPanel {
  // @param options.onExitToMainMenu  Required. Called when "Exit to Main
  //                                  Menu" is clicked.
  // @param options.onClose           Optional. Called after the panel is
  //                                  dismissed for any reason other than
  //                                  Exit-to-Main-Menu.
  // @param options.settingsPanel     Optional. Shared SettingsPanel instance.
  constructor(options = {}) {
    this._onExit = options.onExitToMainMenu || null;
    this._onClose = options.onClose || null;
    this._settingsPanel = options.settingsPanel || null;
    this._ownsSettingsPanel = !options.settingsPanel;

    this.el = this._build();
    document.body.appendChild(this.el);
  }

  open() {
    this.el.style.display = 'flex';
  }

  // Dismisses the panel and notifies onClose. No-op if already hidden, so
  // a redundant close (e.g. Close button plus a stray backdrop click)
  // doesn't fire onClose twice.
  close() {
    if (this.el.style.display === 'none') return;
    this.el.style.display = 'none';
    if (this._onClose) this._onClose();
  }

  get isOpen() {
    return this.el.style.display === 'flex';
  }

  dispose() {
    if (this._ownsSettingsPanel && this._settingsPanel) {
      this._settingsPanel.dispose();
    }
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  _build() {
    const root = document.createElement('div');
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0, 0, 0, 0.55)',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '90',
      fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      color: '#e8e8e8'
    });

    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close();
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#1e222a',
      border: '1px solid #384050',
      borderRadius: '8px',
      padding: '16px',
      minWidth: '260px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
    });

    panel.appendChild(this._buildButton('Close', () => this.close()));
    panel.appendChild(this._buildButton('Settings', () => this._openSettings()));
    panel.appendChild(this._buildButton('Exit to Main Menu', () => this._handleExit()));

    root.appendChild(panel);
    return root;
  }

  _buildButton(label, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      background: '#2a2f3a',
      border: '1px solid #384050',
      borderRadius: '6px',
      color: '#e8e8e8',
      padding: '10px 14px',
      fontSize: '14px',
      cursor: 'pointer',
      textAlign: 'left'
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = '#343a48'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#2a2f3a'; });
    btn.addEventListener('click', onClick);
    return btn;
  }

  _openSettings() {
    if (!this._settingsPanel) {
      this._settingsPanel = new SettingsPanel();
    }
    this._settingsPanel.open();
  }

  // Exit closes the panel WITHOUT firing onClose — the callback would
  // restore pause state, which is meaningless when the page is about to
  // reload. Hide directly, then hand off.
  _handleExit() {
    this.el.style.display = 'none';
    if (this._onExit) this._onExit();
  }
}
// ===== HelpPanel.js =====
// Standalone modal showing the per-battle control reference. Opened from
// the "?" button in the top bar (see index.html / main.js). Independent
// of the debug HUD: these hints used to be appended to the HudView text
// block every frame, which meant they were only reachable while a debug
// target was active.
//
// Pure UI. Holds no sim/scene state, takes no constructor arguments.
// Closed by its own button, a backdrop mousedown, or Escape (the Escape
// path is wired in main.js's global capture-phase handler, since this
// panel — like SettingsPanel — does not install its own key listener).
//
// Styled to match PauseMenuPanel / SettingsPanel so it reads as one
// family with the rest of the in-game chrome. z-index 95: above the
// pause menu (90), below the settings dialog (100), above the main
// menu overlay (30) so it opens cleanly from the main menu too.

const HELP_LINES = [
  'Space — pause / unpause. Orders can still be issued while paused.',
  'Left-click — select. Left-drag — box-select. Shift+drag — add to selection.',
  'Right-click / hold on ground — move + set facing (preview shown), release to march.',
  'Right-click enemy unit — attack that unit.',
  'Middle-mouse drag — orbit camera.',
  'Left + right drag — pan camera. WASD — pan (camera-relative). Scroll — zoom.',
  'Right-click army-bar card — unit info.',
  'Double-click army-bar card — centre camera on unit.'
];

export class HelpPanel {
  constructor() {
    this.el = this._build();
    document.body.appendChild(this.el);
  }

  open() {
    this.el.style.display = 'flex';
  }

  close() {
    if (this.el.style.display === 'none') return;
    this.el.style.display = 'none';
  }

  get isOpen() {
    return this.el.style.display === 'flex';
  }

  dispose() {
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  _build() {
    const root = document.createElement('div');
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.55)',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '95',
      fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      color: '#e8e8e8'
    });

    // Backdrop click closes. mousedown (not click) so a drag that starts
    // inside the panel and releases on the backdrop does not close it.
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close();
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#1e222a',
      border: '1px solid #384050',
      borderRadius: '8px',
      padding: '20px 24px',
      minWidth: '380px',
      maxWidth: '540px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
    });

    // Header: title + close button, matching SettingsPanel's title row.
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '14px'
    });

    const title = document.createElement('h2');
    title.textContent = 'Controls';
    Object.assign(title.style, {
      margin: '0',
      fontSize: '18px',
      fontWeight: '600'
    });
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '\u00d7'; // multiplication sign, reads as an X
    closeBtn.title = 'Close (Esc)';
    Object.assign(closeBtn.style, {
      background: 'transparent',
      border: 'none',
      color: '#e8e8e8',
      fontSize: '24px',
      lineHeight: '1',
      cursor: 'pointer',
      padding: '0 4px',
      fontFamily: 'inherit'
    });
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Body: one row per hint. Each line is its own <div> so the em-dash
    // alignment reads consistently and a future per-row icon (mouse,
    // keyboard) can be dropped into a row without touching the others.
    const body = document.createElement('div');
    Object.assign(body.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      fontSize: '13.5px',
      lineHeight: '1.45',
      color: '#cdd6e2'
    });

    for (const line of HELP_LINES) {
      const row = document.createElement('div');
      row.textContent = line;
      body.appendChild(row);
    }

    panel.appendChild(body);
    root.appendChild(panel);
    return root;
  }
}
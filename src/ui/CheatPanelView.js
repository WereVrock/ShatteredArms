// ===== CheatPanelView.js =====
// Modal list of debug cheats. Pure UI: renders what config.getModel()
// returns and reports a click through config.onRun(id), which answers with
// a status message.
//
// config = {
//   getModel() -> { notice, sections: [{ title, items: [
//                     { id, label, description, enabled, note } ] }] },
//   onRun(id) -> string,
//   onClose()
// }

const STYLE_ID = 'cheat-panel-styles';

const STYLE_TEXT = `
  .cheat-root {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 1300;
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    color: #e8e8e8;
  }
  .cheat-panel {
    background: #1e222a;
    border: 1px solid #384050;
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    width: min(620px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }
  .cheat-header {
    display: flex;
    align-items: center;
    padding: 14px 20px;
    border-bottom: 1px solid #2a3544;
    background: linear-gradient(180deg, #262e3b 0%, #1c222c 100%);
    border-radius: 10px 10px 0 0;
  }
  .cheat-title { flex: 1 1 auto; font-size: 20px; font-weight: 700; color: #eef2f8; }
  .cheat-close {
    background: transparent;
    border: none;
    color: #6a7a8e;
    font-size: 30px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    font-family: inherit;
  }
  .cheat-close:hover { color: #eef2f8; }
  .cheat-notice {
    margin: 12px 20px 0;
    padding: 8px 12px;
    font-size: 12px;
    color: #e0b0a0;
    background: rgba(160, 60, 40, 0.18);
    border: 1px solid #7a3a2a;
    border-radius: 5px;
  }
  .cheat-body { padding: 8px 20px 12px; overflow-y: auto; }
  .cheat-section-title {
    font-size: 11px;
    color: #8a9ab0;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    margin: 14px 0 6px;
  }
  .cheat-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    margin-bottom: 6px;
    background: #232a36;
    border: 1px solid #2a3544;
    border-radius: 6px;
  }
  .cheat-row-text { flex: 1 1 auto; min-width: 0; }
  .cheat-row-label { font-size: 13.5px; font-weight: 600; color: #dde5ee; }
  .cheat-row-desc { font-size: 11.5px; color: #7a8a9e; line-height: 1.4; margin-top: 2px; }
  .cheat-row-note { font-size: 11px; color: #d08a6a; margin-top: 2px; }
  .cheat-btn {
    flex: 0 0 auto;
    padding: 6px 16px;
    border-radius: 5px;
    font-family: inherit;
    font-size: 12.5px;
    cursor: pointer;
    border: 1px solid #4a8a5a;
    background: #2e5c3a;
    color: #eef8f0;
  }
  .cheat-btn:hover:not(:disabled) { background: #3a7248; }
  .cheat-btn:disabled { opacity: 0.4; cursor: not-allowed; border-color: #384050; background: #2a2f3a; }
  .cheat-footer {
    padding: 10px 20px 14px;
    border-top: 1px solid #2a3544;
    min-height: 18px;
    font-size: 12px;
    color: #8ad0d0;
  }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class CheatPanelView {
  constructor() {
    ensureStyles();
    this.root = el('div', 'cheat-root');
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    document.body.appendChild(this.root);

    this._config = null;
    this._statusEl = null;
  }

  isOpen() {
    return this.root.style.display === 'flex';
  }

  show(config) {
    this._config = config;
    this._render();
    this.root.style.display = 'flex';
  }

  close() {
    if (!this.isOpen()) return;
    this.root.style.display = 'none';
    const cb = this._config ? this._config.onClose : null;
    this._config = null;
    this._statusEl = null;
    if (cb) cb();
  }

  _render() {
    const cfg = this._config;
    if (!cfg) return;
    const model = cfg.getModel();

    this.root.innerHTML = '';
    const panel = el('div', 'cheat-panel');

    const header = el('div', 'cheat-header');
    header.appendChild(el('div', 'cheat-title', 'Debug cheats'));
    const close = el('button', 'cheat-close', '\u00d7');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    header.appendChild(close);
    panel.appendChild(header);

    if (model.notice) panel.appendChild(el('div', 'cheat-notice', model.notice));

    const body = el('div', 'cheat-body');
    for (const section of model.sections) {
      body.appendChild(el('div', 'cheat-section-title', section.title));
      for (const item of section.items) body.appendChild(this._buildRow(item));
    }
    panel.appendChild(body);

    this._statusEl = el('div', 'cheat-footer', '');
    panel.appendChild(this._statusEl);

    this.root.appendChild(panel);
  }

  _buildRow(item) {
    const row = el('div', 'cheat-row');
    const text = el('div', 'cheat-row-text');
    text.appendChild(el('div', 'cheat-row-label', item.label));
    text.appendChild(el('div', 'cheat-row-desc', item.description));
    if (item.note) text.appendChild(el('div', 'cheat-row-note', item.note));
    row.appendChild(text);

    const btn = el('button', 'cheat-btn', 'Run');
    btn.type = 'button';
    btn.disabled = !item.enabled;
    btn.addEventListener('click', () => {
      if (!this._config) return;
      const message = this._config.onRun(item.id);
      if (this._statusEl) this._statusEl.textContent = message || '';
    });
    row.appendChild(btn);
    return row;
  }
}
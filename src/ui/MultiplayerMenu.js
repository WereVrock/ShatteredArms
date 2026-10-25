// Modal panel: room code + scenario picker + Host / Join buttons.
// Self-contained — builds its own DOM and inline styles. Its three
// callbacks are surfaced to main.js, which owns the actual connection.
//
// The scenario picker only lists PlayableScenarios. Custom battles and
// campaigns are not supported in MP yet.

import { PlayableScenarios } from '../scenarios/PlayableScenarios.js';

export class MultiplayerMenu {
  constructor(options = {}) {
    this.onHost = options.onHost || (() => {});
    this.onJoin = options.onJoin || (() => {});
    this.onClose = options.onClose || (() => {});

    this._root = null;
    this._build();
  }

  open() {
    this._root.classList.remove('hidden');
    if (!this._codeInput.value) this._codeInput.value = randomRoomCode();
    this._codeInput.focus();
  }

  close() {
    this._root.classList.add('hidden');
    this.onClose();
  }

  setStatus(text) {
    this._statusEl.textContent = text || '';
  }

  _build() {
    const root = document.createElement('div');
    root.className = 'mp-menu hidden';

    const scenarioOptions = PlayableScenarios
      .map(s => {
        const label = s.displayName || s.name || s.id;
        return `<option value="${s.id}">${label}</option>`;
      })
      .join('');

    root.innerHTML = `
      <div class="mp-panel">
        <h2 class="mp-title">Multiplayer</h2>
        <div class="mp-row">
          <label class="mp-label">Room</label>
          <input class="mp-input" type="text" maxlength="8" placeholder="ab12cd" />
        </div>
        <div class="mp-row">
          <label class="mp-label">Scenario</label>
          <select class="mp-select">${scenarioOptions}</select>
        </div>
        <div class="mp-buttons">
          <button class="mp-btn mp-host">Host</button>
          <button class="mp-btn mp-join">Join</button>
        </div>
        <div class="mp-status"></div>
        <button class="mp-btn mp-back">Back</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      .mp-menu {
        position: absolute; inset: 0; z-index: 40;
        background: rgba(8, 10, 14, 0.9);
        display: flex; align-items: center; justify-content: center;
        font-family: monospace; color: #eee;
      }
      .mp-menu.hidden { display: none; }
      .mp-panel {
        background: #1e2430; border: 1px solid #3a4a5e; border-radius: 8px;
        padding: 20px 24px; width: 340px; text-align: center;
      }
      .mp-title { margin: 0 0 16px; font-size: 18px; letter-spacing: 1px; }
      .mp-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      .mp-label { font-size: 12px; color: #99a; flex: 0 0 60px; text-align: left; }
      .mp-input, .mp-select {
        flex: 1 1 0; background: #10161e; color: #eee;
        border: 1px solid #3a4a5e; border-radius: 4px;
        padding: 6px 8px; font-family: inherit; font-size: 13px;
      }
      .mp-input { letter-spacing: 2px; text-transform: lowercase; }
      .mp-buttons { display: flex; gap: 8px; margin-bottom: 12px; }
      .mp-btn {
        flex: 1 1 0; padding: 8px 10px; border-radius: 4px;
        border: 1px solid #3a4a5e; background: #26354a; color: #d8e6ff;
        font-family: inherit; font-size: 13px; cursor: pointer;
      }
      .mp-btn:hover { background: #33465e; border-color: #6a8ac0; }
      .mp-host { background: #2c4a2c; border-color: #5a8a4b; }
      .mp-host:hover { background: #3a6a3a; }
      .mp-join { background: #2c3a4a; border-color: #5a7a9a; }
      .mp-join:hover { background: #3a4a6a; }
      .mp-back { background: #2a2a2a; border-color: #555; color: #ccc; margin-top: 4px; }
      .mp-back:hover { background: #3a3a3a; }
      .mp-status { font-size: 12px; color: #99a; min-height: 16px; margin-bottom: 10px; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(root);

    this._root = root;
    this._codeInput = root.querySelector('.mp-input');
    this._scenarioSelect = root.querySelector('.mp-select');
    this._statusEl = root.querySelector('.mp-status');

    root.querySelector('.mp-host').addEventListener('click', () => {
      const code = sanitise(this._codeInput.value);
      if (code.length < 3) { this.setStatus('Enter a room code (3+ chars).'); return; }
      this.onHost(code, this._scenarioSelect.value);
    });
    root.querySelector('.mp-join').addEventListener('click', () => {
      const code = sanitise(this._codeInput.value);
      if (code.length < 3) { this.setStatus('Enter a room code (3+ chars).'); return; }
      this.onJoin(code, this._scenarioSelect.value);
    });
    root.querySelector('.mp-back').addEventListener('click', () => this.close());
  }
}

function sanitise(raw) {
  return (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
}

function randomRoomCode() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
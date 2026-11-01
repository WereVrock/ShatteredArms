// Global high-score board. Opened from the main menu only. Fetches the
// top scores for the current balance version from the Cloudflare worker.

import { HighscoreApi } from '../net/HighscoreApi.js';
import { VERSION } from '../config/Version.js';

const STYLE_ID = 'highscores-view-styles';

const STYLE_TEXT = `
  .hs-panel-extra {
    /* CardPickerView already styles the panel; we only need table bits. */
  }
  .hs-meta {
    font-size: 12px;
    color: #7a8a9e;
    margin: 0 0 12px;
    text-align: center;
  }
  .hs-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    color: #dde5ee;
  }
  .hs-table th {
    text-align: left;
    font-size: 10px;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: #8a9ab0;
    padding: 6px 8px;
    border-bottom: 1px solid #2a3544;
  }
  .hs-table td {
    padding: 8px;
    border-bottom: 1px solid #1e2836;
    vertical-align: middle;
  }
  .hs-table tr:last-child td { border-bottom: none; }
  .hs-rank {
    width: 28px;
    color: #8a9ab0;
    font-variant-numeric: tabular-nums;
  }
  .hs-score {
    font-weight: 700;
    color: #e0c060;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .hs-name { color: #eef2f8; }
  .hs-commander { color: #a0b0c4; font-size: 12px; }
  .hs-diff {
    font-size: 11px;
    color: #8a9ab0;
    text-transform: capitalize;
  }
  .hs-empty, .hs-loading, .hs-error {
    text-align: center;
    color: #6a7a8e;
    font-style: italic;
    padding: 24px 8px;
    font-size: 13px;
  }
  .hs-error { color: #d08a6a; font-style: normal; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

function formatScore(n) {
  return Math.round(n).toLocaleString();
}

export class HighScoresView {
  constructor(rootElement) {
    ensureStyles();
    this.root = rootElement;
    this._onBack = null;
  }

  show({ onBack } = {}) {
    this._onBack = onBack || null;
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');

    const panel = document.createElement('div');
    panel.className = 'menu-panel';

    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = 'High Scores';
    panel.appendChild(title);

    const meta = document.createElement('p');
    meta.className = 'hs-meta';
    const bv = HighscoreApi.balanceVersion();
    meta.textContent =
      `Balance v${bv} · ${(VERSION.name || '').trim()} v${VERSION.number} · Top 10`;
    panel.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'hs-loading';
    body.textContent = 'Loading…';
    panel.appendChild(body);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'menu-card menu-back';
    back.textContent = '← Back';
    back.addEventListener('click', () => {
      if (this._onBack) this._onBack();
    });
    panel.appendChild(back);

    this.root.appendChild(panel);

    HighscoreApi.fetchTop({ limit: 10 }).then((result) => {
      body.className = '';
      body.innerHTML = '';
      if (result.error && (!result.scores || result.scores.length === 0)) {
        const err = document.createElement('div');
        err.className = 'hs-error';
        err.textContent = 'Could not reach the score board. Try again later.';
        body.appendChild(err);
        return;
      }
      if (!result.scores || result.scores.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'hs-empty';
        empty.textContent = 'No scores recorded yet for this balance version.';
        body.appendChild(empty);
        return;
      }
      body.appendChild(this._buildTable(result.scores));
    });
  }

  _buildTable(scores) {
    const table = document.createElement('table');
    table.className = 'hs-table';
    const thead = document.createElement('thead');
    thead.innerHTML =
      '<tr><th>#</th><th>Player</th><th>Commander</th><th>Difficulty</th><th>Score</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    scores.forEach((s, i) => {
      const tr = document.createElement('tr');
      const rank = document.createElement('td');
      rank.className = 'hs-rank';
      rank.textContent = String(i + 1);
      tr.appendChild(rank);

      const name = document.createElement('td');
      name.className = 'hs-name';
      name.textContent = s.playerName || 'Unknown';
      tr.appendChild(name);

      const cmd = document.createElement('td');
      cmd.className = 'hs-commander';
      cmd.textContent = s.commander || 'None';
      tr.appendChild(cmd);

      const diff = document.createElement('td');
      diff.className = 'hs-diff';
      diff.textContent = s.difficulty || 'normal';
      tr.appendChild(diff);

      const score = document.createElement('td');
      score.className = 'hs-score';
      score.textContent = formatScore(s.score || 0);
      tr.appendChild(score);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  hide() {
    this.root.classList.add('hidden');
  }
}
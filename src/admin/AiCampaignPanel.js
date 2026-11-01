import { AutoCampaignBatch, EXTREME_PLAYER_NAMES } from '../campaign/AutoCampaignBatch.js';
import { AUTO_PLAYER_PROFILES } from '../campaign/AutoPlayerProfiles.js';
import { runWithKeepAlive } from '../campaign/BackgroundRun.js';
import { LivePowerView } from './LivePowerView.js';

// Admin "AI Campaign" menu. UI only: it reads settings, starts
// AutoCampaignBatch, shows progress and results, and posts averages to the
// board through the admin API supplied by admin.html (api.call).
//
// The two derived rows "iskelet ibo" (lowest single-run score of the
// weakened AI) and "J Cezar" (highest single-run score of the
// best-possible AI) are not run as separate profiles. Their checkboxes
// live right under the run checkboxes and only control whether the
// derived row is written to the board — by auto-submit or by the
// "Write to board" button.

const STYLE_ID = 'ai-campaign-panel-styles';

const STYLE_TEXT = `
  .aic { display: flex; flex-direction: column; gap: 14px; }
  .aic-title { font-size: 16px; font-weight: 700; margin: 0; }
  .aic-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 16px;
  }
  .aic-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #a0b0c4; }
  .aic-field input, .aic-field select {
    padding: 7px 9px;
    border-radius: 5px;
    border: 1px solid #384050;
    background: #10151d;
    color: #eef2f8;
    font-family: inherit;
    font-size: 14px;
  }
  .aic-players { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .aic-check { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .aic-note {
    font-size: 11px;
    color: #8a9ab0;
    padding: 2px 0 0;
    line-height: 1.4;
  }
  .aic-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .aic-status { font-size: 12px; color: #8fd08f; min-height: 16px; }
  .aic-status.error { color: #d08a6a; }
  .aic-log {
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid #2a3544;
    border-radius: 6px;
    padding: 6px 8px;
    font-family: monospace;
    font-size: 12px;
    color: #a0b0c4;
    white-space: pre-wrap;
  }
  .aic-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .aic-table th {
    text-align: left; font-size: 10px; letter-spacing: 1.2px;
    text-transform: uppercase; color: #8a9ab0;
    padding: 6px 8px; border-bottom: 1px solid #2a3544;
  }
  .aic-table td { padding: 8px; border-bottom: 1px solid #1e2836; }
  .aic-num { text-align: right; font-variant-numeric: tabular-nums; color: #e0c060; font-weight: 700; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class AiCampaignPanel {
  constructor(rootElement, api) {
    ensureStyles();
    this.root = rootElement;
    this.api = api;
    this.abortSignal = { aborted: false };
    this.running = false;
    this.lastResults = null;
    this.lastDifficulty = 'normal';
    this.playerChecks = new Map();
    // { weakenedLow: cb, bestPossibleHigh: cb } — ticked by the user to
    // include the derived rows in submissions. They are not run.
    this.derivedChecks = {};
    this._build();
  }

  stop() {
    this.abortSignal.aborted = true;
  }

  _build() {
    this.root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'aic';

    const title = document.createElement('h2');
    title.className = 'aic-title';
    title.textContent = 'AI Campaign';
    wrap.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'aic-grid';
    this.runsInput = this._numberField(grid, 'Runs per player', 10, 1, 100);
    this.difficultySelect = this._selectField(grid, 'Difficulty', ['easy', 'normal', 'hard'], 'normal');
    this.maxBattlesInput = this._numberField(grid, 'Max battles per run (safety cap)', 40, 1, 200);
    this.maxTicksInput = this._numberField(grid, 'Max ticks per battle (safety cap)', 9000, 500, 100000);
    wrap.appendChild(grid);

    // The profiles that are actually run.
    const players = document.createElement('div');
    players.className = 'aic-players';
    for (const p of AUTO_PLAYER_PROFILES) {
      const label = document.createElement('label');
      label.className = 'aic-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      this.playerChecks.set(p.id, cb);
      label.appendChild(cb);
      const txt = document.createElement('span');
      txt.textContent = p.playerName;
      label.appendChild(txt);
      players.appendChild(label);
    }
    wrap.appendChild(players);

    // Note explaining the two derived rows, then their checkboxes right
    // under the run checkboxes. They are not run; they only opt the
    // derived row into board submissions.
    const derivedNote = document.createElement('div');
    derivedNote.className = 'aic-note';
    derivedNote.textContent =
      'Derived rows — not run separately. iskelet ibo = lowest single-run ' +
      'score of the weakened AI. J Cezar = highest single-run score of the ' +
      'best-possible AI. Tick to include when writing to the board.';
    wrap.appendChild(derivedNote);

    const derived = document.createElement('div');
    derived.className = 'aic-players';
    const derivedDefs = [
      ['weakenedLow', EXTREME_PLAYER_NAMES.weakenedLow],
      ['bestPossibleHigh', EXTREME_PLAYER_NAMES.bestPossibleHigh]
    ];
    for (const [key, labelText] of derivedDefs) {
      const label = document.createElement('label');
      label.className = 'aic-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = false;
      this.derivedChecks[key] = cb;
      label.appendChild(cb);
      const txt = document.createElement('span');
      txt.textContent = labelText;
      label.appendChild(txt);
      derived.appendChild(label);
    }
    wrap.appendChild(derived);

    const autoLabel = document.createElement('label');
    autoLabel.className = 'aic-check';
    this.autoSubmitCheck = document.createElement('input');
    this.autoSubmitCheck.type = 'checkbox';
    this.autoSubmitCheck.checked = true;
    autoLabel.appendChild(this.autoSubmitCheck);
    const autoTxt = document.createElement('span');
    autoTxt.textContent = 'Write to the high score board when finished (includes any ticked derived rows)';
    autoLabel.appendChild(autoTxt);
    wrap.appendChild(autoLabel);

    const actions = document.createElement('div');
    actions.className = 'aic-actions';
    this.runBtn = this._button(actions, 'Run', 'primary', () => this._run());
    this.stopBtn = this._button(actions, 'Stop', '', () => this.stop());
    this.writeBtn = this._button(actions, 'Write to board', '', () => this._submit(this.lastResults));
    this.stopBtn.disabled = true;
    this.writeBtn.disabled = true;
    wrap.appendChild(actions);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'aic-status';
    wrap.appendChild(this.statusEl);

    this.live = new LivePowerView(wrap);

    this.resultsEl = document.createElement('div');
    wrap.appendChild(this.resultsEl);

    this.logEl = document.createElement('div');
    this.logEl.className = 'aic-log';
    wrap.appendChild(this.logEl);

    this.root.appendChild(wrap);
  }

  _numberField(parent, labelText, value, min, max) {
    const label = document.createElement('label');
    label.className = 'aic-field';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    label.appendChild(input);
    parent.appendChild(label);
    return input;
  }

  _selectField(parent, labelText, options, selected) {
    const label = document.createElement('label');
    label.className = 'aic-field';
    label.textContent = labelText;
    const select = document.createElement('select');
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (opt === selected) o.selected = true;
      select.appendChild(o);
    }
    label.appendChild(select);
    parent.appendChild(label);
    return select;
  }

  _button(parent, text, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (className) b.className = className;
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }

  _readSettings() {
    return {
      profiles: AUTO_PLAYER_PROFILES.filter(p => this.playerChecks.get(p.id).checked),
      runs: clampInt(this.runsInput.value, 1, 100, 10),
      difficulty: this.difficultySelect.value,
      maxBattles: clampInt(this.maxBattlesInput.value, 1, 200, 40),
      maxTicks: clampInt(this.maxTicksInput.value, 500, 100000, 9000)
    };
  }

  _setStatus(text, isError) {
    this.statusEl.textContent = text || '';
    this.statusEl.className = 'aic-status' + (isError ? ' error' : '');
  }

  _log(line) {
    this.logEl.textContent += line + '\n';
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  _setRunning(running) {
    this.running = running;
    this.runBtn.disabled = running;
    this.stopBtn.disabled = !running;
    if (running) this.writeBtn.disabled = true;
  }

  async _run() {
    if (this.running) return;
    const settings = this._readSettings();
    if (settings.profiles.length === 0) {
      this._setStatus('Select at least one player.', true);
      return;
    }

    this.abortSignal = { aborted: false };
    this.lastDifficulty = settings.difficulty;
    this.logEl.textContent = '';
    this.resultsEl.innerHTML = '';
    this._setRunning(true);
    this._setStatus('Running…');

    let results = [];
    try {
      results = await runWithKeepAlive(() => AutoCampaignBatch.run({
        ...settings,
        abortSignal: this.abortSignal,
        onBattle: (info) => {
          this._setStatus(
            `${info.profile.playerName} — run ${info.runIndex + 1}/${info.runs}, ` +
            `battle ${info.battleIndex + 1}, tick ${info.ticks}`
          );
          this.live.update(info.power);
        },
        onRunComplete: (info) => {
          this._log(
            `${info.profile.playerName} run ${info.runIndex + 1}/${info.runs}: ` +
            `score ${info.outcome.score.toLocaleString()}, ` +
            `${info.outcome.battles} battles, ${info.outcome.wins} wins` +
            (info.outcome.timedOut ? `, ${info.outcome.timedOut} settled at tick limit` : '')
          );
        }
      }));
    } catch (e) {
      this._setStatus('Failed: ' + (e && e.message ? e.message : e), true);
    }

    this.lastResults = results;
    this._renderResults(results);
    this.live.hide();
    this._setRunning(false);

    const anyRuns = results.some(r => r.completedRuns > 0);
    this.writeBtn.disabled = !anyRuns;

    if (this.abortSignal.aborted) {
      this._setStatus('Stopped. Partial results are shown; nothing was written automatically.');
      return;
    }
    if (anyRuns && this.autoSubmitCheck.checked) {
      await this._submit(results);
    } else {
      this._setStatus('Finished.');
    }
  }

  _renderResults(results) {
    this.resultsEl.innerHTML = '';
    if (!results || results.length === 0) return;

    const table = document.createElement('table');
    table.className = 'aic-table';
    table.innerHTML =
      '<thead><tr><th>Player</th><th>Runs</th><th>Battles</th><th>Score</th></tr></thead>';
    const tbody = document.createElement('tbody');

    for (const r of results) {
      this._appendRow(tbody, [
        r.profile.playerName,
        String(r.completedRuns),
        r.avgBattles.toFixed(1),
        Math.round(r.avgScore).toLocaleString()
      ]);
    }

    const extremes = AutoCampaignBatch.buildExtremeEntries(results, this.lastDifficulty);
    for (const entry of extremes) {
      this._appendRow(tbody, [
        entry.playerName,
        '\u2014',
        String(entry.battles),
        entry.score.toLocaleString()
      ]);
    }

    table.appendChild(tbody);
    this.resultsEl.appendChild(table);
  }

  _appendRow(tbody, cells) {
    const tr = document.createElement('tr');
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === cells.length - 1) td.className = 'aic-num';
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  async _submit(results) {
    if (!results || this.running) return;
    const usable = results.filter(r => r.completedRuns > 0);
    if (usable.length === 0) return;

    const entries = usable.map(r => AutoCampaignBatch.buildScoreEntry(r, this.lastDifficulty));

    // Derived rows are included only when their checkbox (in the players
    // section) is ticked. Auto-submit calls this same method, so a ticked
    // derived row is picked up by the automatic path as well.
    const derived = AutoCampaignBatch.buildExtremeEntries(usable, this.lastDifficulty);
    for (const entry of derived) {
      const key = entry.playerName === EXTREME_PLAYER_NAMES.weakenedLow
        ? 'weakenedLow'
        : 'bestPossibleHigh';
      const cb = this.derivedChecks[key];
      if (cb && cb.checked) entries.push(entry);
    }

    if (entries.length === 0) return;

    this._setStatus('Writing to board…');
    try {
      for (const entry of entries) {
        await this.api.call({ action: 'upsert', entry });
        this._log(`Board updated: ${entry.playerName} = ${entry.score.toLocaleString()} (balance v${entry.balanceVersion})`);
      }
      this._setStatus(`Board updated (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}).`);
    } catch (e) {
      this._setStatus('Board write failed: ' + (e && e.message ? e.message : e), true);
    }
  }
}
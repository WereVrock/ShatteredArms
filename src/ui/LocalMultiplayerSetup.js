// Setup panel for a same-device (local) multiplayer battle.
//
// Two force sources (Scenario or Custom Battle) and two game modes
// (Free Pause or Turn-Based). Turn-Based additionally exposes the
// interval length.
//
// Pure UI: builds a config object and calls onStart(). Never touches the
// sim, the scenario builder, or persistence.
//
// The Custom Battle path hands off to a CustomBattleSetup instance owned
// by main.js. When that instance fires onStart (with rosters), main.js
// calls back into setCustomRosters() here and reopens this panel.

import { PlayableScenarios } from '../scenarios/PlayableScenarios.js';
import { LM_MODE } from '../session/LocalMultiplayerController.js';

const INTERVAL_OPTIONS = [
  { value: 5,  label: '5 seconds' },
  { value: 10, label: '10 seconds' },
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 45, label: '45 seconds' },
  { value: 60, label: '1 minute' }
];

const STYLE_ID = 'local-mp-setup-styles';
const STYLE_TEXT = `
  .lm-tabs { display:flex; gap:6px; margin:12px 0 8px; justify-content:center; }
  .lm-tab {
    padding:6px 16px; border-radius:4px; cursor:pointer;
    border:1px solid #3a4a5e; background:#1e2430; color:#aab;
    font-family:inherit; font-size:12px; letter-spacing:0.6px;
  }
  .lm-tab.active { background:#26354a; border-color:#6a8ac0; color:#e6eef8; }
  .lm-section { margin:14px 0; }
  .lm-section-title {
    font-size:11px; color:#8a9ab0; letter-spacing:1.6px;
    text-transform:uppercase; margin-bottom:10px;
  }
  .lm-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .lm-label { font-size:12px; color:#99a; flex:0 0 130px; text-align:left; }
  .lm-select {
    flex:1 1 0; background:#10161e; color:#eee;
    border:1px solid #3a4a5e; border-radius:4px;
    padding:6px 8px; font-family:inherit; font-size:13px;
  }
  .lm-mode-row {
    display:flex; align-items:flex-start; gap:10px;
    padding:10px 12px; margin-bottom:6px;
    border:1px solid #2a3544; border-radius:5px;
    cursor:pointer; user-select:none;
    background:#181e28;
  }
  .lm-mode-row.active { border-color:#6a8ac0; background:#1e2836; }
  .lm-mode-row input { margin-top:3px; cursor:pointer; }
  .lm-mode-name { font-size:14px; color:#e6eef8; font-weight:600; }
  .lm-mode-desc { font-size:11px; color:#889; margin-top:2px; }
  .lm-actions { display:flex; flex-direction:column; gap:6px; margin-top:14px; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

export class LocalMultiplayerSetup {
  constructor(rootElement, { onStart, onBack, onOpenCustomBattle }) {
    ensureStyles();
    this.root = rootElement;
    this.onStart = onStart || (() => {});
    this.onBack = onBack || (() => {});
    this.onOpenCustomBattle = onOpenCustomBattle || (() => {});

    this.forceSource = 'scenario';   // 'scenario' | 'custom'
    this.scenarioId = PlayableScenarios[0]?.id || null;
    this.customRosters = null;       // { blueRoster, redRoster, playerTeamId } | null
    this.gameMode = LM_MODE.FREE;
    this.intervalSeconds = 30;
  }

  show() {
    this._render();
  }

  hide() {
    this.root.classList.add('hidden');
  }

  // Called by main.js when the sub CustomBattleSetup fires onStart.
  setCustomRosters(blueRoster, redRoster, playerTeamId) {
    this.customRosters = { blueRoster, redRoster, playerTeamId };
    this.forceSource = 'custom';
    this.show();
  }

  // --- rendering ------------------------------------------------------------

  _render() {
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');

    const panel = document.createElement('div');
    panel.className = 'menu-panel';

    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = 'Same-Device Battle';
    panel.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'menu-subtitle';
    sub.textContent = 'Two players on one machine. Choose the forces and the game mode.';
    panel.appendChild(sub);

    panel.appendChild(this._buildForceTabs());
    panel.appendChild(this._buildForceSection());
    panel.appendChild(this._buildModeSection());
    if (this.gameMode === LM_MODE.TURN_BASED) {
      panel.appendChild(this._buildIntervalSection());
    }
    panel.appendChild(this._buildActions());

    this.root.appendChild(panel);
  }

  _buildForceTabs() {
    const tabs = document.createElement('div');
    tabs.className = 'lm-tabs';
    for (const [id, label] of [['scenario', 'Scenario'], ['custom', 'Custom Battle']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lm-tab' + (this.forceSource === id ? ' active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.forceSource = id;
        this._render();
      });
      tabs.appendChild(btn);
    }
    return tabs;
  }

  _buildForceSection() {
    const wrap = document.createElement('div');
    wrap.className = 'lm-section';

    if (this.forceSource === 'scenario') {
      const row = document.createElement('div');
      row.className = 'lm-row';

      const label = document.createElement('span');
      label.className = 'lm-label';
      label.textContent = 'Scenario';
      row.appendChild(label);

      const select = document.createElement('select');
      select.className = 'lm-select';
      for (const s of PlayableScenarios) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.displayName || s.name || s.id;
        select.appendChild(opt);
      }
      select.value = this.scenarioId || '';
      select.addEventListener('change', () => { this.scenarioId = select.value; });
      row.appendChild(select);

      wrap.appendChild(row);
    } else {
      const summary = document.createElement('div');
      summary.style.cssText = 'font-size:12px;color:#aab;margin-bottom:10px;text-align:center;';
      if (this.customRosters) {
        summary.textContent = `Blue: ${this.customRosters.blueRoster.length} unit(s) · `
          + `Red: ${this.customRosters.redRoster.length} unit(s)`;
      } else {
        summary.textContent = 'No custom forces configured yet.';
        summary.style.color = '#889';
      }
      wrap.appendChild(summary);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'menu-card menu-confirm';
      editBtn.textContent = this.customRosters
        ? 'Edit Custom Forces'
        : 'Configure Custom Forces';
      editBtn.addEventListener('click', () => this.onOpenCustomBattle());
      wrap.appendChild(editBtn);
    }

    return wrap;
  }

  _buildModeSection() {
    const wrap = document.createElement('div');
    wrap.className = 'lm-section';

    const title = document.createElement('div');
    title.className = 'lm-section-title';
    title.textContent = 'Game Mode';
    wrap.appendChild(title);

    const modes = [
      {
        value: LM_MODE.FREE,
        label: 'Free Pause',
        desc: 'Both players issue orders at any time. Red army bar shown at the top of the screen.'
      },
      {
        value: LM_MODE.TURN_BASED,
        label: 'Turn-Based',
        desc: 'Players alternate. Sim runs unpaused between turns; a coin toss decides who goes first each cycle.'
      }
    ];

    for (const m of modes) {
      const row = document.createElement('label');
      row.className = 'lm-mode-row' + (this.gameMode === m.value ? ' active' : '');

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'lm-mode';
      radio.value = m.value;
      radio.checked = this.gameMode === m.value;
      radio.addEventListener('change', () => {
        this.gameMode = m.value;
        this._render();
      });
      row.appendChild(radio);

      const text = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'lm-mode-name';
      name.textContent = m.label;
      const desc = document.createElement('div');
      desc.className = 'lm-mode-desc';
      desc.textContent = m.desc;
      text.appendChild(name);
      text.appendChild(desc);
      row.appendChild(text);

      wrap.appendChild(row);
    }

    return wrap;
  }

  _buildIntervalSection() {
    const wrap = document.createElement('div');
    wrap.className = 'lm-section';

    const title = document.createElement('div');
    title.className = 'lm-section-title';
    title.textContent = 'Turn Interval';
    wrap.appendChild(title);

    const row = document.createElement('div');
    row.className = 'lm-row';

    const label = document.createElement('span');
    label.className = 'lm-label';
    label.textContent = 'Watch duration';
    row.appendChild(label);

    const select = document.createElement('select');
    select.className = 'lm-select';
    for (const opt of INTERVAL_OPTIONS) {
      const el = document.createElement('option');
      el.value = String(opt.value);
      el.textContent = opt.label;
      select.appendChild(el);
    }
    select.value = String(this.intervalSeconds);
    select.addEventListener('change', () => {
      this.intervalSeconds = parseInt(select.value, 10);
    });
    row.appendChild(select);
    wrap.appendChild(row);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:#889;margin-top:4px;';
    hint.textContent = 'The battle runs unpaused for this long between turn cycles. Nobody can give orders while it runs.';
    wrap.appendChild(hint);

    return wrap;
  }

  _buildActions() {
    const actions = document.createElement('div');
    actions.className = 'lm-actions';

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'menu-card menu-confirm';
    startBtn.textContent = 'Start Battle';
    startBtn.disabled = this.forceSource === 'custom' && !this.customRosters;
    startBtn.addEventListener('click', () => {
      if (startBtn.disabled) return;
      this.onStart(this._buildConfig());
    });
    actions.appendChild(startBtn);

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'menu-card menu-back';
    backBtn.textContent = '← Back';
    backBtn.addEventListener('click', () => this.onBack());
    actions.appendChild(backBtn);

    return actions;
  }

  _buildConfig() {
    const base = {
      mode: this.gameMode,
      intervalSeconds: this.intervalSeconds
    };
    if (this.forceSource === 'scenario') {
      return Object.assign({}, base, { scenarioId: this.scenarioId });
    }
    return Object.assign({}, base, { customRosters: this.customRosters });
  }
}
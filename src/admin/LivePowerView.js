// Live "player vs enemy power" readout for the admin AI campaign panel.
// UI only: it is handed a { blue, red } power object and draws it.

const STYLE_ID = 'live-power-view-styles';

const STYLE_TEXT = `
  .lpv { display: none; flex-direction: column; gap: 4px; }
  .lpv-row {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .lpv-blue { color: #6a9ac9; }
  .lpv-red { color: #c96a6a; }
  .lpv-bar {
    height: 8px;
    border-radius: 4px;
    background: #8a3a3a;
    overflow: hidden;
  }
  .lpv-fill {
    height: 100%;
    width: 50%;
    background: #3d6b99;
    transition: width 0.15s linear;
  }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

function format(n) {
  return Math.round(n || 0).toLocaleString();
}

export class LivePowerView {
  constructor(parent) {
    ensureStyles();

    this.el = document.createElement('div');
    this.el.className = 'lpv';

    const row = document.createElement('div');
    row.className = 'lpv-row';
    this.blueEl = document.createElement('span');
    this.blueEl.className = 'lpv-blue';
    this.redEl = document.createElement('span');
    this.redEl.className = 'lpv-red';
    row.appendChild(this.blueEl);
    row.appendChild(this.redEl);

    const bar = document.createElement('div');
    bar.className = 'lpv-bar';
    this.fillEl = document.createElement('div');
    this.fillEl.className = 'lpv-fill';
    bar.appendChild(this.fillEl);

    this.el.appendChild(row);
    this.el.appendChild(bar);
    parent.appendChild(this.el);
  }

  update(power) {
    if (!power) return;
    this.el.style.display = 'flex';
    this.blueEl.textContent = 'Player ' + format(power.blue);
    this.redEl.textContent = 'Enemy ' + format(power.red);
    const total = (power.blue || 0) + (power.red || 0);
    const frac = total > 0 ? power.blue / total : 0.5;
    this.fillEl.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
  }

  hide() {
    this.el.style.display = 'none';
  }
}
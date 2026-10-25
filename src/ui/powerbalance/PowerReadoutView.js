// Small text panel shown under the gauges when the player clicks the
// widget: per team, soldiers and power as "current / start", plus the
// current power ratio (blue : red).
//
// Pure presentation. The owner passes PowerTracker's `current` and
// `start` objects to update(); text is only written to the DOM when it
// actually changes, so calling update() every frame is cheap.
import {
  LEFT_TEAM, RIGHT_TEAM, TEAM_TEXT_COLOR, BRASS_DARK
} from './PowerWidgetTheme.js';

const MUTED = '#a89870';

function pairText(now, start) {
  const nowText = String(Math.round(now));
  const startText = (start === null || start === undefined)
    ? '-'
    : String(Math.round(start));
  return nowText + ' / ' + startText;
}

// Blue-to-red power ratio, normalised so red = 1.
function ratioText(bluePower, redPower) {
  if (bluePower <= 0 && redPower <= 0) return '-';
  if (redPower <= 0) return 'blue only';
  if (bluePower <= 0) return 'red only';
  return (bluePower / redPower).toFixed(2) + ' : 1';
}

export class PowerReadoutView {
  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'display:none',
      // Wider than the 104px widget: right-aligned, so it grows leftward
      // and stays inside the screen edge.
      'align-self:flex-end',
      'width:max-content',
      'box-sizing:border-box',
      'grid-template-columns:auto auto auto',
      'column-gap:10px',
      'row-gap:1px',
      'padding:5px 8px',
      'background:rgba(28,24,16,0.85)',
      'border:1px solid ' + BRASS_DARK,
      'border-radius:4px',
      'box-shadow:0 2px 6px rgba(0,0,0,0.5)',
      'color:#e6dcc0',
      'font-family:system-ui, -apple-system, Segoe UI, sans-serif',
      'font-size:11px',
      'line-height:1.4',
      'white-space:nowrap',
      'cursor:default'
    ].join(';');

    // Header row.
    this._cell('Current / Start', MUTED, 'left');
    this._cell('Blue', TEAM_TEXT_COLOR[LEFT_TEAM], 'right').style.fontWeight = '600';
    this._cell('Red', TEAM_TEXT_COLOR[RIGHT_TEAM], 'right').style.fontWeight = '600';

    // Soldiers row.
    this._cell('Soldiers', MUTED, 'left');
    this._blueSoldiers = this._cell('', null, 'right');
    this._redSoldiers  = this._cell('', null, 'right');

    // Power row.
    this._cell('Power', MUTED, 'left');
    this._bluePower = this._cell('', null, 'right');
    this._redPower  = this._cell('', null, 'right');

    // Ratio row: label, then one value spanning both team columns.
    this._cell('Ratio', MUTED, 'left');
    this._ratio = this._cell('', null, 'center');
    this._ratio.style.gridColumn = 'span 2';
  }

  setVisible(visible) {
    this.el.style.display = visible ? 'grid' : 'none';
  }

  // current / start are PowerTracker's objects; start may be null before
  // the baseline exists.
  update(current, start) {
    const b = current[LEFT_TEAM];
    const r = current[RIGHT_TEAM];
    const bs = start ? start[LEFT_TEAM] : null;
    const rs = start ? start[RIGHT_TEAM] : null;

    this._set(this._blueSoldiers, pairText(b.soldiers, bs ? bs.soldiers : null));
    this._set(this._redSoldiers,  pairText(r.soldiers, rs ? rs.soldiers : null));
    this._set(this._bluePower,    pairText(b.power, bs ? bs.power : null));
    this._set(this._redPower,     pairText(r.power, rs ? rs.power : null));
    this._set(this._ratio, ratioText(b.power, r.power));
  }

  _cell(text, color, align) {
    const cell = document.createElement('div');
    cell.textContent = text;
    cell._text = text;
    cell.style.textAlign = align;
    if (color) cell.style.color = color;
    this.el.appendChild(cell);
    return cell;
  }

  _set(cell, text) {
    if (cell._text === text) return;
    cell._text = text;
    cell.textContent = text;
  }
}
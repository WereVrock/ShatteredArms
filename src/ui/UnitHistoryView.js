// ===== UnitHistoryView.js =====
// Renders a UnitHistoryTracker's events as a scrollable list, newest first,
// with a Copy button and per-category filter chips. Pure UI: reads only what
// the tracker exposes, holds no sim references between frames.
//
// Layout:
//   [Change History]          [Copy] [Filters]
//   [category chips ...]      <- only when Filters is toggled on
//   [event list]
//
// Copy exports the CURRENTLY-FILTERED events, all of them — not only the
// 150 rows visible in the DOM. Filtering by "Morale" + "Damage" and then
// clicking Copy gives you exactly those events for the whole battle so
// far, newest-first, in the same plain-text layout as the display.
//
// Filter chips are per-category. Categories match UnitHistoryTracker's
// `category` field on each event; see CATEGORIES below. All are enabled
// by default; user can toggle individual ones or hit All / None.
//
// DOM diff strategy: the view builds a signature from the tracker's newest
// event seq and the current filter selection. When both are unchanged,
// nothing is rebuilt — the DOM, scroll position, and text selection all
// survive across frames. When either changes, the list rebuilds once.
import { copyToClipboard } from './clipboard.js';

// Maximum number of rows to render in the DOM at once. The tracker caps
// total events at 400; trimming the DISPLAYED list keeps layout bounded.
// The Copy button is NOT capped — it exports the whole filtered log.
const MAX_VISIBLE_ROWS = 150;

// Category ids must match the `category` field pushed by
// UnitHistoryTracker. `label` is what appears on the chip.
const CATEGORIES = [
  { id: 'unit',       label: 'Unit' },
  { id: 'morale',     label: 'Morale' },
  { id: 'damage',     label: 'Damage' },
  { id: 'casualties', label: 'Deaths' },
  { id: 'rout',       label: 'Routs' },
  { id: 'stamina',    label: 'Stamina' },
  { id: 'kills',      label: 'Kills' },
  { id: 'melee',      label: 'Melee' },
  { id: 'meta',       label: 'Meta' }
];

// Chip / button palettes. Kept as small objects so the "on" and "off"
// variants stay side-by-side in one place.
const CHIP_ON  = { bg: 'rgba(80,130,170,0.35)', border: '#6a8ac0', text: '#e6eef8' };
const CHIP_OFF = { bg: 'rgba(255,255,255,0.04)', border: '#444',   text: '#777' };
const BTN_REST = { bg: 'rgba(255,255,255,0.08)', border: '#555',   text: '#ddd' };
const BTN_ACTIVE = { bg: 'rgba(80,130,170,0.30)', border: '#6a8ac0', text: '#e6eef8' };

export class UnitHistoryView {
  constructor() {
    this._lastSignature = null;
    this._enabled = new Set(CATEGORIES.map(c => c.id));
    this._filtersVisible = false;
    this._visible = false;
    this._currentTracker = null;
    this._lastFiltered = [];
    this._chipEls = new Map();

    this.el = this._build();
  }

  // Called every frame from HudView. `tracker` may be null (unit dead or
  // not yet tracked); `visible` gates the whole section.
  render(tracker, visible) {
    this.el.style.display = visible ? 'block' : 'none';
    this._visible = visible;

    if (!visible) {
      this._currentTracker = null;
      return;
    }
    this._currentTracker = tracker;
    if (!tracker) return;

    const events = tracker.getEvents();
    const newestSeq = events.length ? events[events.length - 1].seq : -1;
    const filterSig = Array.from(this._enabled).sort().join(',');
    const sig = `${newestSeq}|${filterSig}`;
    if (sig === this._lastSignature) return;
    this._lastSignature = sig;

    const filtered = events.filter(ev => this._enabled.has(ev.category));
    this._rebuild(filtered);
  }

  // --- internals ---------------------------------------------------------

  _build() {
    const root = document.createElement('div');
    root.style.cssText = 'margin-top:10px;display:none;';

    // --- Header row ---
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:6px',
      'margin:0 0 4px 0'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Change History';
    title.title = 'Every change to this unit\'s tracked fields, newest first.';
    title.style.cssText = [
      'flex:1 1 auto',
      'font:bold 11px monospace',
      'color:#9ab',
      'letter-spacing:1.2px',
      'user-select:none'
    ].join(';');
    header.appendChild(title);

    this._copyBtn = this._buildButton(
      'Copy',
      'Copy ALL filtered events (not just the visible rows) to the clipboard.',
      () => this._copyHistory()
    );
    header.appendChild(this._copyBtn);

    this._filterBtn = this._buildButton(
      'Filters',
      'Show / hide category filters',
      () => this._toggleFilters()
    );
    header.appendChild(this._filterBtn);

    root.appendChild(header);

    // --- Filter row (hidden by default) ---
    this._filterRow = document.createElement('div');
    this._filterRow.style.cssText = [
      'display:none',
      'flex-wrap:wrap',
      'gap:4px',
      'margin:0 0 6px 0',
      'padding:6px 8px',
      'background:rgba(0,0,0,0.22)',
      'border-radius:3px'
    ].join(';');

    // All / None quick actions.
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.textContent = 'All';
    allBtn.title = 'Enable every category';
    allBtn.style.cssText = this._chipCss(false);
    allBtn.addEventListener('click', () => this._setAllCategories(true));
    this._filterRow.appendChild(allBtn);

    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.textContent = 'None';
    noneBtn.title = 'Disable every category';
    noneBtn.style.cssText = this._chipCss(false);
    noneBtn.addEventListener('click', () => this._setAllCategories(false));
    this._filterRow.appendChild(noneBtn);

    // Separator between quick actions and per-category chips.
    const sep = document.createElement('span');
    sep.style.cssText =
      'width:1px;height:14px;background:#444;margin:0 3px;align-self:center;';
    this._filterRow.appendChild(sep);

    for (const cat of CATEGORIES) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = cat.label;
      chip.title = `Toggle ${cat.label} events`;
      chip.style.cssText = this._chipCss(this._enabled.has(cat.id));
      chip.addEventListener('click', () => this._toggleCategory(cat.id));
      this._filterRow.appendChild(chip);
      this._chipEls.set(cat.id, chip);
    }

    root.appendChild(this._filterRow);

    // --- Event list ---
    this._listEl = document.createElement('div');
    this._listEl.style.cssText = [
      'max-height:30vh',
      'overflow-y:auto',
      'background:rgba(0,0,0,0.28)',
      'border:1px solid #333',
      'border-radius:3px',
      'scrollbar-width:thin',
      'scrollbar-color:#3a4a5e rgba(0,0,0,0)',
      // The HUD's container is pointer-events:none; force it back on so
      // the user can scroll this list and click the buttons above.
      'pointer-events:auto'
    ].join(';');
    root.appendChild(this._listEl);

    return root;
  }

  _buildButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    btn.style.cssText = [
      'flex:0 0 auto',
      `background:${BTN_REST.bg}`,
      `border:1px solid ${BTN_REST.border}`,
      `color:${BTN_REST.text}`,
      'border-radius:3px',
      'padding:2px 8px',
      'cursor:pointer',
      'font:10px monospace',
      'letter-spacing:0.5px',
      'pointer-events:auto'
    ].join(';');
    btn.addEventListener('click', onClick);
    return btn;
  }

  _chipCss(on) {
    const c = on ? CHIP_ON : CHIP_OFF;
    return [
      'padding:2px 7px',
      `background:${c.bg}`,
      `border:1px solid ${c.border}`,
      `color:${c.text}`,
      'border-radius:3px',
      'cursor:pointer',
      'font:10px monospace',
      'letter-spacing:0.4px',
      'pointer-events:auto'
    ].join(';');
  }

  // --- filters -------------------------------------------------------------

  _toggleCategory(id) {
    if (this._enabled.has(id)) this._enabled.delete(id);
    else this._enabled.add(id);
    this._syncChips();
    this._invalidate();
  }

  _setAllCategories(on) {
    this._enabled = on
      ? new Set(CATEGORIES.map(c => c.id))
      : new Set();
    this._syncChips();
    this._invalidate();
  }

  _syncChips() {
    for (const [id, chip] of this._chipEls) {
      chip.style.cssText = this._chipCss(this._enabled.has(id));
    }
  }

  _toggleFilters() {
    this._filtersVisible = !this._filtersVisible;
    this._filterRow.style.display = this._filtersVisible ? 'flex' : 'none';
    const c = this._filtersVisible ? BTN_ACTIVE : BTN_REST;
    this._filterBtn.style.background = c.bg;
    this._filterBtn.style.borderColor = c.border;
    this._filterBtn.style.color = c.text;
  }

  // Force the next render() to rebuild regardless of the seq / filter
  // signature. Used after any filter change.
  _invalidate() {
    this._lastSignature = null;
    if (this._visible) this.render(this._currentTracker, true);
  }

  // --- rendering -----------------------------------------------------------

  _rebuild(filtered) {
    this._lastFiltered = filtered;
    this._listEl.textContent = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText =
        'padding:12px 8px;color:#667;font:italic 11px monospace;text-align:center;';
      empty.textContent = 'No events match the current filters.';
      this._listEl.appendChild(empty);
      return;
    }

    const shown = Math.min(filtered.length, MAX_VISIBLE_ROWS);
    // Newest-first: iterate from the end backwards.
    for (let i = filtered.length - 1; i >= filtered.length - shown; i--) {
      this._listEl.appendChild(this._buildRow(filtered[i]));
    }

    if (shown < filtered.length) {
      const more = document.createElement('div');
      more.style.cssText = [
        'padding:6px 8px',
        'color:#667',
        'font:italic 10px monospace',
        'text-align:center',
        'border-top:1px solid #262626'
      ].join(';');
      more.textContent =
        `… ${filtered.length - shown} older event(s) not shown. Copy exports all.`;
      this._listEl.appendChild(more);
    }
  }

  _buildRow(ev) {
    const row = document.createElement('div');
    row.style.cssText = [
      'padding:5px 7px',
      'border-bottom:1px solid #262626',
      'font:11px monospace',
      'line-height:1.45'
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'color:#8ab;letter-spacing:0.4px;';
    head.textContent = `F${ev.frame}  ·  ${ev.label}`;
    row.appendChild(head);

    const change = document.createElement('div');
    change.style.cssText = 'color:#dde;margin-top:1px;';
    change.textContent = ev.change;
    row.appendChild(change);

    const detail = document.createElement('div');
    detail.style.cssText = [
      'color:#7a8a9e',
      'margin-top:3px',
      'padding-left:8px',
      'border-left:2px solid #2a3544',
      'white-space:pre-wrap'
    ].join(';');
    detail.textContent = ev.detail;
    row.appendChild(detail);

    return row;
  }

  // --- copy ----------------------------------------------------------------

  _copyHistory() {
    if (!this._lastFiltered || this._lastFiltered.length === 0) {
      this._flashButton(this._copyBtn, 'EMPTY');
      return;
    }

    // Newest-first, matching the on-screen order. Each event renders as:
    //   [F<frame>] <label>
    //   <change, indented two spaces>
    //   <detail, indented two spaces>
    //   (blank line between events)
    const chunks = [];
    for (let i = this._lastFiltered.length - 1; i >= 0; i--) {
      const ev = this._lastFiltered[i];
      const lines = [`[F${ev.frame}] ${ev.label}`, `  ${ev.change}`];
      for (const dl of String(ev.detail).split('\n')) lines.push(`  ${dl}`);
      chunks.push(lines.join('\n'));
    }
    const text = chunks.join('\n\n');

    copyToClipboard(text).then(ok => {
      this._flashButton(this._copyBtn, ok ? 'COPIED' : 'FAILED');
    });
  }

  _flashButton(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = original; }, 900);
  }
}
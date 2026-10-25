// ===== ChangelogPanel.js =====
// Modal viewer for the project changelog. Opened by clicking the version
// badge (see VersionBadge). One instance per page; the changelog body is
// fetched from /changelog.md on first open and cached for the lifetime of
// the page — the file does not change while the page is open.
//
// Rendered as a monospace <pre> block rather than through a Markdown
// parser. The changelog is prose; a full parser is not worth the code or
// the failure modes it brings. Backticks and hashes read cleanly in a
// fixed-width font, and there is nothing to keep in sync when the file
// format changes.
//
// Styled to match PauseMenuPanel / SettingsPanel — same dark slate panel,
// same border and body colours — so it reads as one family with the rest
// of the in-game chrome.
//
// Close on: backdrop mousedown, Escape key, or the panel's close button.
// z-index 2100: above the version badge (2000) so the modal covers the
// badge that opened it.

const CHANGELOG_SOURCE = 'changelog.md';

// Header font size, indexed by the number of leading '#' characters.
// Per the request, MORE '#' means BIGGER text — reverse of the usual
// markdown convention. Body text is 12.5px, so even a single '#' is
// visibly larger than the surrounding prose. To flip to markdown
// convention, reverse this table (30 down to 15, indexed the same way).
const HEADER_SIZES = {
  1: 15,
  2: 18,
  3: 21,
  4: 24,
  5: 27,
  6: 30
};
const HEADER_MAX_LEVEL = 6;

// Left indent applied to every header line, regardless of level. A single
// shared indent keeps headers visually distinct from body text without
// compounding with the per-level size growth above.
const HEADER_INDENT_PX = 10;

export class ChangelogPanel {
  constructor() {
    this._el = null;
    this._bodyEl = null;
    this._text = null;
    this._loading = false;
    this._keyHandler = null;
    this._docMouseDown = null;
  }

  isOpen() {
    return this._el !== null && this._el.style.display === 'flex';
  }

  open() {
    if (!this._el) this._build();
    this._el.style.display = 'flex';

    // Fetch once. Subsequent opens reuse the cached text. A failed fetch
    // still sets _text (to an error string) so the panel does not retry
    // on every open.
    if (this._text === null && !this._loading) this._load();

    // Defer listener registration so the click that opened this panel is
    // not also caught as the click-away that closes it. Same pattern as
    // UnitInfoPanel.open().
    setTimeout(() => {
      this._keyHandler = (e) => { if (e.key === 'Escape') this.close(); };
      this._docMouseDown = (e) => {
        if (this._el && !this._el.contains(e.target)) this.close();
      };
      document.addEventListener('keydown', this._keyHandler);
      document.addEventListener('mousedown', this._docMouseDown);
    }, 0);
  }

  close() {
    if (!this._el) return;
    this._el.style.display = 'none';
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
    if (this._docMouseDown) {
      document.removeEventListener('mousedown', this._docMouseDown);
      this._docMouseDown = null;
    }
  }

  dispose() {
    this.close();
    if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    this._el = null;
    this._bodyEl = null;
  }

  // --- internals ---------------------------------------------------------

  _load() {
    this._loading = true;
    this._setBody('Loading changelog…');
    fetch(CHANGELOG_SOURCE, { cache: 'no-cache' })
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(text => {
        this._text = text.trim() || '(changelog is empty)';
        this._loading = false;
        this._setBody(this._text);
      })
      .catch(() => {
        this._text = `Could not load ${CHANGELOG_SOURCE}.`;
        this._loading = false;
        this._setBody(this._text);
      });
  }

  // Renders the changelog text into the scrollable body. Each source line
  // becomes its own block-level element, which is what lets headers get
  // their own font size and indent without affecting the lines around
  // them. Body lines keep the container's white-space:pre-wrap, so leading
  // spaces and intra-line runs of spaces are preserved exactly as written.
  //
  // Header detection is standard markdown shape: one or more '#' followed
  // by whitespace and then the header text. A bare '#' with no following
  // space is NOT a header and renders as plain text, which lets a lone
  // '#' be used as a visual separator without turning it into a 15px line.
  _setBody(text) {
    const container = this._bodyEl;
    if (!container) return;
    container.textContent = '';

    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const div = document.createElement('div');
      const match = /^(#{1,6})\s+(.*)$/.exec(raw);

      if (match) {
        const level = match[1].length;
        const size = HEADER_SIZES[level] || HEADER_SIZES[HEADER_MAX_LEVEL];
        div.textContent = match[2];
        div.style.cssText = [
          'font-weight:700',
          'font-size:' + size + 'px',
          'padding-left:' + HEADER_INDENT_PX + 'px',
          'margin:10px 0 4px 0',
          'color:#eef2f8',
          'letter-spacing:0.4px'
        ].join(';');
      } else if (raw === '') {
        // Preserve blank lines. An empty <div> collapses to zero height, so
        // a non-breaking space is inserted to hold the line's height open.
        div.innerHTML = '&nbsp;';
      } else {
        div.textContent = raw;
      }

      container.appendChild(div);
    }
  }

  _build() {
    const root = document.createElement('div');
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:rgba(0,0,0,0.55)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'z-index:2100',
      'font-family:system-ui, -apple-system, Segoe UI, sans-serif',
      'color:#e8e8e8'
    ].join(';');

    // Backdrop click closes. mousedown (not click) so a drag that starts
    // inside the panel and releases on the backdrop does not close it.
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close();
    });

    const panel = document.createElement('div');
    // box-sizing:border-box is load-bearing. max-height and width cap the
    // CONTENT box by default (content-box), so without this the panel's
    // rendered outer box would be max-height + padding + border — roughly
    // 100vh + 2px tall and calc(100vw - 40px) + 50px wide. Under the
    // parent's align-items:center, that vertical overflow is split evenly
    // top and bottom, which clips the header row (and its close button)
    // off the top edge on some browsers. border-box makes both limits
    // apply to the OUTER box, so the panel and its 40px gutter always fit
    // inside the viewport.
    panel.style.cssText = [
      'background:#1e222a',
      'border:1px solid #384050',
      'border-radius:8px',
      'box-sizing:border-box',
      'padding:20px 24px',
      'width:min(720px, calc(100vw - 40px))',
      'max-height:calc(100vh - 40px)',
      'display:flex',
      'flex-direction:column',
      'box-shadow:0 8px 32px rgba(0,0,0,0.5)'
    ].join(';');

    // Header row: title + close button, matching the settings panel's
    // title row layout.
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex',
      'justify-content:space-between',
      'align-items:center',
      'margin-bottom:12px',
      'flex-shrink:0'
    ].join(';');

    const title = document.createElement('h2');
    title.textContent = 'Changelog';
    title.style.cssText = 'margin:0;font-size:18px;font-weight:600;';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '\u00d7'; // multiplication sign, reads as an X
    closeBtn.title = 'Close (Esc)';
    closeBtn.style.cssText = [
      'background:transparent',
      'border:none',
      'color:#e8e8e8',
      'font-size:24px',
      'line-height:1',
      'cursor:pointer',
      'padding:0 4px',
      'font-family:inherit'
    ].join(';');
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Scrollable body. flex:1 + min-height:0 so the overflow engages; the
    // header above stays pinned.
    const body = document.createElement('pre');
    body.style.cssText = [
      'margin:0',
      'padding:12px 14px',
      'background:#10151d',
      'border:1px solid #2a3544',
      'border-radius:6px',
      'font-family:monospace',
      'font-size:12.5px',
      'line-height:1.5',
      'color:#cdd6e2',
      'white-space:pre-wrap',
      'word-break:break-word',
      'overflow-y:auto',
      'flex:1 1 auto',
      'min-height:0',
      'scrollbar-width:thin',
      'scrollbar-color:#3a4a5e #10151d'
    ].join(';');
    this._bodyEl = body;
    panel.appendChild(body);

    root.appendChild(panel);
    document.body.appendChild(root);
    this._el = root;
  }
}
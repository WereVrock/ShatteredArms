// ===== MenuAutoFit.js =====
// Shrinks the menu panel currently on screen until it fits the viewport, so
// a tall screen (the campaign shop with a long card list) never needs the
// browser zoom changed by hand. Never enlarges a panel.
//
// Uses CSS `zoom`, not `transform: scale()`:
//   - zoom changes layout size, so the flex-centred panel stays centred,
//   - a transform on an ancestor would make the position:fixed roster
//     sidebar (.campaign-info) relative to the panel and break it.
// If the sidebar lives inside the panel it inherits the zoom, so it gets
// the inverse zoom to keep its normal size and screen position.
//
// Also tags the panel with data-dense="true" when it holds many cards, so
// the stylesheet can switch the list to two columns before measuring.
//
// Pure UI: reads layout and writes styles only.

const VIEWPORT_MARGIN = 16;
const SIDEBAR_RESERVE = 260;   // 16px gutter + 220px sidebar + 24px air
const MIN_SCALE = 0.5;
const DENSE_CARD_COUNT = 5;

export class MenuAutoFit {
  constructor(root) {
    this.root = root;
    this._panel = null;
    this._frame = 0;
    this._onResize = () => this._refitCurrent();
    window.addEventListener('resize', this._onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize);
    }
  }

  // Call right after a picker has rendered. Fits immediately and once more
  // on the next frame, when icons and fonts have settled.
  refit() {
    this._panel = this.root.querySelector('.menu-panel');
    this._fitNow();
    cancelAnimationFrame(this._frame);
    this._frame = requestAnimationFrame(() => this._fitNow());
  }

  dispose() {
    cancelAnimationFrame(this._frame);
    window.removeEventListener('resize', this._onResize);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._onResize);
    }
  }

  _refitCurrent() {
    if (this._panel && this._panel.isConnected) this._fitNow();
  }

  _findSidebar() {
    return this.root.querySelector('.campaign-info')
      || document.querySelector('.campaign-info');
  }

  _fitNow() {
    const panel = this._panel;
    if (!panel || !panel.isConnected) return;

    const sidebar = this._findSidebar();
    const sidebarInside = !!sidebar && panel.contains(sidebar);

    // Measure at natural size.
    panel.style.zoom = '';
    if (sidebarInside) sidebar.style.zoom = '';

    const cardCount = panel.querySelectorAll('.menu-card').length;
    panel.dataset.dense = cardCount >= DENSE_CARD_COUNT ? 'true' : 'false';

    const rect = panel.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;

    const sideReserve = sidebar ? SIDEBAR_RESERVE : VIEWPORT_MARGIN;
    const availW = window.innerWidth - 2 * sideReserve;
    const availH = window.innerHeight - 2 * VIEWPORT_MARGIN;

    let scale = Math.min(1, availW / rect.width, availH / rect.height);
    if (!Number.isFinite(scale)) return;
    scale = Math.max(MIN_SCALE, scale);
    if (scale >= 0.995) return;

    panel.style.zoom = String(scale);
    if (sidebarInside) sidebar.style.zoom = String(1 / scale);
  }
}
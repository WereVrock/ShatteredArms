// ===== FullscreenButton.js =====
// Small always-available fullscreen toggle, pinned to the bottom-right
// corner. Mounted once from main.js on document.body so it survives menu
// re-renders (which replace innerHTML on menu root elements but never
// remove those elements themselves).
//
// Uses the standard Fullscreen API with a webkit-prefixed fallback for
// Safari, which still ships prefixed methods. The icon reflects the
// browser's ACTUAL fullscreen state via the `fullscreenchange` event,
// not a locally-tracked boolean — pressing F11, using the browser menu,
// or pressing Escape all change the state without going through this
// button, and reading the browser's own state is the only way to catch
// those transitions. Both the standard and the webkit event name are
// listened for, since Safari only fires the prefixed one.
//
// Pure UI. Holds no game state, has no dependency on SettingsStore, and
// takes no constructor arguments. Construct it once; call dispose() when
// tearing it down (only needed if the page is not about to navigate —
// the main.js mount is a permanent mount for the tab's lifetime).

const ICON_EXPAND = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polyline points="4,10 4,4 10,4"/>
  <polyline points="20,10 20,4 14,4"/>
  <polyline points="4,14 4,20 10,20"/>
  <polyline points="20,14 20,20 14,20"/>
</svg>`;

const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polyline points="10,4 10,10 4,10"/>
  <polyline points="14,4 14,10 20,10"/>
  <polyline points="10,20 10,14 4,14"/>
  <polyline points="14,20 14,14 20,14"/>
</svg>`;

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  return Promise.resolve();
}

function exitFullscreen() {
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  return Promise.resolve();
}

export class FullscreenButton {
  constructor() {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.title = 'Enter fullscreen';
    this.el.style.cssText = [
      'position:fixed',
      'right:8px',
      'bottom:8px',
      // z-index 2000: same tier as the FPS counter and version badge —
      // above every overlay in the game (HUD 10, bars 15/16, topBar 20,
      // main menu 30, pause menu 90, settings 100, battle result 1000),
      // so the button is reachable from the menu, the pause menu, and
      // mid-battle alike.
      'z-index:2000',
      'width:30px',
      'height:30px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:0',
      'background:rgba(20,30,45,0.78)',
      'border:1px solid #3a4a5e',
      'border-radius:4px',
      'color:#cdd6e2',
      'cursor:pointer',
      'user-select:none',
      'transition:background 0.1s ease, color 0.1s ease'
    ].join(';');
    this.el.innerHTML = ICON_EXPAND;

    this.el.addEventListener('mouseenter', () => {
      this.el.style.background = 'rgba(30,45,65,0.85)';
      this.el.style.color = '#eef2f8';
    });
    this.el.addEventListener('mouseleave', () => {
      this.el.style.background = 'rgba(20,30,45,0.78)';
      this.el.style.color = '#cdd6e2';
    });
    this.el.addEventListener('click', () => this._toggle());

    // Bound once so removeEventListener finds the same reference in
    // dispose(). Both event names are registered unconditionally —
    // registering for an event a browser never fires is harmless, and
    // this avoids a feature-detect on which name to use.
    this._onChange = () => this._syncIcon();
    document.addEventListener('fullscreenchange', this._onChange);
    document.addEventListener('webkitfullscreenchange', this._onChange);

    document.body.appendChild(this.el);
    this._syncIcon();
  }

  _toggle() {
    // requestFullscreen() returns a Promise that rejects if the browser
    // blocks the request (e.g. not in a user-gesture context). Swallow
    // the rejection silently — the browser already shows its own
    // console warning, and there is nothing this UI can do about it.
    if (isFullscreen()) {
      exitFullscreen().catch(() => {});
    } else {
      requestFullscreen().catch(() => {});
    }
  }

  // Re-derive icon and tooltip from the browser's live fullscreen state.
  // Idempotent — safe to call any number of times, including the initial
  // call from the constructor.
  _syncIcon() {
    const fs = isFullscreen();
    this.el.innerHTML = fs ? ICON_COLLAPSE : ICON_EXPAND;
    this.el.title = fs ? 'Exit fullscreen' : 'Enter fullscreen';
  }

  dispose() {
    document.removeEventListener('fullscreenchange', this._onChange);
    document.removeEventListener('webkitfullscreenchange', this._onChange);
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}
// ===== FpsCounter.js =====
// Small always-available FPS readout. Positioned top-right so it never
// collides with the top-left HUD, the top-center pause / start panels, or
// the bottom command / army bars.
//
// Visibility has two inputs and they are OR'd:
//   - SettingsStore.showFps — the user-facing toggle, default off.
//   - debugOverride        — forced on while a G+click unit inspection is
//                            active, regardless of the setting. Debug
//                            always wins; the setting only matters when
//                            debug is off.
//
// The displayed value is an exponential moving average over frame deltas,
// written to the DOM at most every REFRESH_MS so a 144 Hz frame rate does
// not thrash layout 144 times a second. Non-visible frames skip the DOM
// write and the string formatting entirely — the counter costs one
// subtraction and one multiply per frame while hidden.
//
// Pure UI. Reads SettingsStore directly (same pattern as SettingsPanel);
// holds no sim / scene / game state.
import { SettingsStore } from './settings/SettingsStore.js';

// Milliseconds between DOM writes while visible. 250 ms reads as steady
// without flickering on sub-frame jitter.
const REFRESH_MS = 250;

// EMA weight on the newest sample. 0.1 is smooth enough that a single slow
// frame does not visibly jerk the readout, fast enough to settle within
// ~20 frames (~1/3 s at 60 FPS) after a real performance change.
const EMA_ALPHA = 0.1;

export class FpsCounter {
  constructor() {
    this._fps = 0;
    this._lastFrameTime = 0;
    this._lastWriteTime = 0;
    this._debugOverride = false;
    this._visible = false;

    // z-index 2000: above every overlay in the game — HUD (10), bars
    // (15/16), topBar (20), main menu (30), pause menu (90), settings
    // panel (100), battle result overlay (1000). The FPS counter is a
    // diagnostic, so it stays readable even with a modal open — that is
    // exactly the state where the frame rate is most interesting (menus
    // that mount heavy DOM can tank it).
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed',
      'top:8px',
      'right:8px',
      'z-index:2000',
      'padding:3px 8px',
      'background:rgba(0,0,0,0.6)',
      'color:#c8e6a0',
      'font-family:monospace',
      'font-size:12px',
      'font-variant-numeric:tabular-nums',
      'letter-spacing:0.5px',
      'border-radius:3px',
      'border:1px solid rgba(255,255,255,0.1)',
      'pointer-events:none',
      'user-select:none',
      'display:none'
    ].join(';');
    this.el.textContent = '-- FPS';
    document.body.appendChild(this.el);

    // Re-evaluate visibility whenever any setting changes. Cheap — this
    // only fires on SettingsStore.set(), not per frame.
    this._unsub = SettingsStore.subscribe(() => this._applyVisibility());
    this._applyVisibility();
  }

  // Called from main.js's debug-selection wiring. Debug mode wins: while a
  // unit is under G+click inspection the counter is shown even if the
  // user-facing setting is off.
  setDebugOverride(on) {
    const next = !!on;
    if (next === this._debugOverride) return;
    this._debugOverride = next;
    this._applyVisibility();
  }

  // Called once per render frame from the main loop. `now` is the same
  // performance.now() timestamp the loop already receives.
  update(now) {
    if (this._lastFrameTime === 0) {
      this._lastFrameTime = now;
      return;
    }
    const dt = now - this._lastFrameTime;
    this._lastFrameTime = now;
    if (dt <= 0) return;

    const instant = 1000 / dt;
    this._fps = this._fps === 0
      ? instant
      : this._fps * (1 - EMA_ALPHA) + instant * EMA_ALPHA;

    if (!this._visible) return;
    if (now - this._lastWriteTime < REFRESH_MS) return;
    this._lastWriteTime = now;
    this.el.textContent = `${Math.round(this._fps)} FPS`;
  }

  dispose() {
    if (this._unsub) this._unsub();
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  // Visible if either input asks for it. Setting is read fresh on every
  // call so a flip in the settings panel is reflected immediately.
  _applyVisibility() {
    const show = this._debugOverride || !!SettingsStore.get().showFps;
    if (show === this._visible) return;
    this._visible = show;
    this.el.style.display = show ? 'block' : 'none';
  }
}
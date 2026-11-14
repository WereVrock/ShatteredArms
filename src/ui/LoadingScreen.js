// Full-screen overlay shown while the blocking scene + terrain build runs.
// Purely visual: no logic, no progress tracking (terrain generation is a
// single synchronous pass, so there is nothing meaningful to sample). The
// bar is a decorative sweep.
//
// Lifecycle:
//   LoadingScreen.show()  — call at the very top of startScenario, before
//                           any blocking work.
//   LoadingScreen.hide()  — call from the render loop after the FIRST
//                           drawn frame, not before. Hiding earlier swaps
//                           the overlay for a blank canvas.
//
// The overlay is a singleton: repeated show()/hide() calls reuse the same
// DOM node, so a restart inside the same session never leaks nodes.

let _el = null;
let _styleInjected = false;

function _injectStyle() {
  if (_styleInjected) return;
  _styleInjected = true;
  const style = document.createElement('style');
  style.id = 'loadingScreenStyles';
  style.textContent = `
    @keyframes loadingScreenSweep {
      0%   { left: -40%; }
      100% { left: 100%; }
    }
    #loadingScreen {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: none;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 20px;
      background: radial-gradient(ellipse at center, #1a2433 0%, #0a0f17 100%);
      color: #cde;
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      user-select: none;
    }
    #loadingScreen .ls-title {
      font-size: 18px;
      letter-spacing: 4px;
      text-transform: uppercase;
      color: #d0b878;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    }
    #loadingScreen .ls-bar {
      position: relative;
      width: 240px;
      height: 3px;
      background: #1e2430;
      border-radius: 2px;
      overflow: hidden;
    }
    #loadingScreen .ls-fill {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 40%;
      background: linear-gradient(90deg, #d0b878, #f0e8d0);
      animation: loadingScreenSweep 1.1s infinite ease-in-out;
    }
    #loadingScreen .ls-subtitle {
      font-size: 11px;
      letter-spacing: 2px;
      color: #6c7c92;
      text-transform: uppercase;
    }
  `;
  document.head.appendChild(style);
}

function _ensure() {
  if (_el) return _el;

  // Remove the inline boot placeholder (see index.html #bootLoading). It
  // was visible from the moment the HTML parsed — that is what kept the
  // page from flashing white while style.css and main.js loaded. The real
  // loading screen takes over with the same colour scheme and animation,
  // so the transition is invisible.
  const boot = document.getElementById('bootLoading');
  if (boot && boot.parentNode) boot.parentNode.removeChild(boot);

  _injectStyle();

  _el = document.createElement('div');
  _el.id = 'loadingScreen';

  const title = document.createElement('div');
  title.className = 'ls-title';
  title.textContent = 'Generating battlefield';
  _el.appendChild(title);

  const bar = document.createElement('div');
  bar.className = 'ls-bar';
  const fill = document.createElement('div');
  fill.className = 'ls-fill';
  bar.appendChild(fill);
  _el.appendChild(bar);

  const sub = document.createElement('div');
  sub.className = 'ls-subtitle';
  sub.textContent = 'Building terrain · placing obstacles';
  _el.appendChild(sub);

  document.body.appendChild(_el);
  return _el;
}

export const LoadingScreen = {
  // message is optional; when supplied it replaces the default title so a
  // caller can say "Loading multiplayer battle" or similar.
  show(message) {
    const el = _ensure();
    if (typeof message === 'string' && message.length > 0) {
      const title = el.querySelector('.ls-title');
      if (title) title.textContent = message;
    }
    el.style.display = 'flex';
  },

  hide() {
    if (_el) _el.style.display = 'none';
  }
};
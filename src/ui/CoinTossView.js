// Coin toss animation shown at the start of every turn-based cycle.
//
// A modal overlay with a 3D-flipping coin. The flip plays for ~1.6 s,
// then the caption swaps to the winner and fades ~0.7 s later.
//
// The result is picked FIRST, then the animation is chosen so the coin
// visually lands on that face. An earlier version used a single keyframe
// ending at rotateY(1440deg) — a multiple of 360 — so the coin landed on
// face A (P1/blue) on every flip, even when the result was red. The
// result was fair; only the visual was not. Two keyframes now exist, one
// landing on each face, and the winner decides which plays.
//
// Result is delivered as a team id ('blue' | 'red'), which the controller
// maps to Player 1 / Player 2 for user-facing text.

import { SettingsStore } from './settings/SettingsStore.js';

const FLIP_MS = 1600;
const SETTLE_MS = 700;
const STYLE_ID = 'coin-toss-styles';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  // Two keyframes. Both spin three and a half times; the only difference
  // is the final Y rotation:
  //   blue ends at 1440deg → 0 mod 360 → face A (P1) visible.
  //   red  ends at 1620deg → 180 mod 360 → face B (P2) visible.
  // Same vertical arc and same number of full spins, so the toss reads
  // identically from either outcome.
  st.textContent = `
    @keyframes coin-flip-blue {
      0%   { transform: translateY(0)     rotateY(0deg);    }
      25%  { transform: translateY(-70px) rotateY(360deg);  }
      50%  { transform: translateY(-110px) rotateY(720deg); }
      75%  { transform: translateY(-60px) rotateY(1080deg); }
      100% { transform: translateY(0)     rotateY(1440deg); }
    }
    @keyframes coin-flip-red {
      0%   { transform: translateY(0)     rotateY(0deg);    }
      25%  { transform: translateY(-70px) rotateY(360deg);  }
      50%  { transform: translateY(-110px) rotateY(720deg); }
      75%  { transform: translateY(-60px) rotateY(1080deg); }
      100% { transform: translateY(0)     rotateY(1620deg); }
    }
  `;
  document.head.appendChild(st);
}

export class CoinTossView {
  constructor() {
    ensureStyles();
    this._el = null;
    this._timer = null;
    this._onResult = null;
  }

  // Plays the animation; calls onResult('blue' | 'red') once settled.
  show(onResult) {
    this._onResult = onResult || null;

    // Decide the winner up front. Fair 50/50; the coin face is then
    // chosen to match, so the visual is a consequence of the roll rather
    // than a parallel random draw that can disagree with it.
    const winner = Math.random() < 0.5 ? 'blue' : 'red';

    // Instant mode: skip the entire visual and resolve on the next tick.
    // A setTimeout(0) rather than a synchronous call keeps the call graph
    // identical between animated and instant modes — the controller's
    // state-machine transitions always happen one tick after show()
    // returns, never inside it. Nothing to dispose, nothing on screen.
    if (SettingsStore.get().instantCoinToss) {
      this._timer = setTimeout(() => {
        this._timer = null;
        if (this._onResult) this._onResult(winner);
      }, 0);
      return;
    }

    const animationName = winner === 'blue' ? 'coin-flip-blue' : 'coin-flip-red';

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0',
      'background:rgba(0,0,0,0.72)',
      'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center',
      'z-index:1100',
      'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
      'color:#eef2f8', 'user-select:none'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Coin Toss';
    title.style.cssText = [
      'font-size:22px', 'letter-spacing:5px', 'text-transform:uppercase',
      'color:#d0c8a0', 'margin-bottom:36px',
      'text-shadow:0 2px 4px rgba(0,0,0,0.6)'
    ].join(';');
    overlay.appendChild(title);

    const stage = document.createElement('div');
    stage.style.cssText = 'width:120px;height:120px;perspective:900px;margin-bottom:36px;';

    const coin = document.createElement('div');
    coin.style.cssText = [
      'width:100%', 'height:100%', 'position:relative',
      'transform-style:preserve-3d',
      'animation:' + animationName + ' ' + (FLIP_MS / 1000) + 's cubic-bezier(0.35,0,0.6,1) forwards'
    ].join(';');

    const faceA = buildFace('P1', '#4a80b8', '#1e3a52');
    const faceB = buildFace('P2', '#b84a4a', '#521e1e');
    faceB.style.position = 'absolute';
    faceB.style.inset = '0';
    faceB.style.transform = 'rotateY(180deg)';
    coin.appendChild(faceA);
    coin.appendChild(faceB);
    stage.appendChild(coin);
    overlay.appendChild(stage);

    const caption = document.createElement('div');
    caption.textContent = 'Deciding…';
    caption.style.cssText = 'font-size:13px;color:#a8b4c4;letter-spacing:0.6px;';
    overlay.appendChild(caption);

    document.body.appendChild(overlay);
    this._el = overlay;

    // Result fires on a timeout, not animationend, so a slow frame cannot
    // stall the flow. Visual and result are independent.
    this._timer = setTimeout(() => {
      caption.textContent = (winner === 'blue' ? 'Player 1 (Blue)' : 'Player 2 (Red)') + ' goes first';
      caption.style.color = '#e0d0a0';
      caption.style.fontSize = '16px';
      caption.style.letterSpacing = '1.4px';

      this._timer = setTimeout(() => {
        this._teardown();
        if (this._onResult) this._onResult(winner);
      }, SETTLE_MS);
    }, FLIP_MS);
  }

  dispose() {
    this._teardown();
    this._onResult = null;
  }

  _teardown() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    this._el = null;
  }
}

function buildFace(label, light, dark) {
  const f = document.createElement('div');
  f.textContent = label;
  f.style.cssText = [
    'width:100%', 'height:100%', 'border-radius:50%',
    'background:radial-gradient(circle at 35% 30%, ' + light + ' 0%, ' + dark + ' 100%)',
    'border:3px solid #d0b878',
    'box-shadow:0 6px 18px rgba(0,0,0,0.55), inset 0 0 14px rgba(0,0,0,0.4)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'color:#f0e8d0', 'font-weight:700', 'letter-spacing:3px',
    'font-size:16px', 'text-shadow:0 1px 2px rgba(0,0,0,0.7)',
    'backface-visibility:hidden'
  ].join(';');
  return f;
}
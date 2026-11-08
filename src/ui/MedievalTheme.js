// ===== MedievalTheme.js =====
// Shared fantasy/medieval visual theme: page-wide cursor replacements plus
// a singleton custom tooltip.
//
// Two reasons this file exists:
//   1. Native `title` attribute tooltips are rendered by the browser's
//      chrome and cannot be styled. ArmyBarView stores the hover text on
//      `dataset.tooltipName` and drives this class instead.
//   2. The default OS pointer breaks the fantasy theme. Small SVG data
//      URIs give an appropriately themed arrow / pointer / grab / grabbing
//      set without shipping asset files.
//
// Cursor size: kept at 24x24, comfortably under the ~32x32 cap browsers
// apply to custom cursor images. Colours match the army bar's palette
// (bronze / parchment) so the cursor does not fight the UI.
//
// Tooltip look: a small engraved parchment plaque — warm gradient, bronze
// border with inset highlight, serif font, radial rivets in the corners,
// and a downward pointer triangle. It flips below its anchor when there is
// no room above (e.g. a top-anchored army bar in local multiplayer).
//
// Pure presentation. No sim / scene / persistence knowledge.

import { ensureMedievalGlobalTheme } from './MedievalGlobalTheme.js';
import { installTitleTooltips } from './TitleTooltips.js';

const STYLE_ID = 'medieval-theme-styles';

// --- cursor SVGs ----------------------------------------------------------
// Small, recognisable shapes at this size. Each is a light fill with a
// dark outline so it reads on any background the game paints.

// Default arrow — a classic up-left pointing cursor with a gold fill and
// bronze trim. Familiar enough to feel native, warm enough to feel themed.
const CURSOR_ARROW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <polygon points="2,2 2,20 8,14 12,22 15,20 11,13 20,13"
           fill="#3a2410" stroke="#e8c060" stroke-width="1.2" stroke-linejoin="round"/>
  <polygon points="3.5,4.5 3.5,17 8,12 11,18.5 12.5,17.8 9.5,11 16.5,11"
           fill="#e8d0a0" stroke="#3a2410" stroke-width="0.6" stroke-linejoin="round"/>
</svg>`;

// Pointing gauntlet — used on every clickable element. Warm gold "hand".
const CURSOR_POINTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g fill="#e8c060" stroke="#3a2410" stroke-width="1.2" stroke-linejoin="round">
    <!-- Palm / fist base: rounded bottom, flat top that the finger
         and knuckle bumps grow out of. -->
    <path d="M 6 12 L 17 12 Q 19 12 19 14 L 19 19
             Q 19 22 16 22 L 9 22 Q 6 22 6 19 Z"/>
    <!-- Index finger, pointing up. Its base overlaps the palm at
         y=12..13, which merges visually into one shape. -->
    <path d="M 8.5 13 L 8.5 4 Q 8.5 2 10 2 Q 11.5 2 11.5 4 L 11.5 13"/>
    <!-- Thumb bulging left. -->
    <path d="M 6 14 Q 3 14 3 16.5 Q 3 18.5 6 18.5"/>
    <!-- Knuckle bumps on the top-right — two rounded fingers
         curled against the palm. -->
    <path d="M 12 13 L 12 10 Q 12 9 13 9 Q 14 9 14 10 L 14 12"/>
    <path d="M 14 12 L 14 10 Q 14 9 15 9 Q 16 9 16 10 L 16 12"/>
  </g>
</svg>`;

// Open hand — used while hovering a draggable element (squad tab, or a
// card while it is being pressed for a drag).
const CURSOR_GRAB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g fill="#e8c060" stroke="#3a2410" stroke-width="1.2" stroke-linejoin="round">
    <!-- Palm base -->
    <path d="M 5 13 L 19 13 Q 21 13 21 15 L 21 19
             Q 21 22 18 22 L 8 22 Q 5 22 5 19 Z"/>
    <!-- Four open fingers, slightly staggered in height so the hand
         reads as a hand rather than a comb. Bases overlap the palm
         by 1-2 px so the shapes merge. -->
    <rect x="5.5"  y="6" width="2.5" height="8"  rx="1.2"/>
    <rect x="8.5"  y="4" width="2.5" height="10" rx="1.2"/>
    <rect x="11.5" y="4" width="2.5" height="10" rx="1.2"/>
    <rect x="14.5" y="5" width="2.5" height="9"  rx="1.2"/>
    <!-- Thumb on the right -->
    <path d="M 19 14 Q 22 14 22 16.5 Q 22 19 19 19"/>
  </g>
</svg>`;

// Closed fist — used while an army-bar drag is actively running.
const CURSOR_GRABBING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g fill="#e8c060" stroke="#3a2410" stroke-width="1.2" stroke-linejoin="round">
    <!-- Fist body — a fat rounded block. -->
    <rect x="5" y="9" width="14" height="12" rx="4"/>
    <!-- Four knuckle bumps along the top edge. -->
    <circle cx="8"  cy="9"   r="1.8"/>
    <circle cx="11" cy="8.5" r="1.8"/>
    <circle cx="14" cy="8.5" r="1.8"/>
    <circle cx="17" cy="9"   r="1.8"/>
    <!-- Thumb curled across the front. -->
    <path d="M 17 13 Q 20 13 20 15 Q 20 16.5 19 16.5"/>
  </g>
</svg>`;

// Attack cursor — a downward short sword. Blade points down so the
// click registers where the sword is aimed at the target below the
// cursor; the hot point is the blade tip (12, 22) rather than the pommel.
// Pommel, grip, crossguard and blade each carry the same bronze / steel
// palette as the hand cursors so all four read as one set.
const CURSOR_ATTACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g stroke="#3a2410" stroke-width="1.2" stroke-linejoin="round">
    <circle cx="12" cy="2.5" r="1.7" fill="#e8c060"/>
    <rect x="10" y="4" width="4" height="4" fill="#3a2410"/>
    <rect x="4.5" y="8" width="15" height="2" rx="0.5" fill="#e8c060"/>
    <polygon points="10,10 14,10 14,18 12,22 10,18" fill="#e0d8b8"/>
    <line x1="12" y1="11" x2="12" y2="19" stroke="#8a7c60" stroke-width="0.7"/>
  </g>
</svg>`;

// Wraps an SVG string into a CSS `url(...)` value with the SVG URI-encoded.
// `charset=utf-8` is important: browsers need it to parse the raw `<` `>`
// characters after decoding.
function cursorUrl(svg, hotX, hotY, fallback) {
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
}

const STYLE_TEXT = `
  /* ===== Medieval cursors ===== */

  /* Default arrow — inherited by anything the rules below do not name. */
  html, body {
    cursor: ${cursorUrl(CURSOR_ARROW_SVG, 2, 2, 'auto')};
  }

  /* Clickable surfaces. :not(:disabled) lets a disabled control keep its
     own not-allowed / default cursor. The selectors mirror the classes
     the game actually uses — .army-card and .menu-card are div/button
     custom controls that the base button rule misses. */
  a:not([disabled]),
  button:not(:disabled),
  [role="button"]:not([aria-disabled="true"]),
  label[for], summary,
  .army-card, .army-card *,
  .menu-card,
  .custom-palette-card, .custom-add-btn,
  .custom-team-unit, .custom-team-unit-remove,
  .custom-role-btn, .custom-mirror-btn,
  .size-stepper-btn:not(:disabled),
  .cmd-btn:not(:disabled),
  .army-bar-tool-btn, .army-bar-sort-btn,
  .army-squad-chip button,
  .amv-btn:not(:disabled), .amv-split-btn, .amv-close, .amv-menu-item,
  .cheat-btn:not(:disabled),
  .champ-btn, .champ-node, .champ-close,
  .campaign-exit-option, .campaign-exit-cancel,
  .profile-btn, .profile-action,
  .ai-tier-picker button {
    cursor: ${cursorUrl(CURSOR_POINTER_SVG, 10, 3, 'pointer')};
  }

  /* Text fields keep the I-beam so editing still feels native. */
  input[type="text"],
  input[type="number"],
  input[type="search"],
  input[type="email"],
  input[type="password"],
  input:not([type]),
  textarea,
  [contenteditable="true"] {
    cursor: text;
  }

  /* Draggable surfaces. Squad tabs are dragged as a whole; army cards
     enter a drag on their own after a small pointer move, so a plain
     press-and-hold reads better as "grab". */
  .army-squad-chip {
    cursor: ${cursorUrl(CURSOR_GRAB_SVG, 12, 12, 'grab')} !important;
  }

  /* Active drag: the whole bar and every remaining card show a fist,
     matching the drag's own "I am carrying this" feel. The dragged card
     itself has pointer-events: none so no cursor lands on it; the bar
     root is what carries the grabbing cursor around the whole strip. */
  #armyBar.army-bar-drag-active,
  #armyBarRed.army-bar-drag-active,
  #armyBar.army-bar-drag-active .army-card,
  #armyBarRed.army-bar-drag-active .army-card {
    cursor: ${cursorUrl(CURSOR_GRABBING_SVG, 12, 12, 'grabbing')} !important;
  }

  /* Attack cursor. Two ways to activate it:
       - apply the .attack-cursor class to any element directly, for a
         one-off control that always wants a sword;
       - toggle the class on <html> via setAttackCursor(true), which
         scopes the sword to the render canvas. This is the mode-level
         flow: an order / selection controller calls setAttackCursor(true)
         while the pointer is over an enemy unit, then false on leave.
     Hot point (12, 22) is the blade tip, so a click lands where the
     blade points. */
  .attack-cursor,
  html.attack-cursor #renderCanvas {
    cursor: ${cursorUrl(CURSOR_ATTACK_SVG, 12, 22, 'crosshair')} !important;
  }

  /* ===== Medieval tooltip ===== */

  .medieval-tooltip {
    position: fixed;
    z-index: 3000;
    pointer-events: none;
    display: none;
    padding: 7px 14px;
    font-family: 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.7px;
    color: #2a1a08;
    /* Two stacked backgrounds: a soft radial highlight in the top-left
       corner (the light catching the parchment) on top of the vertical
       parchment gradient. */
    background:
      radial-gradient(ellipse at 30% 20%,
        rgba(255, 240, 200, 0.85) 0%,
        rgba(255, 240, 200, 0) 55%),
      linear-gradient(180deg, #f4e8c8 0%, #e2d0a4 55%, #cfbc90 100%);
    border: 2px solid #6a4a1e;
    border-radius: 4px;
    box-shadow:
      0 0 0 1px #2a1a08,
      inset 0 0 0 1px #b08848,
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      0 4px 14px rgba(0, 0, 0, 0.6),
      0 0 22px rgba(232, 192, 96, 0.15);
    text-shadow: 0 1px 0 rgba(255, 255, 255, 0.4);
    /* normal (not nowrap) so long tooltips wrap into a paragraph. Short
       tooltips still fit on one line. */
    white-space: normal;
    max-width: 340px;
    line-height: 1.45;
    overflow: hidden;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .medieval-tooltip.visible {
    display: block;
    opacity: 1;
  }

  /* Two bronze rivets in the top corners — the plaque detail that carries
     the theme more than the gradient does. */
  .medieval-tooltip::before,
  .medieval-tooltip::after {
    content: '';
    position: absolute;
    width: 5px;
    height: 5px;
    background:
      radial-gradient(circle at 35% 30%,
        #f0d080 0%, #a87a44 60%, #3a2410 100%);
    border: 1px solid #2a1a08;
    border-radius: 50%;
    top: 2px;
    z-index: 1;
  }
  .medieval-tooltip::before { left: 3px; }
  .medieval-tooltip::after  { right: 3px; }

  /* Downward pointer triangle, sits just below the plaque. Two stacked
     triangles: the outer is the bronze border, the inner is the parchment
     fill so the pointer reads as an extension of the plaque itself. */
  .medieval-tooltip .tt-pointer {
    position: absolute;
    left: 50%;
    bottom: -9px;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-top: 9px solid #6a4a1e;
    filter: drop-shadow(0 2px 1px rgba(0, 0, 0, 0.35));
  }
  .medieval-tooltip .tt-pointer::after {
    content: '';
    position: absolute;
    left: -6px;
    top: -9px;
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 7px solid #e2d0a4;
  }
  /* Flipped orientation when the tooltip is rendered below its anchor. */
  .medieval-tooltip.below .tt-pointer {
    bottom: auto;
    top: -9px;
    border-top: none;
    border-bottom: 9px solid #6a4a1e;
  }
  .medieval-tooltip.below .tt-pointer::after {
    top: auto;
    bottom: -9px;
    border-top: none;
    border-bottom: 7px solid #e2d0a4;
  }
`;

let _stylesEnsured = false;

// Injects the shared stylesheet once per page. Safe to call from anywhere;
// idempotent. Called at boot from main.js so the cursor theme applies on
// the menus too, before any battle constructs the tooltip.
export function ensureMedievalThemeStyles() {
  if (_stylesEnsured) return;
  _stylesEnsured = true;
  ensureMedievalGlobalTheme();
  installTitleTooltips(() => getMedievalTooltip());
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_TEXT;
  document.head.appendChild(el);
}

// --- tooltip singleton ----------------------------------------------------

// Short delay before showing, matching the "feels instant but does not
// flash while sweeping the mouse across a row of cards" cadence games use.
const HOVER_DELAY_MS = 220;

class MedievalTooltip {
  constructor() {
    ensureMedievalThemeStyles();

    this.el = document.createElement('div');
    this.el.className = 'medieval-tooltip';

    this._textEl = document.createElement('span');
    this.el.appendChild(this._textEl);

    const pointer = document.createElement('span');
    pointer.className = 'tt-pointer';
    this.el.appendChild(pointer);

    document.body.appendChild(this.el);

    this._target = null;
    this._showTimer = null;
  }

  // Delayed show. Called on mouseenter so a fast sweep across several
  // cards never flashes a stack of tooltips.
  schedule(element, text) {
    this.cancel();
    this._showTimer = setTimeout(() => {
      this._showTimer = null;
      this._showNow(element, text);
    }, HOVER_DELAY_MS);
  }

  _showNow(element, text) {
    if (!element || !text) return;
    this._target = element;
    this._textEl.textContent = text;
    // Add the visibility class FIRST so the element can be measured
    // (offsetWidth is 0 on display:none). Position is set in the same
    // frame, so no visible flash of an unpositioned tooltip.
    // Reset first: a stale left near the right edge would shrink the
    // available width and make wrapped text measure too narrow.
    this.el.style.left = '0px';
    this.el.style.top = '0px';
    this.el.classList.add('visible');
    const r = element.getBoundingClientRect();
    this._layout(r.left + r.width / 2, r.top, r.bottom);
  }

  // Hide the tooltip. `element` guards against a mouseleave on an old
  // card cancelling a tooltip that belongs to a new card.
  hide(element) {
    if (this._showTimer) { clearTimeout(this._showTimer); this._showTimer = null; }
    if (element && element !== this._target) return;
    this._target = null;
    this.el.classList.remove('visible');
  }

  cancel() {
    if (this._showTimer) { clearTimeout(this._showTimer); this._showTimer = null; }
  }

  // Anchors the plaque to (anchorX, targetTop) with the plaque above the
  // target. Flips below if there is no room above the viewport edge.
  _layout(anchorX, targetTop, targetBottom) {
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const margin = 10;
    const pad = 8;

    // Horizontal: centered on the anchor, clamped to the viewport.
    let left = anchorX - w / 2;
    left = Math.max(pad, Math.min(window.innerWidth - w - pad, left));

    // Vertical: above by default; flip below if the plaque would clip.
    let top = targetTop - h - margin;
    let below = false;
    if (top < pad) {
      top = targetBottom + margin;
      below = true;
    }
    // A tall paragraph flipped below a row near the bottom can still run
    // off-screen; pull it back in. No-op for one-line tooltips.
    if (top + h > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - h - pad);
    }

    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top  = `${Math.round(top)}px`;
    this.el.classList.toggle('below', below);

    // Re-aim the pointer triangle at the actual anchor X within the plaque
    // (clamped so it cannot poke out of a corner).
    const pointer = this.el.querySelector('.tt-pointer');
    if (pointer) {
      const rel = Math.max(12, Math.min(w - 12, anchorX - left));
      pointer.style.left = `${rel}px`;
    }
  }

  dispose() {
    this.cancel();
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

let _sharedTooltip = null;

// Returns the page-wide tooltip instance, creating it (and the stylesheet)
// on first use. Every caller shares one element, so only one tooltip can
// ever be on screen.
export function getMedievalTooltip() {
  ensureMedievalThemeStyles();
  if (!_sharedTooltip) _sharedTooltip = new MedievalTooltip();
  return _sharedTooltip;
}

// Toggles the sword / attack cursor page-wide. While active, the render
// canvas shows the themed sword cursor instead of the default arrow — the
// "aiming at a hostile" cue.
//
// Idempotent. Safe to call from any code path that does not otherwise know
// about the DOM. Wiring (in OrderDragController or SelectionController):
//
//   import { setAttackCursor } from '../ui/MedievalTheme.js';
//   // on pointer enter over an enemy unit:   setAttackCursor(true);
//   // on pointer leave / drop / cancel:      setAttackCursor(false);
//
// Dormant until something calls it — the sword simply never appears.
export function setAttackCursor(active) {
  ensureMedievalThemeStyles();
  document.documentElement.classList.toggle('attack-cursor', !!active);
}

// Start the theme (global stylesheet, cursors, and title-tooltip routing)
// the moment this module loads, instead of waiting for the first army-bar
// hover. Without this the menus had no theme until a battle started.
if (typeof document !== 'undefined' && document.head) {
  ensureMedievalThemeStyles();
  console.info('[MedievalTheme] active: cursors, tooltips and title routing installed');
}
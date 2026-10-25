// ===== VersionBadge.js =====
// Bottom-left version label. Mounted once from main.js on document.body so
// it survives menu re-renders (which replace innerHTML on menu root
// elements but never remove those elements themselves).
//
// Visible while EITHER watched element is on screen:
//   - #mainMenu  (top-level menu, scenario picker, campaign picker,
//                 custom-battle setup — all share this element)
//   - the in-game pause menu overlay
// watch() registers an element; a MutationObserver on each watched node
// reconciles the badge's own display against the whole watched set on
// every class / style change. Adding a new watched element requires no
// change to any code path that opens or closes that element.
//
// Two interactions:
//   Hover   — shows a custom tooltip above the badge with version, build
//             number and last-updated timestamp. Custom (not the native
//             `title` attribute) because the native tooltip has a
//             browser-controlled delay of roughly a second, cannot be
//             styled, and would clash visually with the badge. The
//             tooltip appears instantly on mouseenter and is styled to
//             match the badge itself.
//   Click   — opens the changelog (see ChangelogPanel). The badge is
//             the changelog's only entry point.
//
// Tooltip content is refreshed from BuildInfo whenever the async metadata
// fetch settles. Until then only the version line shows; the badge is
// mounted before the fetch resolves on purpose so its own visible label
// never waits on the network.

import { VERSION } from '../config/Version.js';
import { BuildInfo } from '../config/BuildInfo.js';
import { ChangelogPanel } from './ChangelogPanel.js';

const BADGE_ID = 'versionBadge';

export class VersionBadge {
  constructor() {
    this.el = null;
    this._pillEl = null;
    this._tooltipEl = null;
    this._observers = [];
    this._watched = [];
    this._unsubBuild = null;
    this._changelog = null;
  }

  mount(parent = document.body) {
    if (this.el) return this;

    // --- container ---
    // The container is invisible (pointer-events:none, no background); it
    // exists only to position the pill and anchor the tooltip above it.
    // Events are attached to the pill directly so the invisible tooltip
    // region never captures hover.
    const el = document.createElement('div');
    el.id = BADGE_ID;
    el.style.cssText = [
      'position:fixed',
      'left:8px',
      'bottom:8px',
      // z-index 2000: same tier as the FPS counter, above every overlay
      // in the game — HUD (10), bars (15/16), topBar (20), main menu
      // (30), pause menu (90), settings panel (100), battle result
      // overlay (1000). The badge is only shown while a watched menu
      // element is on screen, so at this tier it is always drawn OVER
      // the overlay that caused it to appear.
      'z-index:2000',
      'pointer-events:none',
      'user-select:none',
      'display:none'
    ].join(';');

    // --- tooltip (above the pill, hidden until hover) ---
    // Styled to match the pill exactly: same font, size, colours, border,
    // radius. Slightly more opaque background so text stays readable over
    // a bright menu panel.
    const tooltip = document.createElement('div');
    tooltip.style.cssText = [
      'position:absolute',
      'left:0',
      'bottom:100%',
      'margin-bottom:6px',
      'padding:4px 9px',
      'background:rgba(20,30,45,0.92)',
      'border:1px solid #3a4a5e',
      'border-radius:4px',
      'font-family:monospace',
      'font-size:11px',
      'letter-spacing:1px',
      'color:#cdd6e2',
      'white-space:pre',
      'pointer-events:none',
      'display:none',
      'box-shadow:0 4px 12px rgba(0,0,0,0.45)'
    ].join(';');

    // --- pill (the visible label; the thing hovered and clicked) ---
    const pill = document.createElement('div');
    pill.textContent = `${VERSION.name} v${VERSION.number}`;
    pill.style.cssText = [
      'padding:3px 8px',
      'background:rgba(20,30,45,0.78)',
      'border:1px solid #3a4a5e',
      'border-radius:4px',
      'font-family:monospace',
      'font-size:11px',
      'letter-spacing:1px',
      'color:#cdd6e2',
      'pointer-events:auto',
      'cursor:pointer'
    ].join(';');

    pill.addEventListener('mouseenter', () => {
      tooltip.style.display = 'block';
    });
    pill.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      // Hide the tooltip on open so it does not float over the changelog
      // panel's top edge if the pointer happens not to move afterwards.
      tooltip.style.display = 'none';
      this._openChangelog();
    });

    el.appendChild(tooltip);
    el.appendChild(pill);
    parent.appendChild(el);

    this.el = el;
    this._pillEl = pill;
    this._tooltipEl = tooltip;

    // Kick off the (async) fetch and refresh the tooltip once it lands.
    // BuildInfo.load() is idempotent, so it is safe if another module
    // already asked for it. _refreshTooltip() is called synchronously
    // first so the tooltip is populated with the version line while the
    // fetch is in flight.
    this._unsubBuild = BuildInfo.subscribe(() => this._refreshTooltip());
    BuildInfo.load();
    this._refreshTooltip();

    // The top-level menu is present in the DOM from page load. The pause
    // menu is not yet constructed when mount() runs; main.js calls
    // watch() on it after constructing the panel.
    this.watch(document.getElementById('mainMenu'));

    return this;
  }

  // Register a DOM element whose visibility should drive the badge's own.
  // Idempotent per element: calling watch() twice on the same node adds
  // only one observer. Returns `this` so calls can be chained.
  watch(el) {
    if (!el || this._watched.includes(el)) return this;
    this._watched.push(el);

    const observer = new MutationObserver(() => this._syncVisibility());
    // Both 'class' and 'style' are observed: #mainMenu is toggled by class
    // ('hidden') while PauseMenuPanel toggles inline style.display. The
    // visibility check below handles both forms.
    observer.observe(el, {
      attributes: true,
      attributeFilter: ['class', 'style']
    });
    this._observers.push(observer);

    this._syncVisibility();
    return this;
  }

  // Rebuild the tooltip text from the current VERSION + BuildInfo values.
  // Called once at mount and again when BuildInfo settles.
  _refreshTooltip() {
    if (!this._tooltipEl) return;
    const lines = [`${VERSION.name} v${VERSION.number}`];
    if (BuildInfo.buildNo) lines.push(`Build: ${BuildInfo.buildNo}`);
    if (BuildInfo.lastUpdated) lines.push(`Updated: ${BuildInfo.lastUpdated}`);
    this._tooltipEl.textContent = lines.join('\n');
  }

  // Lazily construct the changelog panel on first click. Building it up
  // front would cost a DOM node per page load that most sessions never
  // open; constructing on demand keeps the boot path quiet.
  _openChangelog() {
    if (!this._changelog) this._changelog = new ChangelogPanel();
    this._changelog.open();
  }

  // Visible when ANY watched element is showing. Element visibility is
  // checked against both supported toggling conventions: a 'hidden' class
  // on the node, and an inline style.display of 'none'.
  _syncVisibility() {
    if (!this.el) return;
    const anyVisible = this._watched.some(el => isElementVisible(el));
    this.el.style.display = anyVisible ? 'block' : 'none';
    // If we just hid, drop the tooltip so it does not linger if the badge
    // reappears later with the pointer still over the same screen
    // position (mouseenter will not re-fire on a stale tooltip).
    if (anyVisible === false && this._tooltipEl) {
      this._tooltipEl.style.display = 'none';
    }
  }

  unmount() {
    for (const o of this._observers) o.disconnect();
    this._observers = [];
    this._watched = [];
    if (this._unsubBuild) { this._unsubBuild(); this._unsubBuild = null; }
    if (this._changelog) { this._changelog.dispose(); this._changelog = null; }
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
    this.el = null;
    this._pillEl = null;
    this._tooltipEl = null;
  }
}

// True when the element is on screen per the conventions this game uses:
// not carrying the 'hidden' class and not carrying an inline display of
// 'none'. Anything else (no class, no inline style, or a non-none inline
// display) reads as visible.
function isElementVisible(el) {
  if (!el) return false;
  if (el.classList.contains('hidden')) return false;
  if (el.style.display === 'none') return false;
  return true;
}
// ===== CommandBarView.js =====
// Player-facing command bar that sits directly above the army bar.
//
//   FIRE AT WILL (toggle) — green when on, red when off. Enabled only when
//     at least one selected unit is ranged; toggles every selected ranged
//     unit's fireAtWill flag. Melee units in the selection are ignored.
//   STOP — cancels any move/attack order and reforms the formation around
//     the unit's current position. Engaged soldiers keep fighting (stop is
//     not a retreat); only march/attack orders cancel.
//
// Both buttons are icon-only (inline SVG); the human-readable label lives
// in the button's title/tooltip.
//
// Responsiveness: all visual state lives in a stylesheet (injected once),
// and update() only rewrites the DOM when something actually changed.
// Earlier versions wrote background/borderColor inline every frame, which
// overrode the browser's :hover and :active states — the button looked
// dead because nothing moved on interaction. Now hover brightens and
// press translates, both driven by CSS.
//
// Positioning: bar is position:fixed and its `bottom` is recomputed every
// render frame from the army bar's actual rendered rect. A getBoundingClientRect
// on a small element is cheap and always reflects the current layout, so
// the command bar stays flush above the army bar even as the army bar
// grows, wraps, or loses units.
//
// Pure UI. Reads a Set<Unit> passed in each frame; dispatches callbacks.
// Sim-side mutations live on Unit (fireAtWill field, stopOrder method).

import { isRanged } from '../config/UnitClasses.js';

// --- icons -----------------------------------------------------------------
// 22px line icons, currentColor so they inherit the button's text colour.

const ICON_BOW = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <path d="M6 3 Q20 12 6 21" fill="none" stroke="currentColor" stroke-width="2.2"/>
  <line x1="6" y1="3" x2="6" y2="21" stroke="currentColor" stroke-width="1.6"/>
  <line x1="4" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.6"/>
  <polygon points="21,12 17,10 17,14" fill="currentColor"/>
</svg>`;

const ICON_STOP = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <path fill="currentColor" d="M 9 22 C 5.5 22 4 20 4 17 V 12 C 4 11.2 4.7 10.5 5.5 10.5 C 6.3 10.5 7 11.2 7 12 V 13 V 6 C 7 5 7.7 4.3 8.5 4.3 C 9.3 4.3 10 5 10 6 V 12 V 3.5 C 10 2.5 10.7 1.8 11.5 1.8 C 12.3 1.8 13 2.5 13 3.5 V 12 V 4.5 C 13 3.5 13.7 2.8 14.5 2.8 C 15.3 2.8 16 3.5 16 4.5 V 13 V 9 C 16 8.2 16.7 7.5 17.5 7.5 C 18.3 7.5 19 8.2 19 9 V 16 C 19 20 17.5 22 14 22 Z"/>
</svg>`;

// Injected once per page. Kept inline rather than a separate .css file so
// the component is self-contained (matching PauseMenuPanel/SettingsPanel).
// The FAW on/off backgrounds are the whole signal for that button's state;
// hover only brightens, active only translates — neither changes the
// state colour.
const STYLE_ID = 'command-bar-view-styles';
const STYLE_TEXT = `
  .cmd-btn {
    padding: 6px 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #e8e8e8;
    background: #2a2f3a;
    border: 1px solid #384050;
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    pointer-events: auto;
    box-shadow: 0 2px 6px rgba(0,0,0,0.35);
    font-family: inherit;
    transition: background 0.08s ease, border-color 0.08s ease,
                transform 0.05s ease, filter 0.08s ease;
  }
  .cmd-btn:disabled {
    opacity: 0.4;
    /* Disabled <button> elements swallow mouse events entirely in every
       major browser — the event does not bubble, so a window-level mouseup
       listener never fires. If a rectangle-select drag happens to end over
       one of these buttons, SelectionController would never see the
       mouseup and the selection box would freeze on screen. Setting
       pointer-events: none makes the button transparent to hit-testing,
       so the mouseup falls through to the canvas and bubbles to window
       as usual. cursor: not-allowed is dropped because it cannot apply
       to a non-hit-testable element. */
    pointer-events: none;
  }
  .cmd-btn:not(:disabled):hover {
    filter: brightness(1.25);
  }
  .cmd-btn:not(:disabled):active {
    transform: translateY(1px);
    filter: brightness(0.92);
  }
  .cmd-btn.faw-on {
    background: #2e7d32;
    border-color: #1b5e20;
    color: #ffffff;
  }
  .cmd-btn.faw-off {
    background: #8a2a2a;
    border-color: #b04a4a;
    color: #ffffff;
  }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_TEXT;
  document.head.appendChild(el);
}

export class CommandBarView {
  // `belowElement` is the DOM element this bar sits on top of — normally
  // the army bar container. When supplied, the bar's bottom offset is
  // computed to sit just above that element's top edge. When omitted, the
  // bar pins to the bottom of the viewport.
  constructor(rootElement, belowElement = null) {
    ensureStyles();

    this.root = rootElement;
    this._belowElement = belowElement;

    // Callbacks assigned by main.js.
    //   onSetFireAtWill(newState:boolean) — apply to every selected ranged unit
    //   onStop()                          — apply stopOrder() to every selected unit
    this.onSetFireAtWill = null;
    this.onStop = null;

    // Group FAW state — true when every selected ranged unit has
    // fireAtWill on. Only updated when it actually changes (see _syncState),
    // because writing the state class every frame would clobber the
    // browser's :hover / :active visual state.
    this._fawActive = false;

    // Cached previous-frame state. update() compares against this and only
    // touches the DOM when something changed. null on the first frame so
    // the first update() applies everything.
    this._lastFawActive = null;
    this._lastFawDisabled = null;
    this._lastStopDisabled = null;

    // --- Root layout ---
    Object.assign(this.root.style, {
      position: 'fixed',
      left: '0',
      right: '0',
      // bottom set by _syncPosition() every frame
      zIndex: '16', // above armyBar (15), below pause menu (90)
      display: 'flex',
      justifyContent: 'center',
      gap: '6px',
      padding: '4px 8px',
      boxSizing: 'border-box',
      pointerEvents: 'none', // let clicks pass through the bar's padding
      fontFamily: 'inherit'
    });

    this._fawBtn = this._buildButton('Fire at Will: Off', ICON_BOW, () => {
      if (this._fawBtn.disabled) return;
      const newState = !this._fawActive;
      if (this.onSetFireAtWill) this.onSetFireAtWill(newState);
    });

    this._stopBtn = this._buildButton('Stop', ICON_STOP, () => {
      if (this._stopBtn.disabled) return;
      if (this.onStop) this.onStop();
    });

    this.root.appendChild(this._fawBtn);
    this.root.appendChild(this._stopBtn);

    // Default state, applied once so the first paint is correct. update()
    // will reconcile against this on the next frame.
    this._fawBtn.disabled = true;
    this._stopBtn.disabled = true;
    this._applyFawState(false);
    this._lastFawDisabled = true;
    this._lastStopDisabled = true;

    this._syncPosition();
  }

  // Called every render frame by main.js with the current selection
  // (a Set<Unit> — same object HudView receives). Recomputes the bar's
  // position, then the buttons' state — but only touches the DOM when
  // something actually changed, so hover/active CSS on the buttons is not
  // overwritten mid-interaction.
  update(selectedUnits) {
    this._syncPosition();

    const units = selectedUnits ? Array.from(selectedUnits) : [];
    const hasSelection = units.length > 0;

    // Partition by ranged capability. Unit has no unitTypeDef — the type
    // lives on each soldier (see ArmyBarView._installIcon for the same
    // lookup).
    let rangedCount = 0;
    let allRangedOn = true;
    for (const u of units) {
      const lead = u.soldiers && u.soldiers[0];
      if (!lead || !lead.unitTypeDef || !isRanged(lead.unitTypeDef)) continue;
      rangedCount++;
      if (!u.fireAtWill) allRangedOn = false;
    }

    // FAW is only meaningful when a ranged unit is selected. Stop is
    // available whenever there is any selection at all.
    const fawDisabled = rangedCount === 0;
    const stopDisabled = !hasSelection;
    const fawActive = rangedCount > 0 && allRangedOn;

    // Only write to the DOM when something changed. Skipping the redundant
    // writes is what keeps the CSS :hover / :active pseudo-classes from
    // being stomped by an inline style write every frame.
    if (fawDisabled !== this._lastFawDisabled) {
      this._fawBtn.disabled = fawDisabled;
      this._lastFawDisabled = fawDisabled;
    }
    if (stopDisabled !== this._lastStopDisabled) {
      this._stopBtn.disabled = stopDisabled;
      this._lastStopDisabled = stopDisabled;
    }
    if (fawActive !== this._lastFawActive) {
      this._applyFawState(fawActive);
      this._lastFawActive = fawActive;
    }
  }

  dispose() {
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }

  // --- internals ----------------------------------------------------------

  _syncPosition() {
    if (!this._belowElement) {
      this.root.style.bottom = '0';
      return;
    }
    // Distance from the viewport bottom to the TOP of the element we sit
    // above, plus a small gap so the two bars do not visually touch.
    const rect = this._belowElement.getBoundingClientRect();
    const gapFromViewportBottom = window.innerHeight - rect.bottom;
    const GAP_PX = 6;
    this.root.style.bottom =
      `${gapFromViewportBottom + rect.height + GAP_PX}px`;
  }

  // Toggle the FAW button's state class. Called only when the state
  // actually changes (see update()), which is why it can safely rewrite
  // className — no risk of clobbering a transient :hover / :active class
  // the browser is managing.
  _applyFawState(active) {
    this._fawActive = active;
    this._fawBtn.title = active ? 'Fire at Will: On' : 'Fire at Will: Off';
    this._fawBtn.classList.toggle('faw-on', active);
    this._fawBtn.classList.toggle('faw-off', !active);
  }

  _buildButton(title, svgHtml, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cmd-btn';
    btn.title = title;
    btn.innerHTML = svgHtml;
    btn.addEventListener('click', onClick);
    return btn;
  }
}
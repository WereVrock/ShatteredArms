// ===== CommandBarView.js =====
// Player-facing command bar that sits directly above the army bar.
//
//   FIRE AT WILL (toggle) — green when on, red when off. Enabled only when
//     at least one selected unit is ranged; toggles every selected ranged
//     unit's fireAtWill flag. Melee units in the selection are ignored.
//   RUSH / ORDERLY — global movement mode.
//   RUN (toggle) — runs the selected units that can run. Crew-served units
//     (goblin megabowmen) are NOT handled by it: for them the crew run
//     button replaces it (see below), and the Run button is hidden when
//     only crew units are selected.
//   CREW RUN (toggle) — shown while a crew unit is selected. It is the run
//     switch of a crew unit: on = the shooters run ahead of their carriers
//     (the carriers follow on foot). Forced on and disabled once every
//     carrier is dead. See CrewPairing.
//   LEAVE BATTLE — available for every selected unit, any time. Two clicks:
//     the first arms the button (red), the second within LEAVE_CONFIRM_MS
//     confirms. The unit withdraws off the nearest map edge and returns for
//     the next campaign battle (see BattleWithdrawal).
//   STOP — cancels any move/attack order and reforms the formation around
//     the unit's current position. Engaged soldiers keep fighting (stop is
//     not a retreat); only march/attack orders cancel.
//
// All buttons are icon-only (inline SVG); the human-readable label lives
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
// Sim-side mutations live on Unit (fireAtWill field, stopOrder method,
// setCrewDontWait, leaveBattle).

import { isRanged } from '../config/UnitClasses.js';
import { SettingsStore } from './settings/SettingsStore.js';
import { Gait } from '../sim/Gait.js';
import { CrewPairing } from '../sim/CrewPairing.js';

// Time (ms) the Leave battle button stays armed after its first click.
const LEAVE_CONFIRM_MS = 2500;

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

// Rush mode: a double chevron pointing right, reads as "fast forward".
// Plain directional glyph rather than a running figure so it stays legible
// at button size.
const ICON_RUSH = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <polyline points="4,7 12,12 4,17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="12,7 20,12 12,17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Orderly mode: a 2x3 grid of dots, reads as a ranked formation.
const ICON_ORDERLY = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <rect x="5"  y="4"  width="4" height="4" fill="currentColor"/>
  <rect x="15" y="4"  width="4" height="4" fill="currentColor"/>
  <rect x="5"  y="10" width="4" height="4" fill="currentColor"/>
  <rect x="15" y="10" width="4" height="4" fill="currentColor"/>
  <rect x="5"  y="16" width="4" height="4" fill="currentColor"/>
  <rect x="15" y="16" width="4" height="4" fill="currentColor"/>
</svg>`;

// Run toggle: a running figure. Also used by the crew run button.
const ICON_RUN = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <circle cx="15" cy="4.5" r="2.2" fill="currentColor"/>
  <path d="M13 8 L9 12 L12 14 L10 20 M13 8 L16 12 L19 11 M12 14 L16 16 L16 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Recall hounds: a paw print.
const ICON_HOUND = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <ellipse cx="12" cy="16" rx="5" ry="4" fill="currentColor"/>
  <circle cx="5.5" cy="11" r="2" fill="currentColor"/>
  <circle cx="9.5" cy="6.5" r="2" fill="currentColor"/>
  <circle cx="14.5" cy="6.5" r="2" fill="currentColor"/>
  <circle cx="18.5" cy="11" r="2" fill="currentColor"/>
</svg>`;

// Abandon chargob beasts: a broken chain.
const ICON_ABANDON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <path d="M9 7 H6.5 A4.5 4.5 0 0 0 6.5 16 H9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M15 7 H17.5 A4.5 4.5 0 0 1 17.5 16 H15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
  <line x1="12" y1="3" x2="12" y2="21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="2 3"/>
</svg>`;

// Units whose run switch is a button of their own: crew units (crew run
// button) and chargob units until their beasts are abandoned (abandon button).
function hasOwnRunSwitch(u) {
  return CrewPairing.isCrewUnit(u) || (u.companionKind === 'chargob' && !u.chargobAbandoned);
}

// Chargob charge: three chevrons pointing forward.
const ICON_CHARGE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <path d="M3 8 L8 12 L3 16 M10 6 L16 12 L10 18 M17 4 L22 12 L17 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Leave battle: an arrow leaving a frame.
const ICON_LEAVE = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <path d="M10 4 H5 V20 H10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="9" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
  <polyline points="16,8 20,12 16,16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
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
  /* Rush / Orderly movement mode. Deliberately different hues from the
     FAW on/off pair so the two toggles read as distinct controls. Rush
     is warm (aggressive); orderly is cool (disciplined). Hover / active
     still come from the shared .cmd-btn rules — these classes only set
     the resting state colour. */
  .cmd-btn.rush-on {
    background: #b85a2a;
    border-color: #d07840;
    color: #ffffff;
  }
  /* Run toggle (also the crew run button). Only the on state is coloured;
     off is the plain button. */
  .cmd-btn.run-on {
    background: #6a3fa0;
    border-color: #8a63c0;
    color: #ffffff;
  }
  .cmd-btn.rush-off {
    background: #3a5570;
    border-color: #5a7590;
    color: #ffffff;
  }
  /* Leave battle, armed: the next click confirms. */
  .cmd-btn.leave-armed {
    background: #a02a2a;
    border-color: #d05a5a;
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

    // Callbacks assigned by main.js. All optional: when absent, the
    // built-in default applies the action to the selected units directly.
    //   onSetFireAtWill(newState:boolean) — apply to every selected ranged unit
    //   onStop()                          — apply stopOrder() to every selected unit
    //   onSetRun(newState:boolean)        — run toggle (non-crew units)
    //   onSetCrewDontWait(newState)       — crew run toggle
    //   onLeaveBattle()                   — withdraw every selected unit
    this.onSetFireAtWill = null;
    this.onStop = null;
    this.onSetRun = null;
    this.onSetCrewDontWait = null;
    this.onLeaveBattle = null;

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

    this._selected = [];
    this._runActive = false;
    this._lastRunActive = null;
    this._lastRunDisabled = null;
    this._lastRunHidden = false;

    this._crewToggleActive = false;
    this._lastCrewShown = false;
    this._lastCrewToggleDisabled = null;
    this._lastCrewToggleActive = null;

    this._leaveArmedUntil = 0;
    this._leaveArmedKey = '';
    this._lastLeaveDisabled = null;
    this._lastLeaveArmed = null;

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

    // Rush / Orderly movement mode. Binary GLOBAL toggle — it reads and
    // writes SettingsStore.rushMode directly and never depends on the
    // current selection, so it stays clickable with nothing selected.
    // The button shows the CURRENT mode; clicking switches to the other.
    //
    // OrderDragController._resolveDirectMarch() reads the same store key
    // on every right-mouse-down, so a click here takes effect on the very
    // next order with no additional plumbing.
    this._rushBtn = this._buildButton('Movement: Orderly', ICON_ORDERLY, () => {
      const s = SettingsStore.get();
      SettingsStore.set('rushMode', !s.rushMode);
    });

    this._runBtn = this._buildButton('Run: Off', ICON_RUN, () => {
      if (this._runBtn.disabled) return;
      this._setRun(!this._runActive);
    });

    // Crew run button. Replaces the Run button for crew-served units; hidden
    // unless a crew unit is selected.
    this._crewBtn = this._buildButton('Leave carrier', ICON_RUN, () => {
      if (this._crewBtn.disabled) return;
      this._setCrewDontWait(!this._crewToggleActive);
    });
    this._crewBtn.style.display = 'none';
    this._crewBtn.disabled = true;

    // Leave battle, any unit, two clicks (arm, then confirm).
    this._leaveBtn = this._buildButton('Leave battle', ICON_LEAVE, () => {
      if (this._leaveBtn.disabled) return;
      const now = performance.now();
      if (this._leaveArmedUntil > now) {
        this._leaveArmedUntil = 0;
        this._refreshLeave();
        this._leaveBattle();
      } else {
        this._leaveArmedUntil = now + LEAVE_CONFIRM_MS;
        this._leaveArmedKey = this._selectionKey(this._selected);
        this._refreshLeave();
      }
    });
    this._leaveBtn.disabled = true;

    this.root.appendChild(this._fawBtn);
    this.root.appendChild(this._rushBtn);
    this.root.appendChild(this._runBtn);
    this.root.appendChild(this._crewBtn);
    // Recall hounds. Shown while a unit with hounds is selected; enabled
    // while some of its hounds are attacking within recall range.
    this.onRecallHounds = null;
    this._lastHoundShown = false;
    this._lastHoundDisabled = null;
    this._houndBtn = this._buildButton('Recall hounds', ICON_HOUND, () => {
      if (this._houndBtn.disabled) return;
      this._recallHounds();
    });
    this._houndBtn.style.display = 'none';
    this._houndBtn.disabled = true;

    this.root.appendChild(this._houndBtn);

    // Chargob charge. Shown while a chargob unit is selected. Left click: one
    // more beast to goad into a charge; right click: one fewer. The badge
    // shows how many are queued.
    this.onAdjustCharge = null;
    this._lastChargeShown = false;
    this._lastChargeDisabled = null;
    this._lastChargeKey = '';
    this._chargeBtn = this._buildButton('Goad chargobs', ICON_CHARGE, () => {
      if (this._chargeBtn.disabled) return;
      this._adjustCharge(1);
    });
    this._chargeBtn.style.display = 'none';
    this._chargeBtn.style.position = 'relative';
    this._chargeBtn.disabled = true;
    this._chargeBadge = document.createElement('span');
    Object.assign(this._chargeBadge.style, {
      position: 'absolute',
      right: '3px',
      top: '0',
      fontSize: '11px',
      fontWeight: '700',
      color: '#ffd88a',
      pointerEvents: 'none'
    });
    this._chargeBtn.appendChild(this._chargeBadge);
    this._chargeBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this._chargeBtn.disabled) this._adjustCharge(-1);
    });
    this.root.appendChild(this._chargeBtn);

    // Abandon chargob beasts. Replaces the Run button for chargob units until
    // used. One-way: the beasts leave the player's control, the handlers may
    // run afterwards.
    this.onAbandonBeasts = null;
    this._lastAbandonShown = false;
    this._abandonBtn = this._buildButton(
      'Abandon chargob beasts: they stop obeying and run wild once the handlers have moved away. Cannot be undone.',
      ICON_ABANDON,
      () => {
        if (this._abandonBtn.disabled) return;
        this._abandonBeasts();
      }
    );
    this._abandonBtn.style.display = 'none';
    this._abandonBtn.disabled = true;
    this.root.appendChild(this._abandonBtn);
    this.root.appendChild(this._leaveBtn);
    this.root.appendChild(this._stopBtn);

    // Keep the rush button in sync with the store. Fires on every
    // SettingsStore.set(), including the click above and any future
    // programmatic flip (a settings-panel entry, a preset, etc). The
    // initial _applyRushState() call runs once now so the very first
    // painted frame already has the right icon, tooltip and state class.
    this._unsubSettings = SettingsStore.subscribe(() => this._applyRushState());
    this._applyRushState();

    // Default state, applied once so the first paint is correct. update()
    // will reconcile against this on the next frame.
    this._fawBtn.disabled = true;
    this._stopBtn.disabled = true;
    this._applyFawState(false);
    this._lastFawDisabled = true;
    this._lastStopDisabled = true;
    this._runBtn.disabled = true;
    this._applyRunState(false);
    this._lastRunDisabled = true;
    this._lastRunActive = false;
    this._lastLeaveDisabled = true;
    this._refreshLeave();

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
    this._selected = units;

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

    // Run applies to selected units that can run (foot skeletons cannot).
    // Crew units are excluded: their run switch is the crew button.
    let runCapable = 0;
    let allRunOn = true;
    for (const u of units) {
      if (CrewPairing.isCrewUnit(u)) continue;
      if (!Gait.unitCanRun(u)) continue;
      runCapable++;
      if (!u.runEnabled) allRunOn = false;
    }
    const runDisabled = runCapable === 0;
    const runActive = runCapable > 0 && allRunOn;
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
    if (runDisabled !== this._lastRunDisabled) {
      this._runBtn.disabled = runDisabled;
      this._lastRunDisabled = runDisabled;
    }
    if (runActive !== this._lastRunActive) {
      this._applyRunState(runActive);
      this._lastRunActive = runActive;
    }
    if (fawActive !== this._lastFawActive) {
      this._applyFawState(fawActive);
      this._lastFawActive = fawActive;
    }

    this._updateCrewButton(units);
    this._updateLeaveButton(units);
    this._updateHoundButton(units);
    this._updateChargeButton(units);
    this._updateAbandonButton(units);
  }

  dispose() {
    if (this._unsubSettings) {
      this._unsubSettings();
      this._unsubSettings = null;
    }
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

  // Rush mode: every player-issued move / formation order commits with
  // directMarch, so soldiers walk straight to their final slots and skip
  // the en-route formation assembly entirely. Orderly mode (the default):
  // direct march only for the order that came from a right-click
  // double-click, and only if doubleClickDirectMarch is on.
  //
  // Writes all three visual channels — icon, tooltip, state class — in
  // one place so they cannot drift apart. Called from the settings
  // subscription and once from the constructor. Never called from
  // update(); the button has no per-frame state.
  _applyRushState() {
    const rush = SettingsStore.get().rushMode === true;
    this._rushBtn.title = rush
      ? 'Movement mode: RUSH — units walk straight to their slots'
      : 'Movement mode: ORDERLY — units form up en route (double-click for direct march)';
    this._rushBtn.innerHTML = rush ? ICON_RUSH : ICON_ORDERLY;
    this._rushBtn.classList.toggle('rush-on', rush);
    this._rushBtn.classList.toggle('rush-off', !rush);
  }

  _applyRunState(active) {
    this._runActive = active;
    this._runBtn.title = active
      ? 'Run: On — units run on move orders. Tires troops faster; spearmen raise their spears.'
      : 'Run: Off — units walk';
    this._runBtn.classList.toggle('run-on', active);
  }

  // Crew run button. State comes from CrewPairing; this method only mirrors
  // it into the DOM, and only when something changed. Also hides the plain
  // Run button while only crew units are selected (the crew button replaces
  // it).
  _updateCrewButton(units) {
    let crewCount = 0;
    let canToggle = 0;
    let allActiveToggleable = true;
    let allActiveAny = true;
    for (const u of units) {
      if (!CrewPairing.isCrewUnit(u)) continue;
      crewCount++;
      const st = CrewPairing.dontWaitState(u);
      if (!st.active) allActiveAny = false;
      if (st.enabled) {
        canToggle++;
        if (!st.active) allActiveToggleable = false;
      }
    }

    const showCrew = crewCount > 0;
    const onlyCrew = units.length > 0 && units.every(hasOwnRunSwitch);
    const toggleDisabled = canToggle === 0;
    const toggleActive = showCrew && (canToggle > 0 ? allActiveToggleable : allActiveAny);
    this._crewToggleActive = toggleActive;

    if (showCrew !== this._lastCrewShown) {
      this._crewBtn.style.display = showCrew ? '' : 'none';
      this._lastCrewShown = showCrew;
    }
    if (onlyCrew !== this._lastRunHidden) {
      this._runBtn.style.display = onlyCrew ? 'none' : '';
      this._lastRunHidden = onlyCrew;
    }
    if (toggleDisabled !== this._lastCrewToggleDisabled) {
      this._crewBtn.disabled = toggleDisabled;
      this._lastCrewToggleDisabled = toggleDisabled;
    }
    if (toggleActive !== this._lastCrewToggleActive) {
      this._crewBtn.classList.toggle('run-on', toggleActive);
      this._crewBtn.title = toggleActive
        ? 'Leave carrier: On — the shooters run ahead, the carriers follow on foot'
        : 'Leave carrier: Off — the whole unit moves at the carriers\' pace';
      this._lastCrewToggleActive = toggleActive;
    }
  }

  // Leave battle button: enabled when at least one selected unit can leave.
  // A pending confirmation is dropped when it expires, when the button gets
  // disabled, or when the selection changes.
  _updateLeaveButton(units) {
    let canLeave = 0;
    for (const u of units) {
      if (u.canLeaveBattle && u.canLeaveBattle()) canLeave++;
    }
    const disabled = canLeave === 0;
    let dirty = false;

    if (disabled !== this._lastLeaveDisabled) {
      this._leaveBtn.disabled = disabled;
      this._lastLeaveDisabled = disabled;
      if (disabled) this._leaveArmedUntil = 0;
      dirty = true;
    }

    if (this._leaveArmedUntil > 0) {
      const expired = this._leaveArmedUntil <= performance.now();
      const changed = this._leaveArmedKey !== this._selectionKey(units);
      if (expired || changed) {
        this._leaveArmedUntil = 0;
        dirty = true;
      }
    }

    if (dirty) this._refreshLeave();
  }

  _updateHoundButton(units) {
    let withHounds = 0;
    let canRecall = 0;
    for (const u of units) {
      if (!u.companions || u.companions.length === 0 || u.companionKind === 'chargob') continue;
      withHounds++;
      if (u.canRecallHounds()) canRecall++;
    }
    const shown = withHounds > 0;
    const disabled = canRecall === 0;
    if (shown !== this._lastHoundShown) {
      this._houndBtn.style.display = shown ? '' : 'none';
      this._lastHoundShown = shown;
    }
    if (disabled !== this._lastHoundDisabled) {
      this._houndBtn.disabled = disabled;
      this._houndBtn.title = disabled
        ? 'Recall hounds: no hound is attacking within recall range'
        : 'Recall hounds: the attacking hounds in range return to their handlers';
      this._lastHoundDisabled = disabled;
    }
  }

  // Charge button: shown while a chargob unit is selected, enabled while a
  // beast is left in the line. The numbers come from Unit.chargobInfo.
  _updateChargeButton(units) {
    let chargobUnits = 0;
    let available = 0;
    let wanted = 0;
    for (const u of units) {
      if (u.companionKind !== 'chargob') continue;
      const info = u.chargobInfo();
      chargobUnits++;
      available += info.available;
      wanted += info.wanted;
    }

    const shown = chargobUnits > 0;
    const disabled = available === 0;
    const key = wanted + '/' + available;

    if (shown !== this._lastChargeShown) {
      this._chargeBtn.style.display = shown ? '' : 'none';
      this._lastChargeShown = shown;
    }
    if (disabled !== this._lastChargeDisabled) {
      this._chargeBtn.disabled = disabled;
      this._lastChargeDisabled = disabled;
    }
    if (key !== this._lastChargeKey) {
      this._chargeBadge.textContent = wanted > 0 ? String(wanted) : '';
      this._chargeBtn.classList.toggle('run-on', wanted > 0);
      this._chargeBtn.title = 'Goad chargobs: left click sends one more beast charging '
        + '(three handlers must prod it from behind for two seconds), right click cancels one. '
        + 'Queued ' + wanted + ', beasts in line ' + available;
      this._lastChargeKey = key;
    }
  }

  // Shown while a selected chargob unit still has beasts to abandon.
  _updateAbandonButton(units) {
    let can = 0;
    for (const u of units) {
      if (u.canAbandonBeasts && u.canAbandonBeasts()) can++;
    }
    const shown = can > 0;
    if (shown !== this._lastAbandonShown) {
      this._abandonBtn.style.display = shown ? '' : 'none';
      this._abandonBtn.disabled = !shown;
      this._lastAbandonShown = shown;
    }
  }

  _abandonBeasts() {
    if (this.onAbandonBeasts) {
      this.onAbandonBeasts();
      return;
    }
    for (const u of this._selected) {
      if (u.canAbandonBeasts && u.canAbandonBeasts()) u.abandonBeasts();
    }
  }

  _adjustCharge(delta) {
    if (this.onAdjustCharge) {
      this.onAdjustCharge(delta);
      return;
    }
    for (const u of this._selected) {
      if (u.companionKind === 'chargob') u.adjustChargeCount(delta);
    }
  }

  _recallHounds() {
    if (this.onRecallHounds) {
      this.onRecallHounds();
      return;
    }
    for (const u of this._selected) {
      if (u.recallHounds) u.recallHounds();
    }
  }

  _selectionKey(units) {
    let key = '';
    for (const u of units) key += u.id + ',';
    return key;
  }

  // Writes the Leave button's armed class and tooltip.
  _refreshLeave() {
    const armed = this._leaveArmedUntil > performance.now();
    this._lastLeaveArmed = armed;
    this._leaveBtn.classList.toggle('leave-armed', armed);
    if (this._leaveBtn.disabled) {
      this._leaveBtn.title = 'Leave battle: select a unit first';
    } else if (armed) {
      this._leaveBtn.title = 'Click again to confirm: the unit withdraws and is kept for the next battle';
    } else {
      this._leaveBtn.title = 'Leave battle: the unit withdraws off the nearest map edge and is kept for the next battle';
    }
  }

  _setRun(newState) {
    if (this.onSetRun) {
      this.onSetRun(newState);
      return;
    }
    for (const u of this._selected) {
      if (!CrewPairing.isCrewUnit(u) && Gait.unitCanRun(u)) u.setRunEnabled(newState);
    }
  }

  _setCrewDontWait(newState) {
    if (this.onSetCrewDontWait) {
      this.onSetCrewDontWait(newState);
      return;
    }
    for (const u of this._selected) {
      if (CrewPairing.isCrewUnit(u)) u.setCrewDontWait(newState);
    }
  }

  _leaveBattle() {
    if (this.onLeaveBattle) {
      this.onLeaveBattle();
      return;
    }
    for (const u of this._selected) {
      if (u.canLeaveBattle && u.canLeaveBattle()) u.leaveBattle();
    }
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
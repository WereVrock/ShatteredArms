// Compact, antique-styled power indicator pinned to the top-right corner,
// directly below the FPS counter. Composed of three independent parts:
//
//   BalanceScaleView  -- brass balance whose beam tilts toward the losing
//                        side
//   SwordGaugeView    -- two swords that shatter, tip first, as each
//                        team's power drops below its starting power
//   PowerReadoutView  -- text: units and power (now / start) per team,
//                        plus the power ratio
//
// This class is the orchestrator: it owns the corner container, the
// visibility rules and the click behaviour, and feeds the parts from
// PowerTracker. It holds no rendering detail of its own.
//
// Visibility has TWO gates:
//   1. show()/hide() from the battle flow (deployment, battle).
//   2. SettingsStore.showPowerScale / showPowerSwords, toggled from
//      Settings -> UI. The widget is on screen only when the battle flow
//      allows it AND at least one of the two gauges is enabled.
//
// Click behaviour (only while the widget is on screen):
//   - Clicking it EXPANDS it: whichever gauge is not enabled in settings
//     appears underneath the enabled one (so one enabled gauge shows both
//     on click), and the numbers readout appears under the gauges.
//   - Clicking anywhere outside the widget collapses it again.
//
// Layout order, top to bottom: the enabled gauge first (scale first when
// both are enabled), the other gauge, then the readout.
//
// Pure UI. Reads simulation.units via PowerTracker, writes its own DOM,
// holds no sim references between frames.
import { SettingsStore } from './settings/SettingsStore.js';
import { PowerTracker } from './powerbalance/PowerTracker.js';
import { BalanceScaleView } from './powerbalance/BalanceScaleView.js';
import { SwordGaugeView } from './powerbalance/SwordGaugeView.js';
import { PowerReadoutView } from './powerbalance/PowerReadoutView.js';
import {
  WIDGET_WIDTH, LEFT_TEAM, RIGHT_TEAM, px
} from './powerbalance/PowerWidgetTheme.js';

export class PowerBalanceView {
  constructor() {
    // _visible is the reconciled result of the two gates; kept so
    // _applyLayout can short-circuit root display writes.
    this._visible = false;
    this._desiredVisible = false;
    this._scaleSetting = false;
    this._swordsSetting = false;
    this._readSettings();

    // Click-to-expand state: the extra gauge plus the numbers readout.
    this._expanded = false;

    this.tracker = new PowerTracker();
    this.scale = new BalanceScaleView();
    this.swords = new SwordGaugeView();
    this.readout = new PowerReadoutView();

    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position:fixed',
      'top:34px',
      'right:8px',
      'width:' + px(WIDGET_WIDTH),
      'z-index:14',
      // pointer-events must be auto so the click-to-expand handler fires.
      // The widget occupies a small top-right rectangle well clear of any
      // other interactive UI, so it does not need to be click-through.
      'pointer-events:auto',
      'cursor:pointer',
      'user-select:none',
      'display:none',
      'flex-direction:column',
      'align-items:center',
      'gap:4px'
    ].join(';');
    this.root.appendChild(this.scale.el);
    this.root.appendChild(this.swords.el);
    this.root.appendChild(this.readout.el);

    // Click the widget to expand. Idempotent: a second click does NOT
    // collapse it -- the "click somewhere else" handler below is the only
    // path that does. That avoids the jarring case where a double-click
    // immediately re-hides what the first click just opened.
    this.root.addEventListener('click', () => this._expand());

    // Document-level collapse listener. The contains() check covers every
    // child (gauges and readout), so clicking inside the widget does NOT
    // dismiss it -- only clicks genuinely outside do.
    this._onDocClick = (e) => {
      if (!this._expanded) return;
      if (this.root.contains(e.target)) return;
      this._collapse();
    };
    document.addEventListener('click', this._onDocClick);

    // Settings gate. Re-read on every settings change so a flip from the
    // panel is reflected immediately without any plumbing in main.js.
    this._unsubSettings = SettingsStore.subscribe(() => {
      this._readSettings();
      this._applyLayout();
    });

    this._applyLayout();

    document.body.appendChild(this.root);
  }

  // Reads simulation.units, updates the tracker, and feeds all parts.
  // Every part is cheap to feed while hidden (the swords only touch the
  // DOM when their broken-shard count changes; the readout only when its
  // text changes), so a gauge that is revealed mid-battle already shows
  // the whole battle so far, not "since the click".
  update(units) {
    this.tracker.update(units);

    const cur = this.tracker.current;
    this.scale.setPower(cur[LEFT_TEAM].power, cur[RIGHT_TEAM].power);
    this.swords.setRatios(
      this.tracker.startRatio(LEFT_TEAM),
      this.tracker.startRatio(RIGHT_TEAM)
    );
    if (this._expanded) this._refreshReadout();
  }

  // Frame-rate animation for the scale's beam.
  tick() {
    this.scale.tick();
  }

  // Battle flow asks for the widget to be on. Actual visibility also
  // depends on the settings gate -- see _applyLayout.
  show() {
    this._desiredVisible = true;
    this._applyLayout();
  }

  // Battle flow asks for the widget to be off. Also collapses it -- the
  // widget being gone makes the extras unreachable anyway, and leaving
  // them "open" would pop them back the moment the widget returns.
  hide() {
    this._desiredVisible = false;
    this._expanded = false;
    this._applyLayout();
  }

  // Re-baseline. Call on battle restart so the first update of the new
  // fight captures a fresh 100% instead of comparing against the previous
  // battle's opening. Safe to call at any time.
  reset() {
    this.tracker.reset();
    this.scale.reset();
    this.swords.setRatios(1, 1);
    if (this._expanded) this._refreshReadout();
  }

  dispose() {
    document.removeEventListener('click', this._onDocClick);
    if (this._unsubSettings) this._unsubSettings();
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }

  // --- visibility / layout ---------------------------------------------------

  _readSettings() {
    const s = SettingsStore.get();
    this._scaleSetting = !!s.showPowerScale;
    this._swordsSetting = !!s.showPowerSwords;
  }

  _expand() {
    if (this._expanded) return;
    this._expanded = true;
    this._applyLayout();
  }

  _collapse() {
    if (!this._expanded) return;
    this._expanded = false;
    this._applyLayout();
  }

  // Single place that reconciles every visibility rule.
  _applyLayout() {
    const anyEnabled = this._scaleSetting || this._swordsSetting;
    const visible = this._desiredVisible && anyEnabled;
    this._visible = visible;
    // A widget that is off screen is never "expanded"; reopening it does
    // NOT auto-expand -- that is a deliberate user action.
    if (!visible) this._expanded = false;

    const expanded = this._expanded;
    this.root.style.display = visible ? 'flex' : 'none';

    this.scale.setVisible(visible && (this._scaleSetting || expanded));
    this.swords.setVisible(visible && (this._swordsSetting || expanded));
    this.readout.setVisible(expanded);

    // The enabled gauge goes on top. Swords go first only when they are
    // the sole enabled gauge; with both enabled the scale stays on top.
    const swordsFirst = this._swordsSetting && !this._scaleSetting;
    this.scale.el.style.order  = swordsFirst ? '2' : '1';
    this.swords.el.style.order = swordsFirst ? '1' : '2';
    this.readout.el.style.order = '3';

    if (expanded) this._refreshReadout();
  }

  _refreshReadout() {
    this.readout.update(this.tracker.current, this.tracker.start);
  }
}
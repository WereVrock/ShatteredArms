// The antique balance: two small colored pans hang from a pivoting brass
// beam; the beam tilts toward whichever side is losing. No numbers, no
// labels -- the reading is (a) which side is up, and (b) how far
// off-level the beam is.
//
// Style: warm brass and bronze rather than cold steel. Aged-metal
// gradients, a dark patina under the highlights, and a heavier visual
// weight so the widget reads as a small solid object (a hand-held
// balance, a coin-scale) rather than as a modern UI element.
//
// Reading model:
//   - Beam tilt = power balance. Positive angle = clockwise rotation =
//     right side down = right team losing. Beam level = dead even.
//   - Tilt is amplified nonlinearly (TILT_CURVE < 1) so a small imbalance
//     reads clearly off-level instead of looking nearly flat.
//   - Pan brightness scales with that team's power share. A team losing
//     badly fades toward dark; a dominant team stays lit. Second,
//     redundant channel to the same message.
//
// Pure presentation. The owner feeds it power numbers via setPower(),
// calls tick() once per frame, and shows/hides it via setVisible().
import {
  WIDGET_WIDTH, LEFT_TEAM, RIGHT_TEAM, TEAM_COLOR, TEAM_COLOR_DARK,
  BRASS_LIGHT, BRASS_MID, BRASS_DARK, PATINA, px
} from './PowerWidgetTheme.js';

// --- layout --------------------------------------------------------------
const HEIGHT = 76;

const PIVOT_X = WIDGET_WIDTH / 2;
const PIVOT_Y = 24;

const BEAM_HALF = 32;
const PAN_HANG  = 8;    // distance below the beam end where the pan's top sits
const PAN_W     = 18;
const PAN_H     = 13;

// Maximum beam tilt at extreme imbalance. 38 degrees reads as visibly
// off-level even at this size.
const MAX_TILT_DEG = 38;

// Nonlinear amplification applied to the normalized imbalance before
// scaling by MAX_TILT_DEG. Values below 1.0 push small imbalances toward
// the extremes -- a 55:45 split already shows meaningful tilt.
const TILT_CURVE = 0.55;

// Beam-angle animation. Fraction of remaining gap closed each frame.
const FADE_SMOOTHING = 0.18;

// Pan brightness floor at zero power share. 0.32 keeps a losing team's
// color recognizable while making the difference between the two sides
// obvious.
const BRIGHTNESS_MIN = 0.32;

export class BalanceScaleView {
  constructor() {
    this._angleDeg = 0;
    this._targetAngleDeg = 0;
    this._hasUpdated = false;

    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:relative',
      'flex:none',
      'width:' + px(WIDGET_WIDTH),
      'height:' + px(HEIGHT),
      'display:none'
    ].join(';');

    this._buildStand();
    this._buildBase();
    this._buildBeam();
    this._buildBeamCaps();
    this._buildPans();
    this._buildPivot();
  }

  setVisible(visible) {
    this.el.style.display = visible ? 'block' : 'none';
  }

  // Sets the beam's *target* angle and the pan brightness from the two
  // teams' power. tick() animates toward the target.
  setPower(leftPower, rightPower) {
    const total = leftPower + rightPower;

    // Normalized imbalance: 0 = even, +1 = all right team, -1 = all left.
    let imbalance = 0;
    if (total > 0) imbalance = (rightPower - leftPower) / total;

    // Nonlinear amplification. Sign preserved; magnitude pushed toward
    // the extremes so small imbalances produce visible tilt.
    const amplified = Math.sign(imbalance) *
      Math.pow(Math.abs(imbalance), TILT_CURVE);
    this._targetAngleDeg = amplified * MAX_TILT_DEG;

    // Snap on the first frame -- otherwise the beam swings in from level
    // on frame 1 of a battle that opens lopsided.
    if (!this._hasUpdated) {
      this._angleDeg = this._targetAngleDeg;
      this._hasUpdated = true;
    }

    // Pan brightness from share. Second channel to the same reading.
    const leftShare  = total > 0 ? leftPower / total : 0.5;
    const rightShare = total > 0 ? rightPower / total : 0.5;
    const leftBrightness  = BRIGHTNESS_MIN + leftShare  * (1 - BRIGHTNESS_MIN);
    const rightBrightness = BRIGHTNESS_MIN + rightShare * (1 - BRIGHTNESS_MIN);
    this.pans[LEFT_TEAM].style.filter  =
      'brightness(' + leftBrightness.toFixed(3) + ')';
    this.pans[RIGHT_TEAM].style.filter =
      'brightness(' + rightBrightness.toFixed(3) + ')';
  }

  // Frame-rate animation: advance beam angle, rotate the beam, reposition
  // the beam-end caps and the two pans to hang from the beam's ends.
  tick() {
    const delta = this._targetAngleDeg - this._angleDeg;
    if (Math.abs(delta) < 0.02) {
      this._angleDeg = this._targetAngleDeg;
    } else {
      this._angleDeg += delta * FADE_SMOOTHING;
    }

    this.beam.style.transform =
      'rotate(' + this._angleDeg.toFixed(3) + 'deg)';

    // Closed form of "hang a pan from the end of a beam rotated by
    // angle". Pans are NOT parented to the beam, so they stay upright
    // without a counter-rotation.
    const angleRad = this._angleDeg * Math.PI / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const leftEndX  = PIVOT_X - BEAM_HALF * cos;
    const leftEndY  = PIVOT_Y - BEAM_HALF * sin;
    const rightEndX = PIVOT_X + BEAM_HALF * cos;
    const rightEndY = PIVOT_Y + BEAM_HALF * sin;

    // Beam-end caps: small brass knobs straddling each beam end.
    const capHalf = 2;
    this.leftCap.style.left  = px((leftEndX  - capHalf).toFixed(2));
    this.leftCap.style.top   = px((leftEndY  - capHalf).toFixed(2));
    this.rightCap.style.left = px((rightEndX - capHalf).toFixed(2));
    this.rightCap.style.top  = px((rightEndY - capHalf).toFixed(2));

    // Pans hang below the caps.
    this.pans[LEFT_TEAM].style.left  = px((leftEndX  - PAN_W / 2).toFixed(2));
    this.pans[LEFT_TEAM].style.top   = px((leftEndY  + PAN_HANG).toFixed(2));
    this.pans[RIGHT_TEAM].style.left = px((rightEndX - PAN_W / 2).toFixed(2));
    this.pans[RIGHT_TEAM].style.top  = px((rightEndY + PAN_HANG).toFixed(2));
  }

  // Next setPower() snaps the beam instead of swinging it. Call on battle
  // restart.
  reset() {
    this._hasUpdated = false;
  }

  // --- builders ----------------------------------------------------------

  _buildStand() {
    const el = document.createElement('div');
    const bg = 'linear-gradient(90deg,' +
      BRASS_LIGHT + ' 0%,' +
      BRASS_MID + ' 30%,' +
      BRASS_DARK + ' 100%)';
    el.style.cssText = [
      'position:absolute',
      'left:' + px(PIVOT_X - 2),
      'top:' + px(PIVOT_Y),
      'width:4px',
      'height:' + px(HEIGHT - PIVOT_Y - 6),
      'background:' + bg,
      'border-radius:1px',
      'box-shadow:0 1px 2px rgba(0,0,0,0.55)',
      'z-index:1'
    ].join(';');
    this.el.appendChild(el);
  }

  _buildBase() {
    const el = document.createElement('div');
    const bg = 'linear-gradient(180deg,' +
      BRASS_MID + ' 0%,' +
      BRASS_DARK + ' 60%,' +
      PATINA + ' 100%)';
    el.style.cssText = [
      'position:absolute',
      'left:' + px(PIVOT_X - 13),
      'top:' + px(HEIGHT - 6),
      'width:26px',
      'height:5px',
      'background:' + bg,
      'border-radius:2px 2px 3px 3px',
      'box-shadow:0 1px 3px rgba(0,0,0,0.55)',
      'z-index:1'
    ].join(';');
    this.el.appendChild(el);
  }

  _buildBeam() {
    const bg = 'linear-gradient(90deg,' +
      BRASS_MID + ' 0%,' +
      BRASS_LIGHT + ' 45%,' +
      BRASS_LIGHT + ' 55%,' +
      BRASS_MID + ' 100%)';
    this.beam = document.createElement('div');
    this.beam.style.cssText = [
      'position:absolute',
      'left:' + px(PIVOT_X - BEAM_HALF),
      'top:' + px(PIVOT_Y - 1.5),
      'width:' + px(BEAM_HALF * 2),
      'height:3px',
      'background:' + bg,
      'border:0.5px solid ' + BRASS_DARK,
      'border-radius:1px',
      'transform-origin:center center',
      'box-shadow:0 1px 2px rgba(0,0,0,0.5)',
      'z-index:2'
    ].join(';');
    this.el.appendChild(this.beam);
  }

  _buildBeamCaps() {
    this.leftCap  = this._buildBeamCap();
    this.rightCap = this._buildBeamCap();
    this.el.appendChild(this.leftCap);
    this.el.appendChild(this.rightCap);
  }

  _buildBeamCap() {
    const el = document.createElement('div');
    const bg = 'radial-gradient(circle at 35% 30%,' +
      BRASS_LIGHT + ' 0%,' +
      BRASS_MID + ' 60%,' +
      BRASS_DARK + ' 100%)';
    el.style.cssText = [
      'position:absolute',
      'width:4px',
      'height:4px',
      'border-radius:50%',
      'background:' + bg,
      'box-shadow:0 1px 2px rgba(0,0,0,0.5)',
      'z-index:3'
    ].join(';');
    return el;
  }

  _buildPans() {
    this.pans = {};
    this.pans[LEFT_TEAM]  = this._buildPan(LEFT_TEAM);
    this.pans[RIGHT_TEAM] = this._buildPan(RIGHT_TEAM);
    this.el.appendChild(this.pans[LEFT_TEAM]);
    this.el.appendChild(this.pans[RIGHT_TEAM]);
  }

  // One pan: a shallow dish in the team's color. Asymmetric radii -- gentle
  // on the top, tighter on the bottom -- so the silhouette curves inward
  // at the base like a bowl rather than reading as a flat tile.
  _buildPan(teamId) {
    const light = TEAM_COLOR[teamId];
    const dark  = TEAM_COLOR_DARK[teamId];
    const el = document.createElement('div');

    // Both gradients live in ONE `background` declaration. In CSS, the
    // first-listed background layer is drawn ON TOP of the ones after it,
    // so the highlight/shadow overlay goes first and the team-colour
    // gradient sits underneath. Setting `background` and then
    // `background-image` as separate declarations would NOT stack them --
    // the second assignment replaces the first outright.
    const bg =
      'linear-gradient(180deg,' +
        'rgba(255,255,255,0.30) 0%,' +
        'rgba(255,255,255,0.00) 42%,' +
        'rgba(0,0,0,0.32) 100%)' +
      ',' +
      'linear-gradient(180deg,' + light + ' 0%,' + dark + ' 100%)';

    const shadow = '0 0 0 0.5px ' + BRASS_DARK + ',' +
      'inset 0 1px 0 rgba(255,220,150,0.30),' +
      'inset 0 -1px 2px rgba(0,0,0,0.42),' +
      '0 1px 2px rgba(0,0,0,0.5)';

    el.style.cssText = [
      'position:absolute',
      'width:' + px(PAN_W),
      'height:' + px(PAN_H),
      'border-radius:3px 3px 6px 6px',
      'background:' + bg,
      'box-shadow:' + shadow,
      'z-index:2',
      'will-change:filter'
    ].join(';');
    return el;
  }

  _buildPivot() {
    const pivot = document.createElement('div');
    const pivotBg = 'radial-gradient(circle at 38% 32%,' +
      BRASS_LIGHT + ' 0%,' +
      BRASS_MID + ' 55%,' +
      BRASS_DARK + ' 100%)';
    const pivotShadow = '0 1px 3px rgba(0,0,0,0.55),' +
      'inset 0 -1px 1px rgba(0,0,0,0.35),' +
      'inset 0 1px 1px rgba(255,220,150,0.35)';
    pivot.style.cssText = [
      'position:absolute',
      'left:' + px(PIVOT_X - 6),
      'top:' + px(PIVOT_Y - 6),
      'width:12px',
      'height:12px',
      'border-radius:50%',
      'background:' + pivotBg,
      'border:1px solid ' + PATINA,
      'box-shadow:' + pivotShadow,
      'z-index:4'
    ].join(';');
    this.el.appendChild(pivot);

    // Inner pivot dot -- the "pin" the beam rests on.
    const dot = document.createElement('div');
    dot.style.cssText = [
      'position:absolute',
      'left:' + px(PIVOT_X - 2),
      'top:' + px(PIVOT_Y - 2),
      'width:4px',
      'height:4px',
      'border-radius:50%',
      'background:' + BRASS_DARK,
      'box-shadow:inset 0 0.5px 0.5px rgba(255,220,150,0.4)',
      'z-index:5'
    ].join(';');
    this.el.appendChild(dot);
  }
}
// ===== src/render/ShieldBillboard.js =====
// One sprite that carries a unit's entire world-space marker: horizontal
// HP / morale / stamina bars stacked above a team-coloured banner whose
// face shows the unit's composite silhouette.
//
// CANVAS LAYOUT
//   Canvas: 128 x 200 px.
//     y =   4..18   champion HP bar slot (drawn only when the unit
//                   carries a champion)
//     y =  26..40   morale bar slot
//     y =  48..62   stamina bar slot
//     y =  72..200  banner, drawn by compositing the shared per-piece
//                   textures from ShieldIconBuilder.js
//
// DIRTY-CHECKED REDRAW
// update() is called every frame but only repaints the canvas when an
// actual visual value changes — bar fill quantised to 2%, morale band,
// broken-piece bitmask, champion presence. A stable unit's canvas is
// not repainted.
//
// DISTANCE SCALING
// The sprite's world scale is derived from the camera-to-banner distance
// by worldScaleForDistance(). This is the standard Total War behaviour:
// distant banners grow in world space so their SCREEN size stays roughly
// constant, close banners shrink slightly so they do not dominate the
// screen. The scaling is gentle and clamps at both ends — see
// BANNER_SCALE_MIN / BANNER_SCALE_MAX below.
//
// SIZE SCALING
// On top of distance scaling, the player can pick a banner size
// (small / medium / large — a HUD-density setting, see SettingsStore).
// Applied via setSizeMultiplier(); the two factors MULTIPLY, so the
// distance formula still applies, just around a larger or smaller base.
// The bottom edge of the shield is anchored at a fixed world Y (see
// SHIELD_ANCHOR_OFFSET and UnitOverlayView's SHIELD_BOTTOM_Y), so a
// large banner grows UPWARD and clear of soldier heads rather than
// dipping into them.
//
// PIECE BREAKING
// breakPiece(i) marks band i as lost and forces a redraw. The banner is
// then composited from the remaining pieces.
import * as THREE from 'three';
import {
  getShieldEntry,
  SHIELD_PIECE_COUNT
} from './ShieldIconBuilder.js';

// --- canvas geometry -------------------------------------------------------

const CANVAS_W = 128;
const CANVAS_H = 200;

const BAR_LEFT   = 14;
const BAR_W      = CANVAS_W - BAR_LEFT * 2;   // 100
const BAR_H      = 14;

const SLOT_CHAMPION_Y = 4;
const SLOT_MORALE_Y   = 26;
const SLOT_FATIGUE_Y  = 48;

const SHIELD_TOP_PX  = 72;
const SHIELD_SIZE_PX = 128;   // matches ShieldIconBuilder's texture size

// --- base world sizing -----------------------------------------------------
//
// Base banner world footprint at factor 1.0 (distance reference), size
// multiplier 1.0 (medium). The shield occupies the bottom 128 px of the
// 200-tall canvas, so the shield's world HEIGHT equals SHIELD_WORLD_SIZE
// exactly — the aspect ratio of the piece textures and the sprite's
// drawn region conspire to make the numbers line up.
export const SHIELD_WORLD_SIZE = 1.8;

export const SPRITE_WORLD_W = SHIELD_WORLD_SIZE;
export const SPRITE_WORLD_H = (CANVAS_H / CANVAS_W) * SHIELD_WORLD_SIZE;

// Vertical pixel distance from the canvas CENTRE (where the sprite's
// local origin sits) down to the shield's own centre. Positive because
// the shield sits below the canvas centre.
const SHIELD_CENTER_FROM_CANVAS_CENTER_PX =
  (SHIELD_TOP_PX + SHIELD_SIZE_PX / 2) - CANVAS_H / 2;

// Same distance in world units at factor 1, sizeMult 1. This is the
// offset from sprite origin DOWN to shield centre, matching the current
// canvas layout — kept exported for compatibility.
export const SPRITE_LOCAL_Y_OFFSET =
  SHIELD_CENTER_FROM_CANVAS_CENTER_PX / CANVAS_W * SHIELD_WORLD_SIZE;

// Shield's own world half-height at factor 1, sizeMult 1. Because the
// shield is square in canvas space (128 × 128 px) and its world width
// equals SPRITE_WORLD_W, its world half-height equals SHIELD_WORLD_SIZE/2.
const SHIELD_HALF_HEIGHT_BASE = SHIELD_WORLD_SIZE / 2;

// Distance from the SHIELD's bottom edge UP to the sprite's origin at
// factor 1, sizeMult 1. Used by UnitOverlayView via getAnchorOffset()
// to pin the shield bottom at a fixed world Y — this is what prevents a
// growing banner from clipping into soldier heads.
//
// = shield half-height (bottom → shield centre)
// + sprite-local Y offset (shield centre → sprite origin)
const SHIELD_ANCHOR_OFFSET = SHIELD_HALF_HEIGHT_BASE + SPRITE_LOCAL_Y_OFFSET;

// --- banner size --------------------------------------------------------
//
// Maps the 'bannerSize' setting to a sprite-scale multiplier. Multiplied
// on top of the distance factor, so the chosen size is the "constant
// screen size" the distance formula holds the banner at. The three tiers
// are chosen so small is still legible, medium matches the previous
// fixed size, and large is noticeably prominent without dominating the
// soldier line below.
// Five tiers, geometrically spaced (~1.35-1.4 ratio per step). The
// 'small' tier at 1.0 is the canonical visual size — the original
// three-tier scheme's 'medium'. Old names map one tier forward: old
// small (0.7) -> tiny, old medium (1.0) -> small, old large (1.4) ->
// medium. 'large' (1.9) and 'huge' (2.5) are new higher tiers.
const BANNER_SIZE_MULTIPLIERS = Object.freeze({
  tiny:   0.7,
  small:  1.0,
  medium: 1.4,
  large:  1.9,
  huge:   2.5
});

// Pure helper. Unknown / absent values fall back to 1.0 (medium) so a
// legacy save or a typo can't accidentally shrink the banner to nothing.
export function bannerSizeMultiplier(sizeName) {
  return BANNER_SIZE_MULTIPLIERS[sizeName] ?? 1.0;
}

// --- distance scaling ------------------------------------------------------
//
// Total War formula, gently tuned:
//
//   scaleFactor = clamp( distance / BANNER_REF_DIST,
//                        BANNER_SCALE_MIN,
//                        BANNER_SCALE_MAX )
//
// At the reference distance the banner is at its base world size. Closer
// than the reference it shrinks (so it does not wall off the view when
// zoomed in); farther it grows (so distant units stay legible). The
// ratio is linear, clamped at both ends — adjust the clamps, not the
// ratio, to tune behaviour.
export const BANNER_REF_DIST = 45;
export const BANNER_SCALE_MIN = 0.75;
export const BANNER_SCALE_MAX = 1.40;

// --- bar colours -----------------------------------------------------------

const MORALE_COLORS = {
  full:     '#4a9a4a',
  hurt:     '#b09040',
  critical: '#a04040'
};
const FATIGUE_COLOR  = '#b09050';
const CHAMPION_COLOR = '#c23a3a';
const BAR_BG_COLOR   = 'rgba(0, 0, 0, 0.65)';
const BAR_OUTLINE    = 'rgba(0, 0, 0, 0.85)';

export class ShieldBillboard {
  constructor(typeDef, isUndead, teamId, isThrall = false) {
    this._entry = getShieldEntry(typeDef, isUndead, teamId, isThrall);
    // Per-chunk break thresholds, indexed by chunk. Read by
    // UnitOverlayView when deciding which chunks to break at the
    // unit's current HP.
    this.thresholds = this._entry.thresholds;

    this._canvas = document.createElement('canvas');
    this._canvas.width = CANVAS_W;
    this._canvas.height = CANVAS_H;
    this._ctx = this._canvas.getContext('2d');

    this._texture = new THREE.CanvasTexture(this._canvas);
    if (THREE.SRGBColorSpace !== undefined) this._texture.colorSpace = THREE.SRGBColorSpace;
    this._texture.minFilter = THREE.LinearFilter;
    this._texture.magFilter = THREE.LinearFilter;
    this._texture.generateMipmaps = false;

    this.material = new THREE.SpriteMaterial({
      map: this._texture,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false
    });

    this.sprite = new THREE.Sprite(this.material);
    // Base scale at factor 1, sizeMult 1. The distance + size multipliers
    // are applied on top of this by _applyScale.
    this.sprite.scale.set(SPRITE_WORLD_W, SPRITE_WORLD_H, 1);
    this._worldScale = 1;
    this._sizeMultiplier = 1;

    // Broken-piece bitmask; bit i set = piece i has been lost.
    this._brokenMask = 0;

    // Dirty-check signature. Null forces the next update to redraw.
    this._signature = null;
  }

  getPieceTexture(index) {
    return this._entry.pieces[index];
  }

  breakPiece(index) {
    this._brokenMask |= (1 << index);
    this._signature = null;
  }

  isPieceBroken(index) {
    return (this._brokenMask & (1 << index)) !== 0;
  }

  // --- scale management --------------------------------------------------

  // Distance-driven world scale. The caller passes in the camera-to-
  // banner distance (world units); this stores the derived factor and
  // re-applies the combined sprite scale.
  setWorldScale(distance) {
    const factor = ShieldBillboard.worldScaleForDistance(distance);
    if (factor === this._worldScale) return;
    this._worldScale = factor;
    this._applyScale();
  }

  // Player-chosen banner size multiplier. See bannerSizeMultiplier for
  // how the setting string maps here.
  setSizeMultiplier(mult) {
    if (mult === this._sizeMultiplier) return;
    this._sizeMultiplier = mult;
    this._applyScale();
  }

  _applyScale() {
    const s = this._worldScale * this._sizeMultiplier;
    this.sprite.scale.set(
      SPRITE_WORLD_W * s,
      SPRITE_WORLD_H * s,
      1
    );
  }

  // World-unit offset from the SHIELD's bottom edge to the sprite's
  // origin, at the billboard's current combined scale. The caller adds
  // this to the fixed world Y of the shield's bottom edge (2.0 — see
  // UnitOverlayView.SHIELD_BOTTOM_Y) to get the sprite's world Y.
  getAnchorOffset() {
    return SHIELD_ANCHOR_OFFSET * this._worldScale * this._sizeMultiplier;
  }

  // World-unit offset from the SHIELD's bottom edge to the shield's
  // visual centre, at the current combined scale. Used by UnitOverlayView
  // to place falling shards (which start at the shield's centre) and the
  // shatter burst origin.
  getShieldCenterOffset() {
    return SHIELD_HALF_HEIGHT_BASE * this._worldScale * this._sizeMultiplier;
  }

  // Pure helper for the Total War-style distance scale. Kept static so
  // callers can compute the factor without an instance.
  static worldScaleForDistance(distance) {
    if (!Number.isFinite(distance) || distance <= 0) return 1;
    const t = distance / BANNER_REF_DIST;
    return Math.max(BANNER_SCALE_MIN, Math.min(BANNER_SCALE_MAX, t));
  }

  // --- update ------------------------------------------------------------

  update({
    moraleFrac, moraleBand, fatigueFrac,
    hasChampion, championFrac,
    pulseOpacity, showBars
  }) {
    // 2% quantisation on the bar fills so per-tick drift does not
    // trigger a redraw for values the eye cannot see change.
    const sig = [
      Math.round(moraleFrac * 50),
      moraleBand,
      Math.round(fatigueFrac * 50),
      hasChampion ? 1 : 0,
      hasChampion ? Math.round(championFrac * 50) : -1,
      this._brokenMask,
      // Bumped by ShieldIconBuilder when the async icon blit lands, so
      // the billboard composites the updated piece textures on its next
      // update.
      this._entry.version,
      showBars ? 1 : 0
    ].join('|');

    if (sig !== this._signature) {
      this._signature = sig;
      this._redraw(
        moraleFrac, moraleBand, fatigueFrac,
        hasChampion, championFrac,
        showBars
      );
    }

    this.material.opacity = pulseOpacity;
  }

  dispose() {
    this._texture.dispose();
    this.material.dispose();
  }

  // --- drawing -----------------------------------------------------------

  _redraw(moraleFrac, moraleBand, fatigueFrac, hasChampion, championFrac, showBars) {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Bar slots are drawn only for units that should show bars (player
    // team, showUnitBars on, unit not shattered). Enemy units get a
    // banner-only billboard with a fully transparent upper half.
    if (showBars) {
      if (hasChampion) {
        this._drawBar(SLOT_CHAMPION_Y, championFrac, CHAMPION_COLOR);
      }
      this._drawBar(SLOT_MORALE_Y, moraleFrac, MORALE_COLORS[moraleBand] || MORALE_COLORS.full);
      this._drawBar(SLOT_FATIGUE_Y, fatigueFrac, FATIGUE_COLOR);
    }

    this._drawShield();

    this._texture.needsUpdate = true;
  }

  _drawBar(y, frac, color) {
    const ctx = this._ctx;
    const clamped = Math.max(0, Math.min(1, frac || 0));

    ctx.fillStyle = BAR_BG_COLOR;
    ctx.fillRect(BAR_LEFT, y, BAR_W, BAR_H);

    if (clamped > 0) {
      ctx.fillStyle = color;
      ctx.fillRect(BAR_LEFT, y, BAR_W * clamped, BAR_H);
    }

    ctx.strokeStyle = BAR_OUTLINE;
    ctx.lineWidth = 1;
    ctx.strokeRect(BAR_LEFT + 0.5, y + 0.5, BAR_W - 1, BAR_H - 1);
  }

  _drawShield() {
    const ctx = this._ctx;
    for (let i = 0; i < SHIELD_PIECE_COUNT; i++) {
      if (this._brokenMask & (1 << i)) continue;
      // Every piece texture is CANVAS-sized (SHIELD_SIZE_PX²) and carries
      // only its own band's content at the correct y-offset, so drawing
      // all unbroken pieces at the same origin composites them into a
      // full banner.
      const tex = this._entry.pieces[i];
      ctx.drawImage(tex.image, 0, SHIELD_TOP_PX, SHIELD_SIZE_PX, SHIELD_SIZE_PX);
    }
  }
}
// ===== src/render/ShieldBillboard.js =====
// One sprite that carries a unit's entire world-space marker: horizontal
// HP / morale / stamina bars stacked above a team-coloured shield whose
// face shows the unit's composite icon.
//
// WHY A SINGLE SPRITE
// The bars and the shield used to be separate THREE.Sprite objects, each
// billboarded independently. That produced correct per-object facing,
// but the composition read as a loose stack of floating panels rather
// than one coherent marker. Baking everything into ONE canvas and using
// ONE sprite means the whole marker rotates with the camera as a single
// unit — bars, shield, and icon stay rigidly aligned from any angle.
//
// CANVAS LAYOUT
//   Canvas: 128 x 200 px.
//     y =   4..18   champion HP bar slot (drawn only when the unit
//                   carries a champion)
//     y =  26..40   morale bar slot
//     y =  48..62   stamina bar slot
//     y =  72..200  shield, drawn by compositing the shared per-piece
//                   textures from ShieldIconBuilder.js
//
// DIRTY-CHECKED REDRAW
// update() is called every frame but only repaints the canvas when an
// actual visual value changes — bar fill quantised to 2%, morale band,
// broken-piece bitmask, champion presence. A stable unit's canvas is
// not repainted, which is what makes "one sprite with a canvas" cheap
// enough to use per-unit.
//
// PIECE BREAKING
// breakPiece(i) marks band i as lost and forces a redraw. The shield is
// then composited from the remaining pieces. The caller is responsible
// for spawning the fall animation as a separate transient sprite — the
// billboard only owns the STATIC shield state.
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

// --- world sizing ----------------------------------------------------------
//
// The shield texture is 128 px and was previously rendered as a 0.9×0.9
// world sprite. Keeping that as the shield's world footprint preserves
// the marker's on-screen scale; the extra canvas height above the shield
// (the bar slots) is accounted for by the SPRITE_WORLD_H / Y-OFFSET
// constants below.

export const SHIELD_WORLD_SIZE = 0.9;

export const SPRITE_WORLD_W = SHIELD_WORLD_SIZE;
export const SPRITE_WORLD_H = (CANVAS_H / CANVAS_W) * SHIELD_WORLD_SIZE;

// Vertical pixel distance from the canvas CENTRE (where the sprite's
// local origin sits) down to the shield's own centre. Positive because
// the shield sits below the canvas centre.
const SHIELD_CENTER_FROM_CANVAS_CENTER_PX =
  (SHIELD_TOP_PX + SHIELD_SIZE_PX / 2) - CANVAS_H / 2;

// Same distance in world units. The caller adds this to the desired
// world Y of the SHIELD's centre to get the sprite's origin Y.
export const SPRITE_LOCAL_Y_OFFSET =
  SHIELD_CENTER_FROM_CANVAS_CENTER_PX / CANVAS_W * SHIELD_WORLD_SIZE;

// --- bar colours -----------------------------------------------------------
//
// Matches the sprite-material colours the previous implementation used,
// so the on-screen palette does not change.
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
  // typeDef + isUndead + teamId select the shared per-piece shield
  // textures. Each billboard owns its OWN canvas, so bar values and
  // broken-piece state are independent per unit; only the shield
  // texture data itself is shared.
  constructor(typeDef, isUndead, teamId, isThrall = false) {
    this._entry = getShieldEntry(typeDef, isUndead, teamId, isThrall);
    // Per-chunk break thresholds, indexed by chunk. Derived from each
    // chunk's area and its distance from the shield's centre (see
    // ShieldIconBuilder.computeThresholds). Read by UnitOverlayView
    // when deciding which chunks to break at the unit's current HP.
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
    this.sprite.scale.set(SPRITE_WORLD_W, SPRITE_WORLD_H, 1);

    // Broken-piece bitmask; bit i set = piece i has been lost.
    this._brokenMask = 0;

    // Dirty-check signature. Null forces the next update to redraw.
    this._signature = null;
  }

  // Returns the shared CanvasTexture for one shield band. Used by the
  // caller to spawn a falling-piece sprite on the frame the band breaks.
  getPieceTexture(index) {
    return this._entry.pieces[index];
  }

  // Marks band `index` as lost. The next update() redraws without it.
  breakPiece(index) {
    this._brokenMask |= (1 << index);
    this._signature = null;
  }

  isPieceBroken(index) {
    return (this._brokenMask & (1 << index)) !== 0;
  }

  // Feeds the current bar values into the canvas. Redraws are dirty-
  // checked so calling this every frame is cheap.
  //
  //   moraleFrac   — 0..1
  //   moraleBand   — 'full' | 'hurt' | 'critical'
  //   fatigueFrac  — 0..1
  //   hasChampion  — whether the unit carries a living champion
  //   championFrac — 0..1, ignored unless hasChampion
  //   pulseOpacity — sprite opacity for the collapse pulse (1 = normal)
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
      // update. Without this the shield stayed icon-less: the piece
      // textures updated, but the billboard's own canvas had already
      // been drawn and had no reason to redraw.
      this._entry.version,
      // Whether the bar slots are drawn at all. Enemy units pass false
      // — their billboard is shield-only. Included in the signature so
      // a team-change or a settings flip triggers a redraw.
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
    // shield-only billboard with a fully transparent upper half.
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
      // full shield.
      const tex = this._entry.pieces[i];
      ctx.drawImage(tex.image, 0, SHIELD_TOP_PX, SHIELD_SIZE_PX, SHIELD_SIZE_PX);
    }
  }
}
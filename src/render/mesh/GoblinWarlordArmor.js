// ===== src/render/mesh/GoblinWarlordArmor.js =====
// Metal armor, a hooded cowl, and a team-coloured tabard for the Goblin
// Warlord — a unique character, not a rank-and-file type.
//
// WHY A SEPARATE MODULE
// GoblinWarlordBuilder owns the body: proportions, posture, silhouette.
// Costume is a different concern and must not know the wearer's leg
// length. This module asks for measurements only — the waist line, the
// chest profile, the head anchor — and returns pieces the caller parents
// to the right rig groups.
//
// PIECES
//   cuirass (pivot-local): a partial lathe over the chest, plus a pair of
//     shoulder pauldrons. Follows the wearer's own chest profile with a
//     fixed outward pad, so it hugs a tapering torso exactly.
//   belt (body-space): a slim metal ring at the waist.
//   hood (body-space): a custom parametric shell — NOT a lathe. A lathe
//     is a surface of revolution, so its back can only ever read as a
//     rounded half-cylinder. This build instead applies a per-phi
//     "backness" boost: the top-back is lifted into a peak (slanted
//     silhouette from the side, not a dome), and the bottom-back extends
//     further out and down into a hanging cowl. The face gap is pinched
//     closed above the brow line, so the crown and forehead are fully
//     covered — the opening only exists where the face actually is.
//   cape (body-space): a tapered open cylinder wrapping the back and
//     sides.
//   tabard (body-space): a short cloth skirt hanging from the belt, in
//     team colour.
//
// HERALDRY — BAKED INTO TEXTURES
// The Warlord's heraldic device (a three-pronged war-crown, flanked by
// curled wings and topped by a flourish on the hood; a vertical spine
// stripe and two flanking crowns on the cape) is drawn into a per-team
// CANVAS TEXTURE applied to the shell itself. There is no separate
// heraldry mesh, no separate trim mesh, no separate hood-ornaments mesh —
// each garment is one mesh with one material, and the heraldry is part
// of the map.
//
// Why textures rather than the earlier geometry approach: the shapes are
// small, they sit on curved surfaces, and the earlier extrude-and-wrap
// pipeline could only draw flat silhouettes at low resolution. A canvas
// texture anti-aliases cleanly, allows gradients and finer filigree, and
// collapses three meshes per garment to one.
//
// TEAM COLOUR IS LIGHTENED
// Heraldry on near-black cloth has to be brighter than the team colour
// the game uses elsewhere — 0x3a6ea5 on 0x08080c reads as "slightly less
// black", not as blue. HERALDRY_LIGHTEN pulls every heraldic element
// toward white by 40%, giving a legible emblem against the cloth. The
// same lightened colour is used on the shield crest (see ShieldBuilder).
//
// MERGE STRATEGY
// Cuirass + pauldrons share one material and merge into one mesh. Belt,
// hood, cape, and tabard are each single meshes. Net: five armor meshes
// per Warlord.
//
// Geometries and materials are cached (see MeshCache.js). Textures are
// baked once per team and cached inside the material factory.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';
import {
  buildWarCrownShape,
  buildHoodWingShape,
  buildHoodFlourishShape
} from './HeraldicShapes.js';

// --- palette ---------------------------------------------------------------

// Darker than the hobgoblin's 0x50505a. The Warlord's armor is heavier
// and more ceremonial than rank-and-file kit.
const WARLORD_METAL_COLOR = 0x3a3a44;

// Warm, slightly desaturated gold — reserved for the shield's heraldic
// frame and any future ceremonial metal. Not used on the cloak any more;
// the cloak's heraldry is team colour.
const WARLORD_TRIM_COLOR = 0xd4af37;

// The cloak (hood + cape) is near-black. Very dark charcoal, not pure
// 0x000000: a pure-black Lambert surface crushes to a flat void with no
// readable shading, and the hood and cape lose their form entirely.
// 0x08080c keeps the black read while letting light describe the shell.
const WARLORD_CLOAK_COLOR = 0x08080c;

// How far the team colour is lightened for heraldry on the cloak and on
// the shield. A near-black ground makes an unlightened team colour read
// as "the same dark cloth, slightly different hue" — this is the amount
// of pull toward white that makes the heraldry legible at battle zoom.
const HERALDRY_LIGHTEN = 0.40;

// --- helpers ---------------------------------------------------------------

// Team colour, pulled toward white by HERALDRY_LIGHTEN. Every heraldic
// element on the Warlord — cloak stripe, crown sigils, hood ornaments,
// shield crest — is this colour. One helper so the lightening cannot
// drift between the hood, the cape, and the shield.
export function getWarlordHeraldryColor(teamColor) {
  return new THREE.Color(teamColor).lerp(
    new THREE.Color(0xffffff), HERALDRY_LIGHTEN);
}

function cssColorFromHex(hex) {
  return '#' + new THREE.Color(hex).getHexString();
}

function cssColorFromColor(color) {
  return '#' + color.getHexString();
}

// --- materials -------------------------------------------------------------

export function getWarlordMetalMaterial() {
  return cachedMaterial('goblinWarlord.metalMat', () =>
    new THREE.MeshLambertMaterial({ color: WARLORD_METAL_COLOR }));
}

// Hood material — per team, textured. The map carries both the black
// cloth fill and the heraldry (crown + wings + flourish) in the lightened
// team colour. Material colour is white so the map's own colours are
// what the light shades. DoubleSide because the hood is an open shell.
export function getWarlordHoodMaterial(teamColor) {
  return cachedMaterial(`goblinWarlord.hoodMat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: buildHoodClothTexture(teamColor),
      side: THREE.DoubleSide
    }));
}

// Cape material — per team, textured. The map carries the black cloth
// fill, the two team-coloured hem bands, the vertical centre stripe, and
// the two flanking war-crown sigils, all in lightened team colour.
export function getWarlordCapeMaterial(teamColor) {
  return cachedMaterial(`goblinWarlord.capeMat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: buildCapeClothTexture(teamColor),
      side: THREE.DoubleSide
    }));
}

// Sigil material. No longer used by the Warlord's own cloak (which is now
// textured), but retained as an export so ShieldBuilder's Warlord crest
// has a shared, per-team, lightened heraldic material it can import
// without duplicating the lightening constant.
export function getWarlordSigilMaterial(teamColor) {
  return cachedMaterial(`goblinWarlord.sigilMat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({
      color: getWarlordHeraldryColor(teamColor),
      side: THREE.DoubleSide
    }));
}

// Tabard: a softer team tint than the hood's, matching the hobgoblin
// skirt convention.
export function getWarlordTabardMaterial(teamColor) {
  return cachedMaterial(`goblinWarlord.tabardMat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({
      color: new THREE.Color(teamColor).multiplyScalar(0.82),
      side: THREE.DoubleSide
    }));
}

// Gold trim. Kept for ShieldBuilder's crest frame and any future
// ceremonial-metal use. Not used on the cloak.
export function getWarlordTrimMaterial() {
  return cachedMaterial('goblinWarlord.trimMat', () =>
    new THREE.MeshLambertMaterial({ color: WARLORD_TRIM_COLOR }));
}

// --- cuirass + pauldrons (pivot-local) -------------------------------------

export function createWarlordCuirass(metalMat, {
  profile, pad, yFrom, yTo,
  pauldronY, pauldronX, pauldronRadius,
  cachePrefix
}) {
  const geo = cachedGeometry(`${cachePrefix}.cuirassGeo`, () => {
    const entries = [];

    const slice = offsetProfileSlice(profile, yFrom, yTo, pad);
    if (slice.length >= 2) {
      entries.push({
        geometry: new THREE.LatheGeometry(
          slice, 10,
          -Math.PI * 0.75, Math.PI * 1.5
        )
      });
    }

    for (const side of [-1, 1]) {
      entries.push({
        geometry: new THREE.SphereGeometry(
          pauldronRadius, 8, 5,
          0, Math.PI * 2, 0, Math.PI * 0.55
        ),
        matrix: partMatrix(side * pauldronX, pauldronY, 0, 0, 0, side * -0.45)
      });
    }

    return mergeGeometries(entries);
  });
  return new THREE.Mesh(geo, metalMat);
}

// --- belt (body-space) -----------------------------------------------------

export function createWarlordBelt(metalMat, { beltY, beltRadius, cachePrefix }) {
  const geo = cachedGeometry(`${cachePrefix}.beltGeo`, () =>
    new THREE.CylinderGeometry(beltRadius, beltRadius, 0.055, 10, 1, true));
  const mesh = new THREE.Mesh(geo, metalMat);
  mesh.position.y = beltY;
  return mesh;
}

// --- hood (body-space) -----------------------------------------------------

// Custom parametric shell — not a lathe. See the file header.
//
// The shell is textured. Its UV grid is (phi / 2π, 1 - vEff): the u
// coordinate goes around the head with u = 0.5 at the back centre, and
// the v coordinate goes from 1 at the apex (top) to 0 at the rim
// (bottom). Heraldic shapes are drawn into a canvas at the (u, v) those
// shapes would occupy on the shell, and sampled by the shell's own UVs.
const HOOD_TILT_RAD = -0.16;
const HOOD_GAP_HALF_RAD = Math.PI * 0.32;

// The hood's side rim must not extend down past the shoulder pauldrons.
// Only the LOWER TAIL of the profile is shortened at the sides:
//   v <= HOOD_HEAD_TOP_V  → profile is unchanged at every phi (head
//                            coverage is fixed).
//   v >  HOOD_HEAD_TOP_V  → the side profile compresses to terminate at
//                            HOOD_PLATE_TOP_V, while the back (no
//                            plates) still runs the full profile and
//                            hangs as a cowl.
const HOOD_HEAD_TOP_V  = 0.65;
const HOOD_PLATE_TOP_V = 0.38;

export function createWarlordHood(clothMat, {
  headY, headRadius, headZ, cachePrefix
}) {
  const geo = cachedGeometry(`${cachePrefix}.hoodGeo`, () => {
    const R = headRadius;

    const PHI_SEG = 24;
    const V_SEG = 16;

    const profileY = [
      R + 0.03,
      R - 0.02,
      R * 0.55,
      R * 0.10,
      -R * 0.50,
      -R - 0.06
    ];
    const profileR = [
      0,
      R * 0.75,
      R * 0.95,
      R * 1.02,
      R * 1.07,
      R * 1.11
    ];
    const profileV = [0.00, 0.18, 0.38, 0.58, 0.80, 1.00];

    function interpProfile(v, arr) {
      if (v <= profileV[0]) return arr[0];
      for (let i = 0; i < profileV.length - 1; i++) {
        if (v <= profileV[i + 1]) {
          const t = (v - profileV[i]) / (profileV[i + 1] - profileV[i]);
          return arr[i] + (arr[i + 1] - arr[i]) * t;
        }
      }
      return arr[arr.length - 1];
    }

    // Face gap half-angle at v. Zero above the brow line — crown and
    // forehead are closed by a full 360° cap. Ramps up smoothly around
    // the brow, full gap from v ≈ 0.55 down.
    function gapHalfAt(v) {
      const t = Math.max(0, Math.min(1, (v - 0.35) / 0.20));
      const smooth = t * t * (3 - 2 * t);
      return HOOD_GAP_HALF_RAD * smooth;
    }

    // Backness: 1 at the back centre (phi = π), 0 at the gap edges.
    function backness(phi, gapHalf) {
      const d = Math.abs(phi - Math.PI);
      const maxD = Math.PI - gapHalf;
      if (maxD <= 0.001) return 0;
      const t = Math.min(1, d / maxD);
      return 0.5 * (1 + Math.cos(t * Math.PI));
    }

    const positions = [];
    const uvs = [];
    const indices = [];

    const plateV = Math.max(HOOD_PLATE_TOP_V, HOOD_HEAD_TOP_V + 0.01);

    for (let iv = 0; iv <= V_SEG; iv++) {
      const v = iv / V_SEG;
      const gap = gapHalfAt(v);

      // Peak: lifts the top-back of the hood.
      const peakT = Math.max(0, 1 - v / 0.5);
      const peakAmt = 0.10 * peakT * peakT;

      // Drape: back extends further out and further down toward the rim.
      const drapeT = v * v;
      const rDrapeAmt = 0.07 * drapeT;
      const yDrapeAmt = 0.07 * drapeT;

      const phiMin = gap;
      const phiMax = 2 * Math.PI - gap;
      const phiSpan = phiMax - phiMin;

      for (let ip = 0; ip <= PHI_SEG; ip++) {
        const u = ip / PHI_SEG;
        const phi = phiMin + u * phiSpan;
        const b = backness(phi, gap);

        // Rim-height crop, piecewise (see constant docs above).
        const vStop = plateV + (1 - plateV) * b;
        let vEff;
        if (v <= HOOD_HEAD_TOP_V) {
          vEff = v;
        } else {
          const t = (v - HOOD_HEAD_TOP_V) / (1 - HOOD_HEAD_TOP_V);
          vEff = HOOD_HEAD_TOP_V + t * (vStop - HOOD_HEAD_TOP_V);
        }

        const yBase = interpProfile(vEff, profileY);
        const rBase = interpProfile(vEff, profileR);

        const y = yBase + peakAmt * b - yDrapeAmt * b;
        const r = rBase + rDrapeAmt * b;

        positions.push(r * Math.sin(phi), y, r * Math.cos(phi));

        // UV: u goes with phi (so u = 0.5 is the back centre), v goes
        // with vEff but is flipped so the canvas's top row is the apex
        // and its bottom row is the rim.
        uvs.push(phi / (2 * Math.PI), 1 - vEff);
      }
    }

    for (let iv = 0; iv < V_SEG; iv++) {
      for (let ip = 0; ip < PHI_SEG; ip++) {
        const a = iv * (PHI_SEG + 1) + ip;
        const b = a + 1;
        const c = a + (PHI_SEG + 1);
        const d = c + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();

    g.rotateX(HOOD_TILT_RAD);
    g.translate(0, headY, headZ);
    return g;
  });
  return new THREE.Mesh(geo, clothMat);
}

// --- hood heraldry texture -------------------------------------------------

// Heraldry placement on the hood. All values are in the hood's own
// parametric space:
//   HOOD_SIGIL_V / HOOD_WING_V / HOOD_FLOURISH_V — v (0 = apex, 1 = rim)
//   HOOD_WING_PHI_OFFSET — radians from the back centre, per wing.
//
// Canvas pixel positions are derived from these: x_px = u * W,
// y_px = v * H (because the canvas's top row is the apex).
const HOOD_SIGIL_V          = 0.42;
const HOOD_WING_V           = 0.46;
const HOOD_WING_PHI_OFFSET  = 0.40;
const HOOD_FLOURISH_V       = 0.30;

// Shape sizes in texture pixels. Derived from the world-unit sizes the
// earlier geometry version used, scaled by the hood's own dimensions
// (circumference ~2π * radius, height ~apex-to-rim): 0.08 world wide on
// a 0.88-wide texture is 23 px, and 0.10 world tall on a 0.36-tall
// texture maps (through the hood's nonlinear v-to-Y profile) to about
// 100 px. If you want the shapes bigger or smaller, these four numbers
// are the only knobs.
const HOOD_CROWN_PX_W    = 22;
const HOOD_CROWN_PX_H    = 100;
const HOOD_WING_PX_W     = 16;
const HOOD_WING_PX_H     = 48;
const HOOD_FLOURISH_PX_W = 30;
const HOOD_FLOURISH_PX_H = 14;

function buildHoodClothTexture(teamColor) {
  const W = 256;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Base cloth fill.
  ctx.fillStyle = cssColorFromHex(WARLORD_CLOAK_COLOR);
  ctx.fillRect(0, 0, W, H);

  // Heraldry colour — lightened team colour, so it reads against black.
  ctx.fillStyle = cssColorFromColor(getWarlordHeraldryColor(teamColor));

  const cx = W / 2;

  // Crown at the back centre, mid-profile.
  drawShapeOnCanvas(
    ctx, buildWarCrownShape(),
    cx, HOOD_SIGIL_V * H,
    HOOD_CROWN_PX_W, HOOD_CROWN_PX_H
  );

  // Wings flanking the crown. The wing shape is authored right-anchored
  // (X from 0 to 0.9); mirroring it for the left wing keeps the pair
  // symmetric about the back centre.
  const wingU = HOOD_WING_PHI_OFFSET / (2 * Math.PI);
  for (const sign of [-1, 1]) {
    drawShapeOnCanvas(
      ctx, buildHoodWingShape(sign < 0),
      cx + sign * wingU * W, HOOD_WING_V * H,
      HOOD_WING_PX_W, HOOD_WING_PX_H
    );
  }

  // Flourish above the crown.
  drawShapeOnCanvas(
    ctx, buildHoodFlourishShape(),
    cx, HOOD_FLOURISH_V * H,
    HOOD_FLOURISH_PX_W, HOOD_FLOURISH_PX_H
  );

  const tex = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// --- tabard (body-space) ---------------------------------------------------

export function createWarlordTabard(clothMat, {
  beltY, beltRadius, length, flare, cachePrefix
}) {
  const geo = cachedGeometry(`${cachePrefix}.tabardGeo`, () =>
    new THREE.CylinderGeometry(
      beltRadius * 1.02, beltRadius * flare,
      length, 10, 1, true,
      -Math.PI * 0.65, Math.PI * 1.3
    ));
  const mesh = new THREE.Mesh(geo, clothMat);
  mesh.position.y = beltY - length / 2 - 0.02;
  return mesh;
}

// --- cape (body-space) -----------------------------------------------------

// Tapered open cylinder wrapping the back and sides, with the front left
// open. In CylinderGeometry, theta=0 is +Z (forward), theta=π is -Z
// (back). The arc runs from phiStart = 0.40π through theta=π to
// phiStart + phiLength = 1.60π — a 216° sweep centred on the back.
//
// CylinderGeometry generates UVs for the shell: u goes 0..1 across the
// arc, v goes 0 at bottom to 1 at top. That is exactly the UV frame the
// cape's cloth texture is baked in — no custom UV code needed.
//
// Length is deliberately hip-length, not floor-length: the walk cycle
// swings each leg backward through Z ≈ -0.15 at the bottom of its
// stride, which would intersect a longer cape every step.
export function createWarlordCape(clothMat, {
  topY, bottomY, topRadius, bottomRadius, cachePrefix
}) {
  const height = topY - bottomY;
  const geo = cachedGeometry(`${cachePrefix}.capeGeo`, () =>
    new THREE.CylinderGeometry(
      topRadius, bottomRadius,
      height, 12, 1, true,
      Math.PI * 0.40, Math.PI * 1.20
    ));
  const mesh = new THREE.Mesh(geo, clothMat);
  mesh.position.set(0, (topY + bottomY) / 2, 0);
  return mesh;
}

// --- cape heraldry texture -------------------------------------------------

// Cape layout constants, in the cape's own world-Y terms. These mirror
// the values GoblinWarlordBuilder passes when it calls createWarlordCape
// — if the cape's shape is ever retuned, update these too or the
// heraldry will land in the wrong spot.
const CAPE_TEX_TOP_Y    = 0.79;
const CAPE_TEX_BOTTOM_Y = 0.22;
const CAPE_TEX_HEIGHT   = CAPE_TEX_TOP_Y - CAPE_TEX_BOTTOM_Y;

// Angular widths, radians. The stripe spans 0.16π centred on the back;
// the sigils sit at ±0.55 rad from the back centre. Both are drawn into
// the texture's own u frame, where u = 0 at the cape's phiStart and u = 1
// at phiStart + phiLength (1.20π).
const CAPE_STRIPE_ARC          = Math.PI * 0.16;
const CAPE_SIGIL_ARC_FROM_BACK = 0.55;

// Cape arc and its world radius at the sigil row — used to convert the
// sigils' world-unit sizes into texture pixels. The cape radius there is
// interpolated linearly between top and bottom; 0.17 is a close
// approximation for the current layout and is the only value to change if
// the cape is reshaped.
const CAPE_ARC_LENGTH_RAD   = 1.20 * Math.PI;
const CAPE_RADIUS_AT_SIGIL  = 0.17;
const CAPE_SIGIL_WORLD_W    = 0.07;
const CAPE_SIGIL_WORLD_H    = 0.09;

function buildCapeClothTexture(teamColor) {
  const W = 256;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Base cloth fill.
  ctx.fillStyle = cssColorFromHex(WARLORD_CLOAK_COLOR);
  ctx.fillRect(0, 0, W, H);

  // Heraldry colour.
  const heraldry = cssColorFromColor(getWarlordHeraldryColor(teamColor));
  ctx.fillStyle = heraldry;

  // Pixel-per-world-Y in the canvas. The cape's top is at canvas y=0
  // (uv.y = 1 there, canvas top row) and its bottom at canvas y=H.
  const pxPerY = H / CAPE_TEX_HEIGHT;

  // Two hem bands, world-height 0.030 each, inset from the hem by 25% of
  // their own height (matching the earlier geometry trim).
  const bandWorldH = 0.030;
  const topBandY = (0.75 * bandWorldH) * pxPerY;
  const botBandY = (0.75 * bandWorldH) * pxPerY;
  ctx.fillRect(0, 0, W, topBandY);
  ctx.fillRect(0, H - botBandY, W, botBandY);

  // Vertical centre stripe. u = 0.5 is the back centre because phi = π
  // falls at the arc's midpoint.
  const stripeU = CAPE_STRIPE_ARC / CAPE_ARC_LENGTH_RAD;
  const stripePx = stripeU * W;
  const stripeX = W / 2 - stripePx / 2;
  const stripeTop = topBandY;
  const stripeBot = H - botBandY;
  ctx.fillRect(stripeX, stripeTop, stripePx, stripeBot - stripeTop);

  // Two war-crown sigils flanking the stripe.
  const sigilWorldY = 0.50;
  const sigilPxY = (CAPE_TEX_TOP_Y - sigilWorldY) * pxPerY;
  const sigilArcRad = CAPE_SIGIL_WORLD_W / CAPE_RADIUS_AT_SIGIL;
  const sigilPxW = (sigilArcRad / CAPE_ARC_LENGTH_RAD) * W;
  const sigilPxH = CAPE_SIGIL_WORLD_H * pxPerY;
  const sigilOffsetU = CAPE_SIGIL_ARC_FROM_BACK / CAPE_ARC_LENGTH_RAD;
  for (const sign of [-1, 1]) {
    drawShapeOnCanvas(
      ctx, buildWarCrownShape(),
      W / 2 + sign * sigilOffsetU * W, sigilPxY,
      sigilPxW, sigilPxH
    );
  }

  const tex = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// --- canvas shape drawing --------------------------------------------------

// Draws a THREE.Shape onto a 2D canvas, scaled to fit a target pixel box
// and centred at (cx, cy). Used by both cloth textures. The shape is
// sampled with getPoints so spline-based outlines (the wing, the
// flourish) render smoothly rather than as their control-point polygon.
//
// y is flipped during the draw: THREE.Shape's Y increases upward, canvas
// Y increases downward. That is what makes the heraldry appear upright
// on the shell after the texture is applied.
function drawShapeOnCanvas(ctx, shape, cx, cy, wPx, hPx) {
  const pts = shape.getPoints(24);
  if (pts.length === 0) return;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const nativeW = maxX - minX;
  const nativeH = maxY - minY;
  const sx = nativeW > 1e-6 ? wPx / nativeW : 1;
  const sy = nativeH > 1e-6 ? hPx / nativeH : 1;
  const bcx = (minX + maxX) / 2;
  const bcy = (minY + maxY) / 2;

  ctx.beginPath();
  const p0 = pts[0];
  ctx.moveTo(cx + (p0.x - bcx) * sx, cy - (p0.y - bcy) * sy);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(cx + (pts[i].x - bcx) * sx, cy - (pts[i].y - bcy) * sy);
  }
  ctx.closePath();
  ctx.fill();
}

// --- profile helpers -------------------------------------------------------

// Radius of a lathe profile at an arbitrary height, by linear interpolation
// between the two vertices that bracket it. Returns 0 outside the profile.
function profileRadiusAt(profile, y) {
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (b.y < y || a.y > y) continue;
    const dy = b.y - a.y;
    if (dy <= 0) continue;
    return a.x + (b.x - a.x) * ((y - a.y) / dy);
  }
  return 0;
}

// Slice the profile between two heights and push every point outward by
// `pad`. The endpoints are interpolated so the slice's top and bottom
// edges land exactly where the caller asked, not on the nearest profile
// vertex. Zero-radius vertices (the profile's closed caps) are dropped.
function offsetProfileSlice(profile, yFrom, yTo, pad) {
  const slice = [new THREE.Vector2(profileRadiusAt(profile, yFrom) + pad, yFrom)];
  for (const point of profile) {
    if (point.y > yFrom && point.y < yTo && point.x > 0) {
      slice.push(new THREE.Vector2(point.x + pad, point.y));
    }
  }
  slice.push(new THREE.Vector2(profileRadiusAt(profile, yTo) + pad, yTo));
  return slice;
}
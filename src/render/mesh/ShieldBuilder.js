// Shields. Two variants live here:
//
//   createShield       — the "banner" shield. A heater-shaped plank carried
//                        by every non-goblin shield-armed soldier. Bigger
//                        and taller than the previous round shield, with
//                        the classic flat-top / tapered-bottom silhouette.
//   createGoblinShield — the small, crude, round shield carried by goblins.
//                        This is the retired round-shield design, kept as
//                        the goblin variant after the round shape stopped
//                        being issued to everyone else.
//
// Both face +Z (the unit's forward axis) so SoldierView can position and
// rotate them per-soldier without any additional local rotation.
//
// Geometry is cached (see MeshCache.js) under distinct keys — a shared key
// would hand every goblin the banner shield instance, or vice versa. The
// material is per-instance: SoldierView tints the shield toward black as
// shieldHp drops, so each soldier needs its own material to write to.
import * as THREE from 'three';
import { cachedGeometry } from './MeshCache.js';
import { mergeColoredGeometries, paint } from './MeshMerge.js';
import { buildWarCrownShape } from './HeraldicShapes.js';
// The Warlord's crest uses the same lightened team colour as the hood
// and cape heraldry — one helper, one lightening constant, so the three
// emblems cannot drift apart. One-way import: GoblinWarlordArmor does
// not import ShieldBuilder, so there is no module cycle.
import { getWarlordHeraldryColor } from './GoblinWarlordArmor.js';

// --- banner shield ---------------------------------------------------------
//
// Heater silhouette: flat top with sharp corners, sides curving inward,
// rounded point at the bottom. Every edge is a straight line — no curve
// segments — so the shape stays low-poly and the read stays crisp at
// battle zoom.
//
// Dimensions in the shield's own local frame:
//   half-width at top: 0.23   → 0.46 world units wide
//   top edge:         +0.31
//   bottom point:     -0.31   → 0.62 world units tall
//
// The previous round shield was 0.44 across. This is ~5% wider and ~40%
// taller — a real silhouette change, not a scale tweak.

const BANNER_HALF_WIDTH = 0.23;
const BANNER_TOP_Y      = 0.31;
const BANNER_BOTTOM_Y   = -0.31;

// Extrusion depth and bevel. The bevel rounds the shield's edges, which
// reads as a wooden rim without needing a second material or a second
// mesh. bevelSegments:1 keeps the rim a single chamfer facet — more
// segments would round it further but at battle zoom one facet is
// indistinguishable from three.
const BANNER_DEPTH = 0.035;
const BANNER_BEVEL = 0.008;

// Banner shield wood colour. Per-instance material (see file header), so
// this constant is the *base* colour that SoldierView copies from before
// applying the HP tint.
const BANNER_WOOD_COLOR = 0x8b5a2b;

// --- goblin shield ---------------------------------------------------------
//
// Round wooden disc, small, dark, low segment count. Reads as a crude
// shield next to the banner shield's carved silhouette: same material
// family, but a goblin-sized lid rather than a proper heraldic plank.
//
// Segment count is 8 rather than the previous 12 — a clearly faceted
// outline reinforces "hand-made, not workshop-made" without any other
// geometric changes.

const GOBLIN_SHIELD_RADIUS       = 0.20;
const GOBLIN_SHIELD_THICKNESS    = 0.05;
const GOBLIN_SHIELD_SEGMENTS     = 8;
const GOBLIN_SHIELD_WOOD_COLOR   = 0x6a4526;

// --- builders --------------------------------------------------------------

export function createShield() {
  const geo = cachedGeometry('shield.bannerGeo', buildBannerShieldGeometry);
  // Per-instance: SoldierView tints this toward black as shieldHp drops.
  const mat = new THREE.MeshLambertMaterial({ color: BANNER_WOOD_COLOR });
  return new THREE.Mesh(geo, mat);
}

export function createGoblinShield() {
  const geo = cachedGeometry('shield.goblinGeo', () => {
    const g = new THREE.CylinderGeometry(
      GOBLIN_SHIELD_RADIUS,
      GOBLIN_SHIELD_RADIUS,
      GOBLIN_SHIELD_THICKNESS,
      GOBLIN_SHIELD_SEGMENTS
    );
    // CylinderGeometry's axis is +Y, which would leave the disc facing
    // straight up. Rotating the GEOMETRY (not the mesh) around X lays it
    // flat so the two disc faces point along ±Z — the shield's carrying
    // direction — and SoldierView's rotation.y then aligns it with the
    // soldier's facing.
    //
    // This rotation MUST be baked into the geometry, not applied to the
    // mesh. SoldierView.sync writes shield.rotation every frame via
    // rotation.set(0, facing, spin), which overwrites a mesh-level
    // rotation.x on the first sync and would snap the goblin shield
    // upright. The banner shield avoids this only because its extruded
    // shape is already authored in the XY plane with its face normal
    // along ±Z. Baking here gives the goblin shield the same contract.
    g.rotateX(Math.PI / 2);
    return g;
  });
  // Per-instance: SoldierView tints this toward black as shieldHp drops.
  const mat = new THREE.MeshLambertMaterial({ color: GOBLIN_SHIELD_WOOD_COLOR });
  return new THREE.Mesh(geo, mat);
}

// Builds the banner shield's extruded heater shape.
//
// Draws the outline counter-clockwise (viewed from +Z). ExtrudeGeometry
// expects CCW winding so the front cap's normal points outward; a CW
// winding would flip that normal and the shield would render inside-out
// from the front.
//
// The outline is symmetric about X=0 so the two sides taper identically
// from the top corners down to the bottom point. The bottom 4 cm (from
// y = -0.28 to the point at y = -0.31) is a very short segment — the
// sides run almost the whole way down before converging, which is what
// gives the classic heater silhouette rather than a rounded spade.
function buildBannerShieldGeometry() {
  const shape = new THREE.Shape();

  // --- left side, top to bottom ---
  shape.moveTo(-BANNER_HALF_WIDTH, BANNER_TOP_Y);
  shape.lineTo(-BANNER_HALF_WIDTH,        BANNER_TOP_Y - 0.13);
  shape.lineTo(-BANNER_HALF_WIDTH + 0.02, BANNER_TOP_Y - 0.26);
  shape.lineTo(-BANNER_HALF_WIDTH + 0.06, BANNER_TOP_Y - 0.39);
  shape.lineTo(-BANNER_HALF_WIDTH + 0.12, BANNER_TOP_Y - 0.51);
  shape.lineTo(-BANNER_HALF_WIDTH + 0.18, BANNER_TOP_Y - 0.59);

  // --- bottom point ---
  shape.lineTo(0, BANNER_BOTTOM_Y);

  // --- right side, bottom to top (mirror of the left) ---
  shape.lineTo(BANNER_HALF_WIDTH - 0.18, BANNER_TOP_Y - 0.59);
  shape.lineTo(BANNER_HALF_WIDTH - 0.12, BANNER_TOP_Y - 0.51);
  shape.lineTo(BANNER_HALF_WIDTH - 0.06, BANNER_TOP_Y - 0.39);
  shape.lineTo(BANNER_HALF_WIDTH - 0.02, BANNER_TOP_Y - 0.26);
  shape.lineTo(BANNER_HALF_WIDTH,        BANNER_TOP_Y - 0.13);
  shape.lineTo(BANNER_HALF_WIDTH,        BANNER_TOP_Y);

  // closePath() draws the flat top edge from the top-right corner back to
  // the top-left corner, and closes the loop.

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: BANNER_DEPTH,
    bevelEnabled: true,
    bevelThickness: BANNER_BEVEL,
    bevelSize: BANNER_BEVEL,
    bevelSegments: 1,
    curveSegments: 1
  });

  // Centre the extrusion on Z. ExtrudeGeometry spans Z from 0 to depth,
  // with the bevels extending a small amount beyond both ends, so shifting
  // back by depth/2 lands the geometry roughly centred — the residual
  // bevel offset is sub-millimetre and invisible at any camera distance
  // the player can reach.
  geo.translate(0, 0, -BANNER_DEPTH / 2);

  return geo;
}

createHobgoblinShield

// --- hobgoblin shield — crenellated "tower targe" --------------------------
//
// The hobgoblin's issue shield. Distinct silhouette from the human banner
// shield in one specific, legible way: the top edge is CRENELLATED — three
// flat blocks separated by two dips, reading as a castle wall. That is the
// shape's whole identity at battle zoom. A rounded top or a plain flat
// rectangle would read as "the same shield, drawn slightly differently";
// crenellations read as "issued by a different army".
//
// The rest of the outline is deliberately conventional — vertical sides,
// tapered lower edge, pointed base — because hobgoblins are rank-and-file
// soldiery, not heroes. The distinct part is the top; everything else is
// the shape a soldier would actually be handed.
//
// Dimensions: 0.42 wide × 0.58 tall. Slightly shorter and wider than the
// human banner shield (0.46 × 0.62), which is a hobgoblin-appropriate
// proportion — more square, less heraldic, closer to a proper infantry
// targe.

const HOBGOBLIN_SHIELD_HALF_W  = 0.21;
const HOBGOBLIN_SHIELD_TOP_Y   = 0.29;
const HOBGOBLIN_SHIELD_BOTTOM_Y = -0.29;
const HOBGOBLIN_SHIELD_DEPTH   = 0.035;
const HOBGOBLIN_SHIELD_BEVEL   = 0.008;
const HOBGOBLIN_SHIELD_CRENEL_DEPTH = 0.06;
// Dark bog-oak. Reads as black at battle-zoom silhouette distance, but
// carries enough luminance for the light to describe the shield's
// curvature — a pure black Lambert surface crushes to a flat void and
// the shield reads as a hole cut in the model rather than as a piece of
// dark wooden kit. The warmth is deliberate: this is treated wood, not
// cloth, and a hint of brown keeps it in the same material family as
// every other shield in the game.
const HOBGOBLIN_SHIELD_WOOD_COLOR   = 0x1c1410;

export function createHobgoblinShield() {
  const geo = cachedGeometry('shield.hobgoblinGeo', () =>
    buildHobgoblinShieldGeometry());
  // Per-instance: SoldierView tints this toward black as shieldHp drops.
  const mat = new THREE.MeshLambertMaterial({ color: HOBGOBLIN_SHIELD_WOOD_COLOR });
  return new THREE.Mesh(geo, mat);
}

function buildHobgoblinShieldGeometry() {
  const s = new THREE.Shape();
  const W = HOBGOBLIN_SHIELD_HALF_W;
  const TOP = HOBGOBLIN_SHIELD_TOP_Y;
  const BOT = HOBGOBLIN_SHIELD_BOTTOM_Y;
  const CD = HOBGOBLIN_SHIELD_CRENEL_DEPTH;
  // Merlon edges. Three blocks: outer-left [-W, -0.14], center
  // [-0.07, 0.07], outer-right [0.14, W]. Two dips at [-0.14, -0.07]
  // and [0.07, 0.14]. Widths of the three blocks are 0.07, 0.14, 0.07 —
  // the center block is deliberately the widest so the shield reads as
  // built around a single central mass, not a fence.
  const M = 0.14;  // outer merlon inner edge (mirrored on both sides)
  const N = 0.07;  // inner merlon outer edge (mirrored on both sides)

  // Winding: CCW from +Z, matching the banner shield — start top-left,
  // down the left side, along the bottom, up the right, right-to-left
  // across the top.
  s.moveTo(-W, TOP);
  s.lineTo(-W, -0.10);
  s.lineTo( 0, BOT);
  s.lineTo( W, -0.10);
  s.lineTo( W, TOP);
  // Top edge, right to left, with the crenellations.
  s.lineTo( M, TOP);   // left across top of outer-right block
  s.lineTo( M, TOP - CD);  // down into right crenel
  s.lineTo( N, TOP - CD);  // left across crenel floor
  s.lineTo( N, TOP);   // up to center block
  s.lineTo(-N, TOP);   // left across top of center block
  s.lineTo(-N, TOP - CD);  // down into left crenel
  s.lineTo(-M, TOP - CD);  // left across crenel floor
  s.lineTo(-M, TOP);   // up to outer-left block
  s.lineTo(-W, TOP);   // left across top of outer-left block (closes)

  const geo = new THREE.ExtrudeGeometry(s, {
    depth: HOBGOBLIN_SHIELD_DEPTH,
    bevelEnabled: true,
    bevelThickness: HOBGOBLIN_SHIELD_BEVEL,
    bevelSize: HOBGOBLIN_SHIELD_BEVEL,
    bevelSegments: 1,
    curveSegments: 1
  });
  geo.translate(0, 0, -HOBGOBLIN_SHIELD_DEPTH / 2);
  return geo;
}

// --- Warlord shield — elongated kite with war-crown crest ------------------
//
// The Goblin Warlord's shield. Distinct from every other shield in the
// game in two ways at once:
//
//   1. Shape: an elongated marquise / kite — a pointed top, curved
//      sides, pointed bottom, symmetrical. No straight edges. Reads as
//      a personal heraldic shield rather than the issued gear the
//      hobgoblin or the human gets.
//
//   2. Crest: the war-crown (buildWarCrownShape) as a raised panel on
//      the shield's face, in the Warlord's gold trim colour. The same
//      device appears on the hood and the cape; the shield-face crest
//      is the third placement, which is what makes the whole character
//      read as carrying one consistent heraldic identity rather than
//      three unrelated pieces of decoration.
//
// Dimensions: 0.34 wide × 0.50 tall. Smaller than the hobgoblin shield
// because the Warlord is smaller than a hobgoblin, and the shield should
// read as proportionate to its bearer.
//
// MATERIAL: unlike every other shield in the game, this one uses
// vertex colours rather than a single-colour Lambert. The field is one
// colour and the crest is another, which lets both live in one mesh
// without a second draw call. The material's own colour starts at white
// — SoldierView's per-frame HP tint multiplies the material colour by
// the tint factor, so a white base means the tint scales the vertex
// colours down together, exactly as a plain shield's material would be
// scaled down. Result: the shield darkens as shieldHp drops, and the
// crest darkens with it.

const WARLORD_SHIELD_HALF_W   = 0.17;
const WARLORD_SHIELD_TOP_Y    = 0.25;
const WARLORD_SHIELD_BOTTOM_Y = -0.25;
const WARLORD_SHIELD_DEPTH    = 0.030;
const WARLORD_SHIELD_BEVEL    = 0.006;
// Field: dark ebony — reads black at silhouette distance, but keeps
// enough luminance for the light to describe the shield's shape. Same
// reasoning as the hobgoblin shield above, and slightly cooler than
// that shield's bog-oak so the Warlord's kit reads as a separate,
// more ceremonial material rather than a re-dyed hobgoblin shield.
// The crest is the only saturated element on the face and stays the
// brightest thing on the shield by a wide margin.
const WARLORD_SHIELD_WOOD     = 0x14121a;
const WARLORD_SHIELD_CREST_WIDTH  = 0.20;
const WARLORD_SHIELD_CREST_HEIGHT = 0.24;
const WARLORD_SHIELD_CREST_DEPTH  = 0.010;

// teamColor is the team's display hex (TeamColors[teamId]). The crest is
// painted with the LIGHTENED team colour (getWarlordHeraldryColor) —
// the same colour the Warlord's cloak heraldry uses, so the shield
// crest matches the hood and cape emblems by construction. The geometry
// is cached per-team; there are only two teams, so this is one extra
// cached buffer per team and no per-frame cost.
//
// A missing or non-numeric teamColor (the icon path, which is team-
// agnostic) falls back to a mid-grey crest. The icon never composes a
// Warlord shield in the current code, but the fallback is here so a
// future icon path that does cannot end up with an undefined-colour
// crest.
export function createWarlordShield(teamColor) {
  const colorHex = (typeof teamColor === 'number') ? teamColor : 0x888888;
  const geo = cachedGeometry(
    `shield.warlordGeo.${colorHex}`,
    () => buildWarlordShieldGeometry(colorHex)
  );
  // Per-instance: SoldierView tints this toward black as shieldHp drops.
  // White base so the tint multiplies the vertex colours on both the
  // field and the crest equally — see the MATERIAL note above.
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true
  });
  return new THREE.Mesh(geo, mat);
}

function buildWarlordShieldGeometry(teamColorHex) {
  // Field: an elongated marquise — four curved sides, sharp top and
  // bottom. Authored CCW from +Z, same winding as every other shield.
  const s = new THREE.Shape();
  s.moveTo(0, WARLORD_SHIELD_TOP_Y);
  s.quadraticCurveTo(
    WARLORD_SHIELD_HALF_W, WARLORD_SHIELD_TOP_Y - 0.10,
    WARLORD_SHIELD_HALF_W, 0.02);
  s.quadraticCurveTo(
    WARLORD_SHIELD_HALF_W, -0.15,
    0, WARLORD_SHIELD_BOTTOM_Y);
  s.quadraticCurveTo(
    -WARLORD_SHIELD_HALF_W, -0.15,
    -WARLORD_SHIELD_HALF_W, 0.02);
  s.quadraticCurveTo(
    -WARLORD_SHIELD_HALF_W, WARLORD_SHIELD_TOP_Y - 0.10,
    0, WARLORD_SHIELD_TOP_Y);

  const fieldGeo = new THREE.ExtrudeGeometry(s, {
    depth: WARLORD_SHIELD_DEPTH,
    bevelEnabled: true,
    bevelThickness: WARLORD_SHIELD_BEVEL,
    bevelSize: WARLORD_SHIELD_BEVEL,
    bevelSegments: 1,
    curveSegments: 6
  });
  fieldGeo.translate(0, 0, -WARLORD_SHIELD_DEPTH / 2);
  paint(fieldGeo, WARLORD_SHIELD_WOOD);

  // Crest: the war-crown, scaled to fit the shield face, extruded thin,
  // and placed just proud of the field's front cap so it reads as a
  // raised applique rather than a flat print. Position on Z accounts
  // for the field's bevel: the field's front cap sits at
  // (DEPTH/2 + BEVEL), so the crest starts a hair in front of that.
  const crestShape = buildWarCrownShape();
  const crestGeo = new THREE.ExtrudeGeometry(crestShape, {
    depth: WARLORD_SHIELD_CREST_DEPTH,
    bevelEnabled: false,
    curveSegments: 2
  });
  // Native crown is 1.0 wide × 1.2 tall; scale uniformly to hit the
  // target width, then verify the height fits. 0.20 wide → 0.24 tall at
  // the crown's native aspect, which is what WARLORD_SHIELD_CREST_HEIGHT
  // was chosen to be — the two constants agree by construction.
  const crestScale = WARLORD_SHIELD_CREST_WIDTH;
  crestGeo.scale(crestScale, crestScale, 1);
  crestGeo.translate(
    0,
    -0.01,  // nudge down so the crown's visual centre sits on the shield centre
    WARLORD_SHIELD_DEPTH / 2 + WARLORD_SHIELD_BEVEL + 0.002
  );
  // getHex() because paint() takes a hex number. The Color is created
  // inside getWarlordHeraldryColor; converting to a number here keeps
  // paint's signature unchanged (it also accepts a Color, but a number
  // is what the other call sites pass, so this stays consistent).
  paint(crestGeo, getWarlordHeraldryColor(teamColorHex).getHex());

  return mergeColoredGeometries([
    { geometry: fieldGeo },
    { geometry: crestGeo }
  ]);
}


// Two swords side by side -- blue on the left, red on the right -- that
// show each team's CURRENT power relative to its STARTING power.
//
// Each blade is a stack of 8 jagged SHARDS cut along shared fracture
// lines, so the blade looks whole until it breaks. As power drops, shards
// break off from the tip downward: each one pops up, spins, falls in an
// arc and fades out. When power recovers, the shards fly back and
// reassemble. The hilt (crossguard, grip, pommel) never breaks, so a
// wiped-out team is left with a bare hilt rather than an empty slot.
//
// Every shard is three nested layers so the flight can be an arc using
// plain CSS transitions:
//   x    -- horizontal travel (decelerating, like air drag)
//   fall -- vertical travel, bezier with a negative control point so the
//           shard pops UP first and then falls with gravity
//   body -- the shard itself: clip-path shape, steel gradient, spin, fade
// All layers cover the whole blade box; only the clip-path differs per
// shard, which keeps the gradient aligned across pieces.
//
// Pure presentation. The owner calls setRatios() with current/start power
// per team (1 = untouched, 0 = wiped out).
import {
  LEFT_TEAM, RIGHT_TEAM, BRASS_LIGHT, BRASS_MID, BRASS_DARK, px
} from './PowerWidgetTheme.js';

// --- sword anatomy, tip to pommel -----------------------------------------
const SWORD_BLADE_HEIGHT  = 60;
const SWORD_GUARD_HEIGHT  = 4;
const SWORD_GRIP_HEIGHT   = 8;
const SWORD_POMMEL_HEIGHT = 6;
const SWORD_HEIGHT = SWORD_BLADE_HEIGHT + SWORD_GUARD_HEIGHT +
  SWORD_GRIP_HEIGHT + SWORD_POMMEL_HEIGHT;

// Overall sword width equals the crossguard width; blade, grip and pommel
// are narrower and centred on it.
const SWORD_WIDTH        = 24;
const SWORD_BLADE_WIDTH  = 10;
const SWORD_GRIP_WIDTH   = 4;
const SWORD_POMMEL_WIDTH = 7;

// Gap between the two swords. Wide enough that they read as a pair.
const SWORD_GAP = 34;

// Shards per blade. Each one is 1/8 of the sword's power.
const SWORD_PIECES = 8;

// Team-tinted steel with a darker central fuller.
const SWORD_TINT = {
  blue: 'linear-gradient(90deg, #26405c 0%, #b4cce4 25%, #3a5c80 50%, #b4cce4 75%, #26405c 100%)',
  red:  'linear-gradient(90deg, #5c2626 0%, #e4b4b4 25%, #803a3a 50%, #e4b4b4 75%, #5c2626 100%)'
};

// Detached-shard colour. Desaturated, cooler than either team tint, and
// slightly darker overall, so a broken piece reads as dead steel rather
// than as coloured debris. Same left-to-right band structure as
// SWORD_TINT, so the fuller line still runs down the middle of each
// shard -- the piece is the same shape, it has just lost its team colour.
const BROKEN_TINT =
  'linear-gradient(90deg, #2c2c2c 0%, #9a9a9a 25%, #4a4a4a 50%, #9a9a9a 75%, #2c2c2c 100%)';

// --- shard geometry ---------------------------------------------------------
// All values are percentages of the blade box (x 0 = left edge, 100 =
// right; y 0 = tip, 100 = base / crossguard).
//
// The blade is NOT cut into uniform horizontal bands. The crack pattern
// jogs left and right as it descends, so the shards are deliberately
// uneven in SHAPE: a wide left band beside a shorter right-hand corner
// chip, a long narrow left splinter beside a wide right block. This is
// what makes a broken blade read as shattered rather than sliced.
//
//   ┌──────────── tip ────────────┐   y  0..20    full width
//   ├──────────────┬──────────────┤   y 20..40
//   │      L1      │      R1      │      R1 = short right-hand chip
//   ├──────────────┼──────────────┤   y 40..52
//   │     L2a      │              │
//   ├──────────────┤      R2      │   y 52..65    R2 = wide right block
//   │     L2b      │              │
//   ├──────────────┼──────────────┤   y 65..100
//   │      L3      │      R3      │
//   └──────────────┴──────────────┘
//
// L2a and L2b together form one long, narrow left-side splinter; R2 is a
// wide right-side block beside them. R1 is a corner chip: short (20..40,
// under half the blade height) and confined to the right half, so when it
// breaks off the blade's upper-right silhouette is visibly missing a
// piece. When the whole blade shatters, the left-side shards drift left
// and the right-side shards drift right (see FLIGHTS below), so the blade
// opens outward rather than sliding sideways as one slab.
//
// Every shard polygon is CLOSED automatically by the builder, so only the
// corner vertices are listed here. Coordinates are blade-space percent.
const TIP_SHOULDER = 14;   // y where the point widens to full blade width

const SHARD_CORNERS = [
  // 0 -- tip. Bottom edge is the crack with L1 (left half) and R1 (right
  //      half); the vertex at x = 58 is where those two meet.
  [[0, TIP_SHOULDER], [50, 0], [100, TIP_SHOULDER],
   [100, 20], [58, 20], [0, 20]],

  // 1 -- L1: wide left band beside the corner chip.
  [[0, 20], [58, 20], [58, 40], [0, 40]],

  // 2 -- R1: the short right-hand corner chip.
  [[58, 20], [100, 20], [100, 40], [58, 40]],

  // 3 -- L2a: narrow left splinter, upper half.
  [[0, 40], [48, 40], [48, 52], [0, 52]],

  // 4 -- L2b: narrow left splinter, lower half.
  [[0, 52], [48, 52], [48, 65], [0, 65]],

  // 5 -- R2: wide right block spanning both left-splinter rows.
  [[48, 40], [100, 40], [100, 65], [48, 65]],

  // 6 -- L3: left base band.
  [[0, 65], [55, 65], [55, 100], [0, 100]],

  // 7 -- R3: right base band.
  [[55, 65], [100, 65], [100, 100], [55, 100]]
];
// SHARD_CORNERS must have exactly SWORD_PIECES entries. Change both
// together, or the breaking logic and FLIGHTS array will desync.

// Amplitude of the deterministic jitter applied to the interior of each
// crack. Per-axis, because blade-space x and y are not the same pixel
// scale: the blade is ~10 px wide and ~60 px tall, so a percent of x is
// one-sixth of a percent of y in pixels. These values give a crack wobble
// of roughly one pixel on either axis -- enough to read as jagged, not
// enough to look noisy.
const CRACK_JITTER_X = 7.0;
const CRACK_JITTER_Y = 1.8;

// --- deterministic crack jitter ---------------------------------------------
// Cracks are not straight lines. Every straight segment between two shard
// corners is replaced by a jagged polyline whose interior points are
// offset perpendicular to the segment, by a deterministic amount.
//
// Adjacent shards share the segment between their shared corners, so the
// interior points MUST be identical for both -- otherwise the blade would
// not be watertight when intact. The cache below guarantees that:
// segments are keyed by their canonical (sorted) endpoints, and each
// caller gets the stored polyline (or its reverse, depending on which
// direction it walks the segment).

function _hash32(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  n = n ^ (n >>> 15);
  return (n >>> 0) / 4294967296;
}

function _seedFromKey(key) {
  let seed = 2166136261;
  for (let i = 0; i < key.length; i++) {
    seed = Math.imul(seed ^ key.charCodeAt(i), 16777619);
  }
  return seed | 0;
}

const _segmentCache = new Map();

function jitteredSegment(a, b) {
  // Canonical endpoint order: the same physical segment always maps to
  // the same cache key regardless of which shard asks for it first.
  const flip = (a[0] > b[0]) || (a[0] === b[0] && a[1] > b[1]);
  const p0 = flip ? b : a;
  const p1 = flip ? a : b;

  const key = p0[0] + ',' + p0[1] + '|' + p1[0] + ',' + p1[1];
  let pts = _segmentCache.get(key);

  if (!pts) {
    pts = [p0];
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy) || 1;
    // Unit perpendicular, in the canonical direction.
    const nx = -dy / len;
    const ny =  dx / len;

    const seed = _seedFromKey(key);
    const INTERIOR = 3;
    for (let i = 1; i <= INTERIOR; i++) {
      const t = i / (INTERIOR + 1);
      const mx = p0[0] + dx * t;
      const my = p0[1] + dy * t;
      const r = _hash32(seed + i * 2654435761) * 2 - 1;  // -1..1
      pts.push([
        mx + nx * r * CRACK_JITTER_X,
        my + ny * r * CRACK_JITTER_Y
      ]);
    }
    pts.push(p1);
    _segmentCache.set(key, pts);
  }

  return flip ? pts.slice().reverse() : pts;
}

function _closePolygon(corners) {
  const out = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const seg = jitteredSegment(a, b);
    // Push every point except the last -- the last is the next segment's
    // first point and would otherwise be duplicated.
    for (let j = 0; j < seg.length - 1; j++) out.push(seg[j]);
  }
  return out;
}

// Per-shard clip-path polygon, plus the vertical centre used as the
// shard's spin pivot (so a shard rotates around itself, not around the
// blade centre) and the horizontal centre used to bias the shard's drift
// direction in FLIGHTS.
function buildPieceShapes() {
  const shapes = [];
  for (let i = 0; i < SHARD_CORNERS.length; i++) {
    const poly = _closePolygon(SHARD_CORNERS[i]);

    let sumX = 0;
    let sumY = 0;
    for (const p of poly) { sumX += p[0]; sumY += p[1]; }

    shapes.push({
      polygon: 'polygon(' +
        poly.map((p) => p[0].toFixed(2) + '% ' + p[1].toFixed(2) + '%').join(',') +
        ')',
      centerX: sumX / poly.length,
      centerY: sumY / poly.length
    });
  }
  return shapes;
}

const PIECE_SHAPES = buildPieceShapes();

// --- flight paths -------------------------------------------------------------
// Deterministic per shard so a given sword always breaks the same way.
//
// Drift direction is taken from each shard's own centroid:
//   - centerX < 50 -> drifts left;  centerX > 50 -> drifts right.
//   - centerY < 50 -> drifts up;    centerY > 50 -> drifts down.
// So a shattering blade opens OUTWARD on both axes. Left-side shards
// peel left, right-side shards peel right, top shards lift away from the
// crossguard, base shards drop away from the tip. This is what makes the
// asymmetric shard shapes legible: the corner chip peels to the upper
// right, the left-side splinter peels to the lower left, and every crack
// (horizontal or vertical) opens a real gap rather than the two pieces
// staying nested along their shared edge.
//
// Magnitudes are sized so the gap at every crack is at least a couple of
// pixels -- comfortably wider than the crack-jitter wobble -- while still
// keeping the whole broken cluster recognisable as a sword. Tilt is
// biased the same way as dx, so a piece leaning away from the blade
// reads as having peeled off rather than as having been rotated in
// place. The red sword mirrors the blue one.
const FLIGHTS = PIECE_SHAPES.map((shape, i) => {
  const seed = i + 1;
  const dxDir = shape.centerX < 50 ? -1 : 1;
  const dyDir = shape.centerY < 50 ? -1 : 1;
  return {
    dx:  dxDir * (2 + (seed * 5) % 4),         // 2..5 px sideways
    dy:  dyDir * (2 + (seed * 3) % 4),         // 2..5 px along the blade
    rot: dxDir * (8 + (seed * 11) % 13)        // 8..20 degrees of tilt
  };
});

// Shatter: slow, floaty, no gravity. Shards ease outward and hold there,
// so the blade keeps its silhouette while visibly separated. The opacity
// only dims slightly -- it never reaches 0 -- so the broken sword stays
// readable on screen as a broken sword.
const SHATTER = {
  x:    'transform 1.8s cubic-bezier(0.16, 0.84, 0.44, 1)',
  fall: 'transform 1.8s cubic-bezier(0.16, 0.84, 0.44, 1)',
  body: 'transform 1.8s cubic-bezier(0.25, 1, 0.5, 1), opacity 1.8s ease-out'
};
// Mend: quicker, shards snap home.
const MEND = {
  x:    'transform 0.5s ease-out',
  fall: 'transform 0.5s ease-out',
  body: 'transform 0.5s ease-out, opacity 0.5s ease-out'
};

const LAYER_CSS = 'position:absolute;left:0;top:0;width:100%;height:100%';

export class SwordGaugeView {
  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'display:none',
      'flex:none',
      'width:100%',
      'justify-content:center',
      'align-items:flex-start',
      'gap:' + px(SWORD_GAP)
    ].join(';');

    this._swords = {};
    this._swords.blue = this._buildSword(LEFT_TEAM);
    this._swords.red  = this._buildSword(RIGHT_TEAM);
    this.el.appendChild(this._swords.blue.el);
    this.el.appendChild(this._swords.red.el);
  }

  setVisible(visible) {
    this.el.style.display = visible ? 'flex' : 'none';
  }

  // Ratios are current power / starting power per team. Cheap to call
  // every frame: a sword only touches the DOM when its broken-shard count
  // changes.
  setRatios(blueRatio, redRatio) {
    this._applySwordState(this._swords.blue, blueRatio);
    this._applySwordState(this._swords.red,  redRatio);
  }

  // Break a sword from the tip down. Shard i (0 = tip, N-1 = base) is
  // intact iff i >= N * (1 - ratio), so the number of broken shards is
  // ceil(N * (1 - ratio)). A ratio of 1 keeps every shard whole; 0 breaks
  // them all. Ratios above 1 are clamped; the sword never grows.
  _applySwordState(sword, ratio) {
    if (ratio > 1) ratio = 1;
    if (ratio < 0) ratio = 0;

    let broken = Math.ceil(SWORD_PIECES * (1 - ratio) - 1e-6);
    if (broken < 0) broken = 0;
    if (broken > SWORD_PIECES) broken = SWORD_PIECES;
    if (broken === sword.broken) return;
    sword.broken = broken;

    for (let i = 0; i < SWORD_PIECES; i++) {
      this._setPieceBroken(sword.pieces[i], i < broken);
    }
  }

  // Idempotent: the transition set depends only on the target state, so
  // re-applying a shard that is already mid-flight changes nothing.
  _setPieceBroken(piece, broken) {
    const t = broken ? SHATTER : MEND;
    piece.x.style.transition    = t.x;
    piece.fall.style.transition = t.fall;
    piece.body.style.transition = t.body;

    if (broken) {
      piece.x.style.transform    = 'translateX(' + piece.dx + 'px)';
      piece.fall.style.transform = 'translateY(' + piece.dy + 'px)';
      piece.body.style.transform = 'rotate(' + piece.rot + 'deg)';
      // Dead steel: the piece has left the blade and lost its team
      // colour. The 0.72 opacity lets the shard's own drop-shadow read
      // through, so it still looks solid rather than like a flat cutout.
      piece.body.style.background = BROKEN_TINT;
      piece.body.style.opacity    = '0.72';
    } else {
      piece.x.style.transform    = '';
      piece.fall.style.transform = '';
      piece.body.style.transform = '';
      // Reassembled shards snap back to their team tint.
      piece.body.style.background = piece.tint;
      piece.body.style.opacity    = '1';
    }
  }

  // One sword: hilt first, blade shards on top so flying shards pass over
  // the crossguard instead of hiding behind it.
  _buildSword(teamId) {
    const mirror = teamId === RIGHT_TEAM ? -1 : 1;

    const el = document.createElement('div');
    el.style.cssText = [
      'position:relative',
      'flex:none',
      'width:' + px(SWORD_WIDTH),
      'height:' + px(SWORD_HEIGHT),
      // drop-shadow on the container (rather than per-part) keeps the
      // whole sword casting one coherent shadow as it breaks apart.
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,0.6))'
    ].join(';');

    this._appendHilt(el);

    const blade = document.createElement('div');
    blade.style.cssText = [
      'position:absolute',
      'left:' + px((SWORD_WIDTH - SWORD_BLADE_WIDTH) / 2),
      'top:0',
      'width:' + px(SWORD_BLADE_WIDTH),
      'height:' + px(SWORD_BLADE_HEIGHT)
    ].join(';');
    el.appendChild(blade);

    const pieces = [];
    for (let i = 0; i < SWORD_PIECES; i++) {
      pieces.push(this._buildPiece(blade, i, teamId, mirror));
    }

    return { el: el, pieces: pieces, broken: 0 };
  }

  _buildPiece(blade, index, teamId, mirror) {
    const x = document.createElement('div');
    x.style.cssText = LAYER_CSS;

    const fall = document.createElement('div');
    fall.style.cssText = LAYER_CSS;

    const body = document.createElement('div');
    body.style.cssText = [
      LAYER_CSS,
      'background:' + SWORD_TINT[teamId],
      'clip-path:' + PIECE_SHAPES[index].polygon,
      'transform-origin:50% ' + PIECE_SHAPES[index].centerY.toFixed(1) + '%'
    ].join(';');

    fall.appendChild(body);
    x.appendChild(fall);
    blade.appendChild(x);

    const flight = FLIGHTS[index];
    return {
      x: x,
      fall: fall,
      body: body,
      dx: flight.dx * mirror,
      dy: flight.dy,
      rot: flight.rot * mirror,
      // Kept so _setPieceBroken can swap the shard's background between
      // its team tint and BROKEN_TINT as it breaks and mends.
      tint: SWORD_TINT[teamId]
    };
  }

  // Crossguard, grip and pommel. Never touched after construction.
  _appendHilt(el) {
    const addPart = (width, height, top, background, radius) => {
      const part = document.createElement('div');
      part.style.cssText = [
        'position:absolute',
        'left:' + px((SWORD_WIDTH - width) / 2),
        'top:' + px(top),
        'width:' + px(width),
        'height:' + px(height),
        'background:' + background,
        'border-radius:' + radius,
        'box-shadow:inset 0 1px 0 rgba(255,220,150,0.35)'
      ].join(';');
      el.appendChild(part);
    };

    const guardTop  = SWORD_BLADE_HEIGHT;
    const gripTop   = guardTop + SWORD_GUARD_HEIGHT;
    const pommelTop = gripTop + SWORD_GRIP_HEIGHT;

    // Crossguard: wide brass bar, lit on top, shadowed underneath.
    addPart(
      SWORD_WIDTH, SWORD_GUARD_HEIGHT, guardTop,
      'linear-gradient(180deg,' + BRASS_LIGHT + ' 0%,' + BRASS_MID +
        ' 50%,' + BRASS_DARK + ' 100%)',
      '2px'
    );
    // Grip: dark leather with thin wrap bands.
    addPart(
      SWORD_GRIP_WIDTH, SWORD_GRIP_HEIGHT, gripTop,
      'repeating-linear-gradient(180deg,#5a3d26 0px,#5a3d26 1.5px,' +
        '#2e1e12 1.5px,#2e1e12 3px)',
      '1px'
    );
    // Pommel: small brass ball closing off the grip.
    addPart(
      SWORD_POMMEL_WIDTH, SWORD_POMMEL_HEIGHT, pommelTop,
      'radial-gradient(circle at 38% 32%,' + BRASS_LIGHT + ' 0%,' +
        BRASS_MID + ' 60%,' + BRASS_DARK + ' 100%)',
      '50%'
    );
  }
}
// ===== src/render/ShieldIconBuilder.js =====
// Builds the composite shield textures used by UnitOverlayView's world-
// space unit markers. Each unit's shield is partitioned into several
// irregular CHUNKS via a Voronoi assignment from scattered seed points,
// clipped to the shield's silhouette. Each chunk is its own canvas
// texture, so the overlay can hide / animate individual chunks as the
// unit's total HP drops — a shield "losing chunks" as it takes damage.
//
// CHUNK LAYOUT
// Seeds are placed at random points inside the shield's silhouette. Every
// pixel inside the shield belongs to the nearest seed, producing a
// Voronoi partition: irregular polygon-ish chunks scattered around the
// shield — some near the perimeter, some in the middle — so the shield
// sheds chunks from ALL SIDES, not from one edge inward.
//
// BREAK THRESHOLDS
// Each chunk's break threshold is derived from its AREA fraction. Chunks
// are sorted by how far their centroid is from the shield's own centre
// of mass (edge-most first), and thresholds are assigned by CUMULATIVE
// area in that order. Result: as HP drops, the shield sheds edge chunks
// first and shrinks inward, and the total visual area lost roughly
// tracks the fraction of HP lost. Not exact — the user asked for
// rough — but close enough that the shield reads as "losing what it
// should".
//
// Patterns are deterministic per cache key (typeId|undead|teamId) via a
// seeded PRNG, so a given unit type's shield always shatters the same
// way, but different types shatter differently.
//
// The icon inside the shield is the SAME composite SVG the army bar
// draws (see UnitIcon.js).
import * as THREE from 'three';
import { TeamColors } from './TeamColors.js';
import { unitIconSvg } from '../ui/UnitIcon.js';

// Number of chunks the shield is split into.
export const SHIELD_PIECE_COUNT = 6;

// Texture size per piece canvas.
const TEXTURE_SIZE = 128;

// Padding around the shield in the texture's own 0-1 square.
const SHIELD_PAD = 0.06;

// Shield silhouette, in normalised (0-1) coordinates inside the padded
// area. Heater/kite shape: flat top, straight sides through the mid-line,
// tapering to a point at the base.
const SHIELD_OUTLINE = [
  { y: 0.00, xl: 0.15, xr: 0.85 },
  { y: 0.20, xl: 0.03, xr: 0.97 },
  { y: 0.50, xl: 0.00, xr: 1.00 },
  { y: 0.78, xl: 0.10, xr: 0.90 },
  { y: 1.00, xl: 0.50, xr: 0.50 }
];

// --- PRNG ------------------------------------------------------------------

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- shield outline helpers ------------------------------------------------

// Linear interpolation of the shield outline's x-range at a given y.
function shieldXRangeAt(y) {
  for (let i = 0; i < SHIELD_OUTLINE.length - 1; i++) {
    const a = SHIELD_OUTLINE[i];
    const b = SHIELD_OUTLINE[i + 1];
    if (y >= a.y && y <= b.y) {
      const t = (y - a.y) / (b.y - a.y);
      return [a.xl + (b.xl - a.xl) * t, a.xr + (b.xr - a.xr) * t];
    }
  }
  return [0.5, 0.5];
}

// True if (x, y) is inside the shield silhouette. Coordinates are in the
// same normalised shield space as SHIELD_OUTLINE.
function isInsideShield(x, y) {
  if (x < 0 || x > 1) return false;
  if (y < 0 || y > 1) return false;
  const [xl, xr] = shieldXRangeAt(y);
  return x >= xl && x <= xr;
}

// Canvas-pixel coordinate -> normalised shield coordinate. The +0.5
// samples the pixel CENTRE rather than its top-left corner, which keeps
// the Voronoi region boundaries from biasing half a pixel toward the
// left/top.
function pixelToShieldX(pxi, S) {
  return (pxi + 0.5 - SHIELD_PAD * S) / (S * (1 - 2 * SHIELD_PAD));
}
function pixelToShieldY(pyi, S) {
  return (pyi + 0.5 - SHIELD_PAD * S) / (S * (1 - 2 * SHIELD_PAD));
}

// --- seed generation -------------------------------------------------------

// Best-candidate dart throwing: for each seed, sample many random
// candidates inside the shield and pick the one FARTHEST from the seeds
// chosen so far. Produces well-spread seeds with no clustering, which in
// turn produces a Voronoi partition whose chunks all have comparable —
// but not identical — areas.
function generateSeeds(pieceCount, rng) {
  const seeds = [];
  const candidatesPerSeed = 40;

  for (let i = 0; i < pieceCount; i++) {
    let bestX = 0.5;
    let bestY = 0.5;
    let bestDist = -Infinity;

    for (let c = 0; c < candidatesPerSeed; c++) {
      const x = rng();
      const y = rng();
      if (!isInsideShield(x, y)) continue;

      let dMin = Infinity;
      for (let k = 0; k < seeds.length; k++) {
        const dx = x - seeds[k][0];
        const dy = y - seeds[k][1];
        const d = dx * dx + dy * dy;
        if (d < dMin) dMin = d;
      }
      if (dMin > bestDist) {
        bestDist = dMin;
        bestX = x;
        bestY = y;
      }
    }
    seeds.push([bestX, bestY]);
  }
  return seeds;
}

// --- Voronoi assignment ----------------------------------------------------

// Assigns every pixel inside the shield to its nearest seed. Returns:
//   regionMap  Int8Array(S*S): chunk index, or -1 for pixels outside the
//              shield.
//   areas      Int32Array(pieceCount): number of pixels in each chunk.
//   centroids  Array of [x, y] per chunk, in normalised shield coords
//              (used for the edge-vs-interior break ordering).
//   shieldCOM  [x, y] centre of mass of the whole shield.
function assignRegions(S, pieceCount, seeds) {
  const regionMap = new Int8Array(S * S);
  const areas = new Int32Array(pieceCount);
  const centroidX = new Float64Array(pieceCount);
  const centroidY = new Float64Array(pieceCount);

  let shieldCx = 0;
  let shieldCy = 0;
  let shieldCount = 0;

  for (let yi = 0; yi < S; yi++) {
    const ny = pixelToShieldY(yi, S);
    for (let xi = 0; xi < S; xi++) {
      const nx = pixelToShieldX(xi, S);
      const p = yi * S + xi;

      if (!isInsideShield(nx, ny)) {
        regionMap[p] = -1;
        continue;
      }

      let bestI = 0;
      let bestD = Infinity;
      for (let k = 0; k < pieceCount; k++) {
        const dx = nx - seeds[k][0];
        const dy = ny - seeds[k][1];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestI = k; }
      }

      regionMap[p] = bestI;
      areas[bestI]++;
      centroidX[bestI] += nx;
      centroidY[bestI] += ny;
      shieldCx += nx;
      shieldCy += ny;
      shieldCount++;
    }
  }

  const centroids = [];
  for (let k = 0; k < pieceCount; k++) {
    if (areas[k] > 0) {
      centroids.push([centroidX[k] / areas[k], centroidY[k] / areas[k]]);
    } else {
      // Empty chunk — put its centroid at the shield's approximate
      // centre so the edge-sort doesn't crash on a NaN.
      centroids.push([0.5, 0.5]);
    }
  }

  const shieldCOM = shieldCount > 0
    ? [shieldCx / shieldCount, shieldCy / shieldCount]
    : [0.5, 0.5];

  return { regionMap, areas, centroids, shieldCOM };
}

// --- thresholds ------------------------------------------------------------

// Builds each chunk's break threshold (as an HP fraction) from its area.
//
// Chunks are sorted by distance from the shield's centre of mass,
// DESCENDING — the chunk nearest the perimeter breaks first, the chunk
// nearest the centre breaks last. Within that order, thresholds are
// assigned by CUMULATIVE AREA: chunk at rank k breaks when the unit's HP
// has fallen below the fraction of the shield that is still intact after
// chunks 0..k have been removed. So the total shield area shed at any
// moment tracks the HP fraction lost, on average.
function computeThresholds(areas, centroids, shieldCOM) {
  const n = areas.length;
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);

  // Edge-most first.
  order.sort((a, b) => {
    const da = Math.hypot(
      centroids[a][0] - shieldCOM[0],
      centroids[a][1] - shieldCOM[1]
    );
    const db = Math.hypot(
      centroids[b][0] - shieldCOM[0],
      centroids[b][1] - shieldCOM[1]
    );
    return db - da;
  });

  // Minimum total-area floor so a zero-area piece cannot make every
  // threshold 1.0.
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.max(areas[i], 1);

  const thresholds = new Array(n);
  let cum = 0;
  for (const idx of order) {
    cum += Math.max(areas[idx], 1);
    thresholds[idx] = Math.max(0, 1 - cum / total);
  }
  return thresholds;
}

// --- mask building ---------------------------------------------------------

// Builds a full-canvas mask for one chunk: white pixels where the chunk
// exists, transparent everywhere else. Drawn with
// globalCompositeOperation = 'destination-in', this leaves the shield
// content only where the chunk is.
function buildPieceMask(S, pieceIndex, regionMap) {
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  const imgData = ctx.createImageData(S, S);
  const data = imgData.data;

  for (let p = 0; p < S * S; p++) {
    if (regionMap[p] === pieceIndex) {
      const o = p * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// --- piece layout ----------------------------------------------------------

// Builds the whole layout for one shield: masks + thresholds.
function buildPieceLayout(S, pieceCount, rng) {
  const seeds = generateSeeds(pieceCount, rng);
  const { regionMap, areas, centroids, shieldCOM } =
    assignRegions(S, pieceCount, seeds);

  const thresholds = computeThresholds(areas, centroids, shieldCOM);

  const masks = [];
  for (let i = 0; i < pieceCount; i++) {
    masks.push(buildPieceMask(S, i, regionMap));
  }

  return { masks, thresholds };
}

// --- shield drawing --------------------------------------------------------

function px(v, W) { return SHIELD_PAD * W + v * W * (1 - 2 * SHIELD_PAD); }
function py(v, H) { return SHIELD_PAD * H + v * H * (1 - 2 * SHIELD_PAD); }

function traceShieldOutline(ctx, W, H) {
  ctx.beginPath();
  ctx.moveTo(px(SHIELD_OUTLINE[0].xl, W), py(SHIELD_OUTLINE[0].y, H));
  ctx.lineTo(px(SHIELD_OUTLINE[0].xr, W), py(SHIELD_OUTLINE[0].y, H));
  for (let i = 1; i < SHIELD_OUTLINE.length; i++) {
    const { y } = SHIELD_OUTLINE[i];
    const [, xr] = shieldXRangeAt(y);
    ctx.lineTo(px(xr, W), py(y, H));
  }
  for (let i = SHIELD_OUTLINE.length - 1; i >= 0; i--) {
    const { y } = SHIELD_OUTLINE[i];
    const [xl] = shieldXRangeAt(y);
    ctx.lineTo(px(xl, W), py(y, H));
  }
  ctx.closePath();
}

// Draws the full shield content (fill + shade + icon + outline stroke)
// into the current context.
function drawShieldContent(ctx, W, H, teamCss, iconImg) {
  traceShieldOutline(ctx, W, H);
  ctx.fillStyle = teamCss;
  ctx.fill();

  ctx.save();
  traceShieldOutline(ctx, W, H);
  ctx.clip();
  const grad = ctx.createRadialGradient(
    W * 0.5, H * 0.35, 0,
    W * 0.5, H * 0.35, W * 0.7
  );
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.00)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  if (iconImg) {
    const iconSize = W * (1 - 2 * SHIELD_PAD) * 0.72;
    const ix = (W - iconSize) / 2;
    const iy = (H - iconSize) / 2;
    ctx.drawImage(iconImg, ix, iy, iconSize, iconSize);
  }

  traceShieldOutline(ctx, W, H);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Composes one chunk's canvas: full shield content, then destination-in
// with the chunk's mask. The canvas is left with only the pixels that
// belong to that chunk.
function composePiece(ctx, S, mask, teamCss, iconImg) {
  ctx.clearRect(0, 0, S, S);
  drawShieldContent(ctx, S, S, teamCss, iconImg);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

// --- cache -----------------------------------------------------------------

const _cache = new Map();

function cacheKey(typeId, isUndead, teamId, isThrall) {
  return `${typeId}|${isUndead ? 'u' : 'a'}|${teamId}` +
    (isThrall ? '|thrall' : '');
}

// Draws a blood drop on an offscreen canvas for use as the shield's
// icon. Sized to fill the same slot the SVG icon occupies (72% of the
// shield's inner area, centred) so the visual weight matches. Dark
// outline keeps it legible on any team colour the shield might be.
function buildBloodIcon() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const cx = size / 2;
  const cy = size / 2;
  const r = 34;

  const drawDrop = (radius) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius * 1.6);
    ctx.bezierCurveTo(
      cx + radius * 0.9, cy - radius * 0.5,
      cx + radius, cy + radius * 0.35,
      cx + radius * 0.7, cy + radius * 0.7
    );
    ctx.bezierCurveTo(
      cx + radius * 0.35, cy + radius,
      cx - radius * 0.35, cy + radius,
      cx - radius * 0.7, cy + radius * 0.7
    );
    ctx.bezierCurveTo(
      cx - radius, cy + radius * 0.35,
      cx - radius * 0.9, cy - radius * 0.5,
      cx, cy - radius * 1.6
    );
    ctx.closePath();
  };

  // Dark outer ring for contrast against any team colour.
  drawDrop(r + 3);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.fill();

  // Main blood fill.
  drawDrop(r);
  ctx.fillStyle = '#c81a1a';
  ctx.fill();

  // Small highlight — reads as wet and organic at battle zoom.
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.32, cy + r * 0.10, r * 0.16, r * 0.34, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.fill();

  return canvas;
}

// --- public entry ----------------------------------------------------------

export function getShieldEntry(typeDef, isUndead, teamId, isThrall = false) {
  const key = cacheKey(typeDef.id, isUndead, teamId, isThrall);
  let entry = _cache.get(key);
  if (entry) return entry;

  const S = TEXTURE_SIZE;
  const teamColor = TeamColors[teamId] ?? 0xaaaaaa;
  const teamCss = '#' + teamColor.toString(16).padStart(6, '0');

  // Deterministic per-key random crack pattern.
  const rng = mulberry32(hashString(key));
  const { masks, thresholds } = buildPieceLayout(S, SHIELD_PIECE_COUNT, rng);

  // Build canvases synchronously without the icon. Each canvas is
  // composed from the FULL shield content, then masked down to its chunk.
  const canvases = [];
  const contexts = [];
  for (let i = 0; i < SHIELD_PIECE_COUNT; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    composePiece(ctx, S, masks[i], teamCss, null);
    canvases.push(canvas);
    contexts.push(ctx);
  }

  const pieces = [];
  for (let i = 0; i < SHIELD_PIECE_COUNT; i++) {
    const tex = new THREE.CanvasTexture(canvases[i]);
    if (THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    pieces.push(tex);
  }

  entry = { pieces, thresholds, version: 0 };
  _cache.set(key, entry);

  // Icon pass. Thralls get a blood-drop icon drawn synchronously — no
  // network or SVG decode step — so a fresh thrall's shield is complete
  // on its first frame. Everyone else loads their unit's SVG icon
  // asynchronously and patches the piece canvases in when it lands.
  if (isThrall) {
    const bloodIcon = buildBloodIcon();
    for (let i = 0; i < SHIELD_PIECE_COUNT; i++) {
      composePiece(contexts[i], S, masks[i], teamCss, bloodIcon);
      pieces[i].needsUpdate = true;
    }
    entry.version++;
  } else {
    const svg = unitIconSvg(typeDef, isUndead);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();

    img.onload = () => {
      for (let i = 0; i < SHIELD_PIECE_COUNT; i++) {
        composePiece(contexts[i], S, masks[i], teamCss, img);
        pieces[i].needsUpdate = true;
      }
      entry.version++;
    };

    img.onerror = () => {
      // Silent: the icon-less shield is a valid fallback.
    };

    img.src = url;
  }

  return entry;
}
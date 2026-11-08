// ===== src/render/ShieldIconBuilder.js =====
// Builds the composite banner textures used by UnitOverlayView's world-
// space unit markers. Each unit's banner is partitioned into several
// irregular CHUNKS via a Voronoi assignment from scattered seed points,
// clipped to the banner's outer silhouette. Each chunk is its own canvas
// texture, so the overlay can hide / animate individual chunks as the
// unit's total HP drops — a banner "losing chunks" as it takes damage.
//
// TWO BANNER STYLES
// The 'legacyBanners' setting picks which pipeline builds the textures:
//
//   NEW (default) — race-shaped outlines from BannerShape.js, white
//     silhouettes from UnitBannerIcon.js, team colour run through
//     tuneTeamColor() to darken + saturate it, and a race-coloured
//     border band with a dark outer rim. The banner is a modern marker
//     tuned for legibility of shape and silhouette at every zoom.
//
//   LEGACY — the pre-refactor look: fixed heater-shield outline, the
//     detailed multi-element composite icon from UnitIcon.js, raw team
//     colour (no tuning), plain black stroke. Visually identical to the
//     original banner system, preserved behind a toggle for players who
//     prefer it.
//
// Both styles share the same chunk-break pipeline (Voronoi chunks,
// cumulative-area thresholds, cache, entry.version contract). Only the
// SHAPE, the team-colour transform, the border treatment, and the icon
// source differ. The cache key includes the legacy flag so both styles
// can coexist without clobbering each other — flipping the toggle in
// the settings panel invalidates every billboard (see UnitOverlayView)
// and rebuilds through the appropriate pipeline on the next frame.
//
// CHUNK LAYOUT
// Seeds are placed at random points inside the banner's silhouette. Every
// pixel inside the banner belongs to the nearest seed, producing a
// Voronoi partition: irregular polygon-ish chunks scattered around the
// banner — some near the perimeter, some in the middle — so the banner
// sheds chunks from ALL SIDES, not from one edge inward.
//
// BREAK THRESHOLDS
// Each chunk's break threshold is derived from its AREA fraction. Chunks
// are sorted by how far their centroid is from the banner's own centre
// of mass (edge-most first), and thresholds are assigned by CUMULATIVE
// area in that order. As HP drops, the banner sheds edge chunks first
// and shrinks inward.
//
// Patterns are deterministic per cache key via a seeded PRNG, so a
// given unit type's banner always shatters the same way, but different
// types shatter differently.
import * as THREE from 'three';
import { TeamColors } from './TeamColors.js';
import { unitBannerIconSvg } from '../ui/UnitBannerIcon.js';
import { unitIconSvg } from '../ui/UnitIcon.js';
import { SettingsStore } from '../ui/settings/SettingsStore.js';
import {
  getBannerShape,
  isInsideBannerOutline,
  traceBannerOutline
} from './BannerShape.js';

// Number of chunks the banner is split into.
export const SHIELD_PIECE_COUNT = 6;

// Texture size per piece canvas.
const TEXTURE_SIZE = 128;

// Padding around the banner in the texture's own 0-1 square.
const SHIELD_PAD = 0.06;

// --- legacy banner outline -------------------------------------------------
//
// The fixed heater-shield silhouette the pre-refactor banner used. Kept
// here rather than in BannerShape.js so the legacy style is fully self-
// contained: one flag, one code path, one shape — nothing about the new
// race-driven system leaks into it.
const LEGACY_SHIELD_OUTLINE = [
  { y: 0.00, xl: 0.15, xr: 0.85 },
  { y: 0.20, xl: 0.03, xr: 0.97 },
  { y: 0.50, xl: 0.00, xr: 1.00 },
  { y: 0.78, xl: 0.10, xr: 0.90 },
  { y: 1.00, xl: 0.50, xr: 0.50 }
];

function getLegacyBannerShape() {
  return {
    id: 'legacy',
    outline: LEGACY_SHIELD_OUTLINE,
    // Single black stroke — the old banner had no separate outer rim and
    // race-coloured band. The isLegacy flag below tells drawShieldContent
    // to use the simpler single-stroke border path.
    borderColor: 'rgba(0, 0, 0, 0.85)',
    borderWidth: 2,
    isLegacy: true
  };
}

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

// --- team-color tuning -----------------------------------------------------
//
// Turns a raw team color into the dark, saturated fill the NEW banner
// needs. The transform is done in HSL space because that is where "darken
// and saturate" is actually expressible.
//
// LEGACY banner style deliberately skips this — the old banner used the
// raw team color, and reproducing that is the whole point of the toggle.
function tuneTeamColor(rgbInt) {
  const r = ((rgbInt >> 16) & 0xff) / 255;
  const g = ((rgbInt >> 8) & 0xff) / 255;
  const b = (rgbInt & 0xff) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l0 = (max + min) / 2;

  let h = 0;
  let s0 = 0;
  if (max !== min) {
    const d = max - min;
    s0 = l0 > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r)      h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h /= 6;
  }

  const s1 = Math.min(1, Math.max(0.55, s0 * 1.5));
  const l1 = Math.max(0.14, Math.min(0.40, l0 * 0.55));

  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l1 < 0.5 ? l1 * (1 + s1) : l1 + s1 - l1 * s1;
  const p = 2 * l1 - q;
  const r2 = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g2 = Math.round(hue2rgb(p, q, h) * 255);
  const b2 = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

  return '#' + ((r2 << 16) | (g2 << 8) | b2)
    .toString(16)
    .padStart(6, '0');
}

// Raw hex CSS string. The legacy banner path writes this straight to
// fillStyle, matching the pre-refactor behaviour exactly.
function rawTeamCss(rgbInt) {
  return '#' + rgbInt.toString(16).padStart(6, '0');
}

// --- pixel <-> normalized --------------------------------------------------

function pixelToShieldX(pxi, S) {
  return (pxi + 0.5 - SHIELD_PAD * S) / (S * (1 - 2 * SHIELD_PAD));
}
function pixelToShieldY(pyi, S) {
  return (pyi + 0.5 - SHIELD_PAD * S) / (S * (1 - 2 * SHIELD_PAD));
}

function px(v, W) { return SHIELD_PAD * W + v * W * (1 - 2 * SHIELD_PAD); }
function py(v, H) { return SHIELD_PAD * H + v * H * (1 - 2 * SHIELD_PAD); }

// --- seed generation -------------------------------------------------------

function generateSeeds(pieceCount, rng, outline) {
  const seeds = [];
  const candidatesPerSeed = 40;

  for (let i = 0; i < pieceCount; i++) {
    let bestX = 0.5;
    let bestY = 0.5;
    let bestDist = -Infinity;

    for (let c = 0; c < candidatesPerSeed; c++) {
      const x = rng();
      const y = rng();
      if (!isInsideBannerOutline(outline, x, y)) continue;

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

function assignRegions(S, pieceCount, seeds, outline) {
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

      if (!isInsideBannerOutline(outline, nx, ny)) {
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
      centroids.push([0.5, 0.5]);
    }
  }

  const shieldCOM = shieldCount > 0
    ? [shieldCx / shieldCount, shieldCy / shieldCount]
    : [0.5, 0.5];

  return { regionMap, areas, centroids, shieldCOM };
}

// --- thresholds ------------------------------------------------------------

function computeThresholds(areas, centroids, shieldCOM) {
  const n = areas.length;
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);

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

function buildPieceLayout(S, pieceCount, rng, outline) {
  const seeds = generateSeeds(pieceCount, rng, outline);
  const { regionMap, areas, centroids, shieldCOM } =
    assignRegions(S, pieceCount, seeds, outline);

  const thresholds = computeThresholds(areas, centroids, shieldCOM);

  const masks = [];
  for (let i = 0; i < pieceCount; i++) {
    masks.push(buildPieceMask(S, i, regionMap));
  }

  return { masks, thresholds };
}

// --- banner drawing --------------------------------------------------------

// Draws the full banner content. Two branches:
//
//   Legacy — team-color fill, 0.22 gradient highlight (the pre-refactor
//     value), the detailed composite icon, single black stroke at
//     lineWidth = borderWidth. Matches the old look exactly.
//
//   New — team-color fill (already tuned darker by the caller), 0.10
//     gradient highlight, the white silhouette icon, a wide dark outer
//     rim, and a race-coloured inner band. The two-stroke structure
//     gives the banner a crisp silhouette against the world background
//     while keeping the race hue legible on top of the dark fill.
function drawShieldContent(ctx, W, H, shape, teamCss, iconImg) {
  const { outline, borderColor, borderWidth, isLegacy } = shape;

  traceBannerOutline(ctx, outline, W, H, px, py);
  ctx.fillStyle = teamCss;
  ctx.fill();

  ctx.save();
  traceBannerOutline(ctx, outline, W, H, px, py);
  ctx.clip();
  const grad = ctx.createRadialGradient(
    W * 0.5, H * 0.35, 0,
    W * 0.5, H * 0.35, W * 0.7
  );
  grad.addColorStop(0, isLegacy ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.10)');
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

  if (isLegacy) {
    // Single black stroke — the pre-refactor look.
    traceBannerOutline(ctx, outline, W, H, px, py);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth;
    ctx.stroke();
  } else if (shape.secondBorderColor) {
    // DOUBLE border (skeleton). Four concentric strokes, each drawn
    // narrower than the previous, so the previous one's outer edge
    // stays visible as a band. Because every stroke is centered on
    // the same path, a stroke of width X paints X/2 outside and X/2
    // inside the outline edge; drawing (W+6, W+4, W+2, W) leaves
    // visible bands of 1 unit each between adjacent pairs, then the
    // innermost stroke fills the middle. Result, outside-to-inside:
    //   1u dark | 1u firstColor | 1u dark | (W/2)u secondColor | fill
    // With borderWidth 3.5 that reads as two white bands separated by
    // a dark gap — the heraldic double border.
    traceBannerOutline(ctx, outline, W, H, px, py);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.lineWidth = borderWidth + 6;
    ctx.stroke();

    traceBannerOutline(ctx, outline, W, H, px, py);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth + 4;
    ctx.stroke();

    traceBannerOutline(ctx, outline, W, H, px, py);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.lineWidth = borderWidth + 2;
    ctx.stroke();

    traceBannerOutline(ctx, outline, W, H, px, py);
    ctx.strokeStyle = shape.secondBorderColor;
    ctx.lineWidth = borderWidth;
    ctx.stroke();
  } else {
    // SINGLE border (human/goblin/hobgoblin). Dark outer rim + race-
    // colored inner band, the standard treatment.
    traceBannerOutline(ctx, outline, W, H, px, py);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.lineWidth = borderWidth + 2;
    ctx.stroke();

    traceBannerOutline(ctx, outline, W, H, px, py);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth;
    ctx.stroke();
  }
}

function composePiece(ctx, S, mask, shape, teamCss, iconImg) {
  ctx.clearRect(0, 0, S, S);
  drawShieldContent(ctx, S, S, shape, teamCss, iconImg);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

// --- cache -----------------------------------------------------------------

const _cache = new Map();

function cacheKey(typeId, isUndead, teamId, isThrall, isLegacy) {
  return `${typeId}|${isUndead ? 'u' : 'a'}|${teamId}` +
    (isThrall ? '|thrall' : '') +
    (isLegacy ? '|legacy' : '');
}

// Draws a blood drop on an offscreen canvas for use as the banner's
// icon (thralls only). Sized to fill the same slot the SVG icon
// occupies so the visual weight matches.
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

  drawDrop(r + 3);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.fill();

  drawDrop(r);
  ctx.fillStyle = '#c81a1a';
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(cx - r * 0.32, cy + r * 0.10, r * 0.16, r * 0.34, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.fill();

  return canvas;
}

// --- public entry ----------------------------------------------------------

export function getShieldEntry(typeDef, isUndead, teamId, isThrall = false) {
  // Which pipeline to use. Reads the setting once at cache-miss time —
  // UnitOverlayView rebuilds entries when the setting flips, so this
  // always reflects the current player choice on a fresh build.
  const isLegacy = SettingsStore.get().legacyBanners === true;

  const key = cacheKey(typeDef.id, isUndead, teamId, isThrall, isLegacy);
  let entry = _cache.get(key);
  if (entry) return entry;

  const S = TEXTURE_SIZE;
  const rawTeamColor = TeamColors[teamId] ?? 0xaaaaaa;

  // Team colour path. Legacy keeps the raw hex, new runs it through the
  // darken + saturate transform.
  const teamCss = isLegacy ? rawTeamCss(rawTeamColor) : tuneTeamColor(rawTeamColor);

  // Shape path. Legacy uses the hardcoded heater outline; new uses the
  // race-driven shape from BannerShape.
  const shape = isLegacy
    ? getLegacyBannerShape()
    : getBannerShape(typeDef, isUndead);

  // Deterministic per-key random crack pattern.
  const rng = mulberry32(hashString(key));
  const { masks, thresholds } =
    buildPieceLayout(S, SHIELD_PIECE_COUNT, rng, shape.outline);

  const canvases = [];
  const contexts = [];
  for (let i = 0; i < SHIELD_PIECE_COUNT; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    composePiece(ctx, S, masks[i], shape, teamCss, null);
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

  if (isThrall) {
    const bloodIcon = buildBloodIcon();
    for (let i = 0; i < SHIELD_PIECE_COUNT; i++) {
      composePiece(contexts[i], S, masks[i], shape, teamCss, bloodIcon);
      pieces[i].needsUpdate = true;
    }
    entry.version++;
  } else {
    // Icon source. Legacy uses the detailed multi-element composite
    // from UnitIcon.js (weapon + shield + horse + goblin head + skull
    // layered as a small illustration). New uses the white-silhouette
    // SVG from UnitBannerIcon.js (single bold shape + optional shield
    // frame).
    const svg = isLegacy
      ? unitIconSvg(typeDef, isUndead)
      : unitBannerIconSvg(typeDef, isUndead);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();

    img.onload = () => {
      for (let i = 0; i < SHIELD_PIECE_COUNT; i++) {
        composePiece(contexts[i], S, masks[i], shape, teamCss, img);
        pieces[i].needsUpdate = true;
      }
      entry.version++;
    };

    img.onerror = () => {
      // Silent: the icon-less banner is a valid fallback.
    };

    img.src = url;
  }

  return entry;
}
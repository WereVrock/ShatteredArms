// ===== BannerShape.js =====
// Race-driven outer shape + border for the world-space unit banner
// rendered by ShieldIconBuilder. Each race gets a distinct silhouette so
// a goblin line reads different from a human line at a glance, before
// the icon's silhouette is even parsed.
//
// Shape data is expressed as horizontal row slices: each row has a y in
// [0..1] and left/right x extents in the same space. Helpers interpolate
// between adjacent rows — the same model the old hardcoded SHIELD_OUTLINE
// used in ShieldIconBuilder, now made race-parametric.
//
// COLOR UPDATE: the banner fill is now a darker, more saturated version
// of the team color (see tuneTeamColor in ShieldIconBuilder.js) and the
// silhouette drawn on top is pure white. That means the border band sits
// on a dark fill — so borders are now LIGHT and moderately saturated,
// not dark. Each race keeps a distinct border hue so the shape + hue
// together read as "which race is this", but the border never competes
// with the pure-white silhouette in the middle of the banner.
//
// NO state. NO side effects. Pure data + pure helpers.

export const BannerRace = {
  HUMAN: 'human',
  GOBLIN: 'goblin',
  HOBGOBLIN: 'hobgoblin',
  SKELETON: 'skeleton'
};

// --- outlines -------------------------------------------------------------
// Each outline is an array of { y, xl, xr } in [0..1] normalized space,
// y strictly ascending. Linear interpolation between adjacent rows gives
// the silhouette edge at any intermediate y.

// Clean heater shield: flat top, straight taper, single point at the base.
const HUMAN_OUTLINE = [
  { y: 0.00, xl: 0.15, xr: 0.85 },
  { y: 0.20, xl: 0.03, xr: 0.97 },
  { y: 0.50, xl: 0.00, xr: 1.00 },
  { y: 0.78, xl: 0.10, xr: 0.90 },
  { y: 1.00, xl: 0.50, xr: 0.50 }
];

// Rough, asymmetric, uneven edges. Wavy left/right boundary and an
// off-center small base — reads as scavenged/makeshift, nothing clean.
const GOBLIN_OUTLINE = [
  { y: 0.00, xl: 0.10, xr: 0.88 },
  { y: 0.14, xl: 0.02, xr: 0.98 },
  { y: 0.28, xl: 0.07, xr: 0.90 },
  { y: 0.42, xl: 0.00, xr: 1.00 },
  { y: 0.56, xl: 0.05, xr: 0.94 },
  // Wavy bottom. From y=0.64 down, alternate narrow/wide rows every
  // ~0.06 units of height. The row-based trace uses each row's xl/xr as
  // the silhouette's left/right edge, so the alternating widths produce
  // a scalloped ragged fringe along the bottom — reads as a torn,
  // scavenged goblin banner rather than a clean taper. Four visible
  // waves, asymmetric between left and right (the two edges do not
  // wave in perfect lockstep) so the bottom looks hand-torn, not
  // mechanically zigzagged.
  { y: 0.64, xl: 0.14, xr: 0.82 },
  { y: 0.70, xl: 0.05, xr: 0.92 },
  { y: 0.76, xl: 0.16, xr: 0.80 },
  { y: 0.82, xl: 0.06, xr: 0.90 },
  { y: 0.88, xl: 0.20, xr: 0.78 },
  { y: 0.92, xl: 0.10, xr: 0.86 },
  { y: 0.96, xl: 0.26, xr: 0.72 },
  { y: 1.00, xl: 0.36, xr: 0.64 }
];

// Angular tower shield: nearly straight sides through the mid-line, a
// blunt flat bottom instead of a taper. Disciplined and brutal.
const HOBGOBLIN_OUTLINE = [
  { y: 0.00, xl: 0.14, xr: 0.86 },
  { y: 0.08, xl: 0.03, xr: 0.97 },
  { y: 0.30, xl: 0.02, xr: 0.98 },
  { y: 0.60, xl: 0.02, xr: 0.98 },
  { y: 0.86, xl: 0.05, xr: 0.95 },
  { y: 0.96, xl: 0.14, xr: 0.86 },
  { y: 1.00, xl: 0.24, xr: 0.76 }
];

// Cracked, wavy, off-center point. Nothing about the outline is
// symmetric. The border for this race is deliberately aged-bone (not
// bright white) so the pure-white skeleton-horse silhouette stays the
// focus inside the banner.
// WIDENED vs. the human/heater shape on every row: left edges pushed
// further left and right edges pushed further right, so the skeleton
// banner reads as visibly wider than a human or goblin one at the same
// world scale. The asymmetric, cracked-outline feel is preserved — the
// extra width is spread unevenly across rows, and the bottom point is
// widened too (0.40-0.64 vs the old 0.44-0.60) so the taper still
// reads as a rough crack rather than a clean triangle.
const SKELETON_OUTLINE = [
  { y: 0.00, xl: 0.12, xr: 0.88 },
  { y: 0.08, xl: 0.00, xr: 0.98 },
  { y: 0.18, xl: 0.02, xr: 0.93 },
  { y: 0.30, xl: 0.00, xr: 1.00 },
  { y: 0.42, xl: 0.00, xr: 0.96 },
  { y: 0.54, xl: 0.00, xr: 1.00 },
  { y: 0.66, xl: 0.02, xr: 0.94 },
  { y: 0.78, xl: 0.00, xr: 0.98 },
  { y: 0.88, xl: 0.10, xr: 0.88 },
  { y: 0.94, xl: 0.24, xr: 0.92 },
  { y: 1.00, xl: 0.40, xr: 0.64 }
];

// --- border styling -------------------------------------------------------
//
// Border colors are now LIGHT because the fill beneath them is dark (a
// tone-mapped version of the team color). Each race keeps its own hue so
// shape + hue together read as an identity, but every border sits in a
// brightness band that contrasts against any team-colored dark fill
// without oversaturating toward white — so the pure-white silhouette
// inside the banner stays the brightest thing on the marker.

const BANNER_STYLES = {
  human: {
    outline: HUMAN_OUTLINE,
    borderColor: '#b8bcc6',   // pale steel-blue
    borderWidth: 2.5
  },
  goblin: {
    outline: GOBLIN_OUTLINE,
    borderColor: '#96aa54',   // mid leaf-green
    borderWidth: 2.5
  },
  hobgoblin: {
    outline: HOBGOBLIN_OUTLINE,
    borderColor: '#8a8070',   // pale weathered iron
    borderWidth: 3.5           // thick — reads as heavy plate
  },
  skeleton: {
    outline: SKELETON_OUTLINE,
    // White border to match the white skeleton silhouettes inside the
    // banner — the banner reads as "white ring, white silhouette on
    // dark fill", which is the strongest legibility the skeleton race
    // gets at banner scale. Bumped to 3.5 (from 2.5) so the white ring
    // has real weight and survives the skeleton's cracked outline —
    // the sketchy edges of SKELETON_OUTLINE were pulling the ring thin
    // at the craggy sections, and 3.5 gives the white enough body to
    // read clearly all the way around.
    borderColor: '#ffffff',
    borderWidth: 3.5,
    // SECOND border. When present, ShieldIconBuilder.drawShieldContent
    // paints FOUR concentric strokes at the outline instead of the
    // usual two: dark rim, first border color, thin dark gap, second
    // border color. Result is a white band, a dark gap, and a white
    // inner band — a classic heraldic double-border look that reads as
    // distinct from the single-border human/goblin/hobgoblin shapes.
    // Only the skeleton has this; the field is undefined for every
    // other race, so they keep the default two-stroke treatment.
    secondBorderColor: '#ffffff'
  }
};

// --- race resolution ------------------------------------------------------

// Race id resolution. Substring match on the race string so a future
// "goblin_warlord_champion" or any similar champion race string inherits
// a goblin-ish banner without further code changes. HOBGOBLIN is checked
// first because the string "hobgoblin" contains "goblin".
function resolveRaceId(unitTypeDef, isUndead) {
  if (isUndead) return BannerRace.SKELETON;
  if (!unitTypeDef) return BannerRace.HUMAN;
  const r = unitTypeDef.race;
  if (typeof r === 'string') {
    if (r.includes('hobgoblin')) return BannerRace.HOBGOBLIN;
    if (r.includes('goblin'))    return BannerRace.GOBLIN;
    if (r === 'skeleton')        return BannerRace.SKELETON;
  }
  return BannerRace.HUMAN;
}

// --- public interface -----------------------------------------------------

// Returns the shape descriptor for a unit type:
//   { id, outline, borderColor, borderWidth }
// Consumers trace `outline`, use `borderColor`/`borderWidth` for the
// banner edge, and match on `id` if they need to special-case a race.
export function getBannerShape(unitTypeDef, isUndead) {
  const raceId = resolveRaceId(unitTypeDef, isUndead);
  const style = BANNER_STYLES[raceId];
  const shape = {
    id: raceId,
    outline: style.outline,
    borderColor: style.borderColor,
    borderWidth: style.borderWidth
  };
  // Conditional pass-through. Only the skeleton defines a second
  // border; every other race leaves the field undefined so consumers
  // can branch on its presence (see ShieldIconBuilder.drawShieldContent).
  if (style.secondBorderColor !== undefined) {
    shape.secondBorderColor = style.secondBorderColor;
  }
  return shape;
}

// Linear interpolation of the outline's x-range at a given y.
export function bannerXRangeAt(outline, y) {
  for (let i = 0; i < outline.length - 1; i++) {
    const a = outline[i];
    const b = outline[i + 1];
    if (y >= a.y && y <= b.y) {
      const span = b.y - a.y;
      const t = span > 0 ? (y - a.y) / span : 0;
      return [a.xl + (b.xl - a.xl) * t, a.xr + (b.xr - a.xr) * t];
    }
  }
  return [0.5, 0.5];
}

// True if (x, y) is inside the banner outline. x,y are in the same
// normalized [0..1] space as the outline rows.
export function isInsideBannerOutline(outline, x, y) {
  if (x < 0 || x > 1) return false;
  if (y < 0 || y > 1) return false;
  const [xl, xr] = bannerXRangeAt(outline, y);
  return x >= xl && x <= xr;
}

// Traces the outline as a closed path on `ctx`. pxFn/pyFn convert a
// normalized [0..1] coordinate to a pixel coordinate (including any
// padding the caller applies) — the same px/py helpers ShieldIconBuilder
// already uses.
export function traceBannerOutline(ctx, outline, W, H, pxFn, pyFn) {
  ctx.beginPath();
  ctx.moveTo(pxFn(outline[0].xl, W), pyFn(outline[0].y, H));
  ctx.lineTo(pxFn(outline[0].xr, W), pyFn(outline[0].y, H));
  for (let i = 1; i < outline.length; i++) {
    const { y } = outline[i];
    const [, xr] = bannerXRangeAt(outline, y);
    ctx.lineTo(pxFn(xr, W), pyFn(y, H));
  }
  for (let i = outline.length - 1; i >= 0; i--) {
    const { y } = outline[i];
    const [xl] = bannerXRangeAt(outline, y);
    ctx.lineTo(pxFn(xl, W), pyFn(y, H));
  }
  ctx.closePath();
}
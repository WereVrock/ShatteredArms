// ===== UnitBannerIcon.js =====
// Silhouette SVG used on the world-space unit banner (ShieldIconBuilder).
//
// Deliberately separate from UnitIcon.js's detailed composite. That
// module draws a small multicolor illustration for army-bar cards and
// roster tiles. The banner lives in world space and must read as a
// single bold shape, so this module draws SILHOUETTES:
//
//   - Every silhouette is pure WHITE. The banner fill behind it is a
//     darkened, saturated team color (see ShieldIconBuilder.js), so
//     white-on-dark is a hard, unmistakable contrast that survives any
//     camera distance and any team color.
//   - Shielded units get an UNFILLED shield frame drawn BEHIND the
//     weapon/silhouette. The frame has thick stroke lines, is sized so
//     the silhouette inside never touches it, and is centered in the
//     viewBox with the silhouette. Team color shows through the gap
//     between the two, so the composite reads as
//     "silhouette sitting inside a shield frame".
//   - Cavalry get a solid white horse-head silhouette ONLY. The horse
//     shape alone carries the read; no weapon is drawn with it. Skeleton
//     cavalry get a white horse-skull silhouette with dark cut-outs for
//     the eye socket, nasal opening, and tooth line.
//   - The Goblin Warlord keeps his hooded-face identity: white cowl
//     silhouette, gold war-crown accent. The crown is the one color
//     accent on any silhouette because it is the character's whole read.
//   - Race is communicated by the BANNER SHAPE itself (BannerShape.js),
//     not by a corner accent.
//
// CENTERING AND SCALING
// Every non-warlord case is wrapped in an SVG <g transform="..."> that
// centers the composite in the 100x100 viewBox and scales it to a
// consistent visual size. Shielded cases scale down so the composite
// fits inside the shield frame with a visible margin (~6-9 viewBox units
// on each side). The scale is chosen per-case because the natural
// bounding boxes differ substantially (a tall spear, a small horse head,
// a wide skeleton skull).
//
// Per-composite center points and scales are stored in small lookup
// tables below. The values are hand-tuned against the actual layer
// geometry; if a layer is reshaped, its entry in WEAPON_CENTERS (or the
// constants below it) needs a matching update.
//
// Same 100x100 viewbox as UnitIcon.js, same caller signature, drop-in
// replacement for unitIconSvg when the target is the world banner.

import { isCavalry } from '../config/UnitClasses.js';

const VIEWBOX = '0 0 100 100';

// Silhouette fill — pure white. Contrasts hard against the dark,
// saturated team color the banner uses as its fill.
const SIL = '#ffffff';

// Internal-cut fill for the skeleton-horse skull. Reads as a hole or
// an opening in the bone shape; without it, the skull silhouette is not
// distinguishable from a living horse head at small sizes.
const CUT = '#0a0a0a';

// --- svg wrapper ----------------------------------------------------------

function svgWrapper(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}">${inner}</svg>`;
}

// --- shield frame ---------------------------------------------------------

// An UNFILLED shield frame drawn behind the weapon/silhouette on
// shielded units. Rounded rectangle with a thick white stroke; team
// color shows through the interior.
function shieldFrameLayer() {
  return `<rect x="14" y="8" width="72" height="84" rx="10"
                fill="none" stroke="${SIL}" stroke-width="4"
                stroke-linejoin="round"/>`;
}

// --- weapons --------------------------------------------------------------

function swordLayer() {
  return `
    <polygon points="36,4 44,16 44,58 28,58 28,16" fill="${SIL}"/>
    <rect x="20" y="58" width="32" height="6" fill="${SIL}"/>
    <rect x="32" y="64" width="8" height="20" fill="${SIL}"/>
    <circle cx="36" cy="86" r="5" fill="${SIL}"/>
  `;
}

function spearLayer() {
  return `
    <rect x="33" y="18" width="6" height="72" fill="${SIL}"/>
    <polygon points="36,2 46,20 36,32 26,20" fill="${SIL}"/>
  `;
}

function lanceLayer() {
  return `
    <rect x="34" y="16" width="4" height="76" fill="${SIL}"/>
    <polygon points="36,2 44,18 36,28 28,18" fill="${SIL}"/>
  `;
}

function bowLayer() {
  return `
    <path d="M 32 8 Q 82 50 32 92" fill="none"
          stroke="${SIL}" stroke-width="6" stroke-linecap="round"/>
    <line x1="32" y1="8" x2="32" y2="92" stroke="${SIL}" stroke-width="2"/>
    <line x1="26" y1="50" x2="86" y2="50" stroke="${SIL}" stroke-width="3"/>
    <polygon points="86,45 96,50 86,55" fill="${SIL}"/>
  `;
}

// Crude club silhouette — goblin slave. Same shape family as the 3D
// mesh and the detailed clubLayer in UnitIcon.js, just solid white.
function clubLayer() {
  return `
    <polygon points="32,92 40,92 42,42 30,42" fill="${SIL}"/>
    <ellipse cx="36" cy="26" rx="14" ry="16" fill="${SIL}"/>
  `;
}

const WEAPON_LAYERS = {
  sword: swordLayer,
  spear: spearLayer,
  bow:   bowLayer,
  lance: lanceLayer
};

// --- cavalry --------------------------------------------------------------

// Living horse head, side-on, white silhouette. Small dark eye cut-out
// so the shape reads as a face rather than an unbroken blob. Drawn alone
// on cavalry banners; the horse is the whole identity.
function horseHeadLayer() {
  return `
    <path d="M 66 70 L 66 36 L 70 22 L 74 30 L 78 22 L 82 28
             L 88 32 Q 96 38 96 46 L 94 52 L 88 48 L 82 42
             L 78 44 L 78 70 Z"
          fill="${SIL}"/>
    <circle cx="83" cy="36" r="2" fill="${CUT}"/>
  `;
}

// Skeleton horse head + neck. White skull silhouette with dark
// cut-outs for the eye socket, nasal opening, and tooth line.
function skeletonHorseFaceLayer() {
  return `
    <!-- Neck: white bone column -->
    <path d="M 18 54 L 34 54 L 30 94 L 14 94 Z" fill="${SIL}"/>
    <line x1="20" y1="62" x2="32" y2="62" stroke="${CUT}" stroke-width="1.4"/>
    <line x1="19" y1="72" x2="31" y2="72" stroke="${CUT}" stroke-width="1.4"/>
    <line x1="17" y1="82" x2="29" y2="82" stroke="${CUT}" stroke-width="1.4"/>
    <!-- Skull: side profile facing right -->
    <path d="M 20 28 Q 22 20 34 18 L 44 22 Q 48 24 50 28
             L 90 40 Q 94 42 90 50 L 60 54 L 36 56 L 20 58 Z"
          fill="${SIL}"/>
    <!-- Eye orbit -->
    <ellipse cx="36" cy="34" rx="7" ry="6" fill="${CUT}"/>
    <!-- Nasal opening -->
    <ellipse cx="82" cy="43" rx="3" ry="2.5" fill="${CUT}"/>
    <!-- Tooth line -->
    <line x1="58" y1="54" x2="58" y2="60" stroke="${CUT}" stroke-width="1.6"/>
    <line x1="64" y1="52" x2="64" y2="58" stroke="${CUT}" stroke-width="1.6"/>
    <line x1="72" y1="50" x2="72" y2="56" stroke="${CUT}" stroke-width="1.6"/>
    <line x1="78" y1="47" x2="78" y2="53" stroke="${CUT}" stroke-width="1.6"/>
  `;
}

// --- Goblin Warlord silhouette -------------------------------------------

// Hooded Warlord face. White cowl silhouette, gold war-crown preserved
// as the one color accent. Warlord renders at natural position — the
// cowl is already centered around (50, 46) in the viewBox.
function goblinWarlordSilhouette() {
  const crown = '#c8b060';
  return `
    <path d="M 22 80 Q 8 68 10 44 Q 14 16 50 12
             Q 86 16 90 44 Q 92 68 78 80
             L 70 72 L 66 56 L 34 56 L 30 72 Z"
          fill="${SIL}"/>
    <path d="M 30 32 L 36 14 L 44 32 L 50 10 L 56 32 L 64 14 L 70 32
             L 68 42 L 32 42 Z"
          fill="${crown}" stroke="${CUT}" stroke-width="0.8"
          stroke-linejoin="round"/>
  `;
}

// --- centering tables -----------------------------------------------------
//
// Each weapon's silhouette is drawn around its natural center rather
// than the viewBox center, so that composites can be centered by
// shifting them. If a weapon layer's geometry is reshaped, update its
// entry here.
const WEAPON_CENTERS = {
  sword: { cx: 36, cy: 47.5 },
  spear: { cx: 36, cy: 46 },
  lance: { cx: 36, cy: 47 },
  bow:   { cx: 61, cy: 50 },
  club:  { cx: 36, cy: 51 }
};

// The horse head alone spans roughly x 66..96, y 22..70, so its center is
// (81, 46). It is small compared with the other silhouettes, so it is
// scaled UP to fill the banner: more with no frame, a little less inside
// the shield frame.
const HORSE_HEAD_CENTER = { cx: 81, cy: 46 };
const HORSE_SCALE = 1.7;
const HORSE_SCALE_WITH_SHIELD = 1.25;

// Skeleton horse head alone centers around (55, 56).
const SKELETON_HORSE_CENTER = { cx: 55, cy: 56 };

// Scale factors so weapon silhouettes fit inside the shield frame (inner
// edge 16-84 x, 10-90 y) with a visible margin.
const WEAPON_SCALE_WITH_SHIELD = 0.72;
const SKELETON_HORSE_SCALE_WITH_SHIELD = 0.68;

// --- helpers --------------------------------------------------------------

function weaponTypeKey(unitTypeDef) {
  if (!unitTypeDef) return 'spear';
  if (unitTypeDef.bodyVariant === 'goblinSlave') return 'club';
  return WEAPON_LAYERS[unitTypeDef.weaponType] ? unitTypeDef.weaponType : 'spear';
}

function weaponLayerFor(unitTypeDef) {
  const key = weaponTypeKey(unitTypeDef);
  if (key === 'club') return clubLayer();
  return (WEAPON_LAYERS[key] || spearLayer)();
}

// Wraps composite content in a translate that moves its natural center
// onto the viewBox center. Used where the silhouette is drawn at full
// size and just needs to be re-centered.
function centerTranslate(center) {
  const dx = 50 - center.cx;
  const dy = 50 - center.cy;
  return `<g transform="translate(${dx} ${dy})">`;
}

// Wraps composite content in a scale-about-center then translate that
// both resizes it and centers it on the viewBox center.
function centerScaleTranslate(center, scale) {
  return `<g transform="translate(50 50) scale(${scale}) translate(${-center.cx} ${-center.cy})">`;
}

// --- composer -------------------------------------------------------------

// Returns the banner silhouette SVG markup for the given unit.
// Signature matches unitIconSvg in UnitIcon.js (unitTypeDef, isUndead),
// so callers can swap one for the other freely.
//
// unitTypeDef fields read: hasShield, weaponType, race, bodyVariant,
// championBodyVariant.
export function unitBannerIconSvg(unitTypeDef, isUndead) {
  const isCav = unitTypeDef && isCavalry(unitTypeDef);
  const isWarlord = unitTypeDef && (
    unitTypeDef.bodyVariant === 'goblinWarlord'
    || unitTypeDef.championBodyVariant === 'goblinWarlord'
  );
  const hasShield = !!(unitTypeDef && unitTypeDef.hasShield);

  // --- Warlord: hooded face silhouette as-is ----------------------------
  // No frame even for a shielded warlord — the cowl IS the identity.
  if (isWarlord) {
    return svgWrapper(goblinWarlordSilhouette());
  }

  // --- Skeleton cavalry: white horse-skull silhouette only --------------
  if (isUndead && isCav) {
    const horse = skeletonHorseFaceLayer();
    if (hasShield) {
      return svgWrapper(
        shieldFrameLayer() +
        centerScaleTranslate(SKELETON_HORSE_CENTER, SKELETON_HORSE_SCALE_WITH_SHIELD) +
        horse +
        `</g>`
      );
    }
    return svgWrapper(
      centerTranslate(SKELETON_HORSE_CENTER) + horse + `</g>`
    );
  }

  // --- Living cavalry: horse head ONLY, no weapon ------------------------
  if (isCav) {
    const horse = horseHeadLayer();
    if (hasShield) {
      return svgWrapper(
        shieldFrameLayer() +
        centerScaleTranslate(HORSE_HEAD_CENTER, HORSE_SCALE_WITH_SHIELD) +
        horse +
        `</g>`
      );
    }
    return svgWrapper(
      centerScaleTranslate(HORSE_HEAD_CENTER, HORSE_SCALE) + horse + `</g>`
    );
  }

  // --- Foot units: weapon silhouette -------------------------------------
  const weapon = weaponLayerFor(unitTypeDef);
  const center = WEAPON_CENTERS[weaponTypeKey(unitTypeDef)] || WEAPON_CENTERS.spear;

  if (hasShield) {
    return svgWrapper(
      shieldFrameLayer() +
      centerScaleTranslate(center, WEAPON_SCALE_WITH_SHIELD) +
      weapon +
      `</g>`
    );
  }
  return svgWrapper(
    centerTranslate(center) + weapon + `</g>`
  );
}
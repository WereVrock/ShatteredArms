// ===== UnitIcon.js =====
// Composes an SVG unit icon: a weapon as the main element, with optional
// supporting elements layered around it —
//   shield behind the weapon (if the unit type carries one)
//   horse head to the right side (if the unit is cavalry)
//   goblin head top-right corner (if the unit is of the goblin race)
//   skull top-left corner (if the unit is undead)
//
// SPECIAL CASES
//   - Goblin Warlord (bodyVariant or championBodyVariant ===
//     'goblinWarlord'): the icon is the hooded warlord FACE ONLY. No
//     weapon, no shield, no horse. The cowl + war-crown + green face is
//     the character's whole identity at icon scale, and it is drawn to
//     fill most of the viewbox.
//
//   - Skeleton horsemen (undead + cavalry): the icon is the skeleton
//     horse's HEAD AND NECK (skull + vertebrae), with an optional shield
//     behind it. No weapon, no skull corner accent — the horse skull IS
//     the identity.
//
// Rendered as inline SVG rather than a rasterised 3D capture so the icons
// are crisp at any size, cost nothing at scenario start, and can be tuned
// by editing path data instead of repositioning meshes and re-rendering.
//
// Viewbox is 100x100 for round numbers; all shape coordinates are in that
// space and the SVG element is sized by CSS.

import { isCavalry } from '../config/UnitClasses.js';

const VIEWBOX = '0 0 100 100';

// --- shield ----------------------------------------------------------------

// Big round wooden shield with a central boss.
function shieldLayer() {
  return `
    <circle cx="36" cy="52" r="34" fill="#8b5a2b" stroke="#5a3d20" stroke-width="3"/>
    <circle cx="36" cy="52" r="10" fill="#e8d98a" stroke="#a89858" stroke-width="1.5"/>
  `;
}

// --- weapons ---------------------------------------------------------------

function swordLayer() {
  return `
    <polygon points="36,4 41,14 41,58 31,58 31,14" fill="#bbb"/>
    <polygon points="36,7 39,14 39,56 33,56 33,14" fill="#ddd"/>
    <rect x="25" y="58" width="22" height="5" fill="#4a3018"/>
    <rect x="33" y="63" width="6" height="18" fill="#4a3018"/>
    <circle cx="36" cy="84" r="4" fill="#4a3018"/>
  `;
}

function spearLayer() {
  return `
    <rect x="34" y="20" width="4" height="70" fill="#5a3d20"/>
    <polygon points="36,2 43,20 36,30 29,20" fill="#c0c0c0"/>
  `;
}

function lanceLayer() {
  return `
    <rect x="35" y="16" width="2" height="76" fill="#5a3d20"/>
    <polygon points="36,2 41,16 36,24 31,16" fill="#c0c0c0"/>
  `;
}

function bowLayer() {
  return `
    <line x1="35" y1="10" x2="35" y2="90" stroke="#ddd" stroke-width="1.5"/>
    <path d="M 35 10 Q 75 50 35 90" fill="none" stroke="#5a3d20" stroke-width="4"/>
    <line x1="30" y1="50" x2="78" y2="50" stroke="#8a5a24" stroke-width="2"/>
    <polygon points="78,46 88,50 78,54" fill="#c0c0c0"/>
    <polygon points="30,50 24,46 24,54" fill="#ddd"/>
  `;
}

const WEAPON_LAYERS = {
  sword: swordLayer,
  spear: spearLayer,
  bow:   bowLayer,
  lance: lanceLayer
};

// --- accents ---------------------------------------------------------------

// Horse head in profile, facing right. Flesh (not bone) — used for living
// cavalry.
function horseHeadLayer() {
  return `
    <path d="
      M 68 68
      L 68 35
      L 70 28
      L 72 22
      L 74 28
      L 76 22
      L 78 28
      L 82 30
      Q 90 32 94 40
      L 94 46
      L 92 49
      L 86 46
      L 82 42
      L 80 42
      L 80 68
      Z
    " fill="#4a2f1a" stroke="#2a1a0e" stroke-width="1"/>
    <circle cx="83" cy="37" r="1.5" fill="#1a1408"/>
  `;
}

// Skeleton-horse HEAD AND NECK, drawn side-on facing right. Replaces the
// whole composite for undead cavalry: no weapon, no skull corner accent.
// The skull reads the identity; the neck (a tapered bone with vertebra
// segment marks) makes it unambiguously a horse and not just a skull.
//
// Colour matches the skeleton body palette (0xd8d0b8 against a darker
// stroke) so the icon reads as bone against the army-bar card's backing.
function skeletonHorseFaceLayer() {
  return `
    <!-- Neck: bone column at the back, with vertebra segment marks.
         Tops connect flush to the skull's bottom-left corner. -->
    <path d="M 20 55 L 32 55 L 30 92 L 16 92 Z"
          fill="#d8d0b8" stroke="#a89c80" stroke-width="1.2"
          stroke-linejoin="round"/>
    <line x1="20" y1="64" x2="31" y2="64" stroke="#a89c80" stroke-width="1"/>
    <line x1="19" y1="73" x2="30" y2="73" stroke="#a89c80" stroke-width="1"/>
    <line x1="18" y1="82" x2="29" y2="82" stroke="#a89c80" stroke-width="1"/>

    <!-- Skull: side profile facing right. Long tapering muzzle at the
         front, tall narrow cranium at the back — the two features that
         read as "horse" rather than "generic animal skull". -->
    <path d="M 20 30
             Q 22 22 34 21
             L 42 23
             Q 46 24 48 27
             L 88 41
             Q 92 43 88 49
             L 60 53
             L 36 55
             L 20 56
             Z"
          fill="#d8d0b8" stroke="#a89c80" stroke-width="1.3"
          stroke-linejoin="round"/>

    <!-- Eye orbit: LARGE round hole. A horse's eye is huge relative to
         its skull — this is the single strongest identifier. -->
    <ellipse cx="36" cy="35" rx="6" ry="5.5" fill="#1a1408"/>

    <!-- Nasal opening at the muzzle tip -->
    <ellipse cx="82" cy="43" rx="2.5" ry="2" fill="#1a1408"/>

    <!-- Teeth: short vertical stubs descending from the bottom edge of
         the muzzle, from the eye forward to the nose. -->
    <line x1="60" y1="53" x2="60" y2="58" stroke="#8a7c60" stroke-width="1.1"/>
    <line x1="66" y1="51" x2="66" y2="56" stroke="#8a7c60" stroke-width="1.1"/>
    <line x1="72" y1="49" x2="72" y2="54" stroke="#8a7c60" stroke-width="1.1"/>
    <line x1="78" y1="46" x2="78" y2="51" stroke="#8a7c60" stroke-width="1.1"/>
  `;
}

// Skull in the top-left corner. Enlarged (r=13) so the race accent reads
// more strongly at small icon sizes.
function skullLayer() {
  return `
    <circle cx="15" cy="15" r="13" fill="#d8d0b8" stroke="#a89c80" stroke-width="1.2"/>
    <rect x="8" y="26" width="14" height="8" rx="1" fill="#d8d0b8" stroke="#a89c80" stroke-width="1.2"/>
    <circle cx="10" cy="15" r="3.5" fill="#1a1408"/>
    <circle cx="20" cy="15" r="3.5" fill="#1a1408"/>
    <polygon points="15,21 12,25 18,25" fill="#1a1408"/>
  `;
}

// Goblin head in the top-right corner. Enlarged (rx=12) so the race
// accent reads more strongly at small icon sizes. Green skin, two pointed
// ears, narrow eyes, hooked nose, toothy grin.
function goblinLayer() {
  return `
    <!-- cranium -->
    <ellipse cx="82" cy="15" rx="12" ry="11" fill="#6a8a3a" stroke="#3d5220" stroke-width="1.2"/>
    <!-- left ear, splaying up-and-left -->
    <polygon points="73,10 64,2 76,17" fill="#6a8a3a" stroke="#3d5220" stroke-width="1.2"/>
    <!-- right ear, splaying up-and-right -->
    <polygon points="91,10 100,2 88,17" fill="#6a8a3a" stroke="#3d5220" stroke-width="1.2"/>
    <!-- eyes -->
    <circle cx="78" cy="14" r="2.2" fill="#1a1408"/>
    <circle cx="86" cy="14" r="2.2" fill="#1a1408"/>
    <!-- hooked nose -->
    <polygon points="82,17 79,23 85,23" fill="#4a6a20"/>
    <!-- grin -->
    <path d="M 76 23 Q 82 26 88 23" fill="none" stroke="#1a1408" stroke-width="1.2"/>
  `;
}

// Hooded Goblin Warlord FACE, drawn to fill most of the viewbox. Used as
// the WHOLE icon when the unit's body variant is 'goblinWarlord' — no
// weapon, no shield, no other accents. A dark cowl wraps the head with a
// green face in the opening and a gold war-crown on the brow.
function goblinWarlordFaceLayer() {
  const crown = '#c8b060';
  return `
    <!-- Hood silhouette: peaked cowl, side rims hanging past the cheeks -->
    <path d="M 26 74
             Q 14 62 16 44
             Q 20 20 50 16
             Q 80 20 84 44
             Q 86 62 74 74
             L 68 68
             L 66 56
             L 34 56
             L 32 68
             Z"
          fill="#08080c" stroke="#2a2a3a" stroke-width="1.6"
          stroke-linejoin="round"/>

    <!-- Face opening: green skin visible in the hood's gap -->
    <ellipse cx="50" cy="52" rx="16" ry="14" fill="#5a6a32"/>

    <!-- Mean narrow eyes -->
    <ellipse cx="44" cy="50" rx="3" ry="3.4" fill="#1a1408"/>
    <ellipse cx="56" cy="50" rx="3" ry="3.4" fill="#1a1408"/>

    <!-- Nose -->
    <polygon points="50,55 45,64 55,64" fill="#4a5a20"/>

    <!-- War-crown heraldry on the hood brow -->
    <path d="M 34 32
             L 39 18
             L 44 32
             L 50 16
             L 56 32
             L 61 18
             L 66 32
             L 64 40
             L 36 40 Z"
          fill="${crown}" stroke="#4a3a10" stroke-width="1"
          stroke-linejoin="round"/>
  `;
}

// --- composer --------------------------------------------------------------

// Returns a complete SVG markup string for the given unit. Caller sets it
// as innerHTML on a container element — see ArmyBarView._installIcon.
//
// unitTypeDef fields read: hasShield, weaponType, race, bodyVariant,
// championBodyVariant.
export function unitIconSvg(unitTypeDef, isUndead) {
  const parts = [];

  const isCav = unitTypeDef && isCavalry(unitTypeDef);
  const isWarlord = unitTypeDef && (
    unitTypeDef.bodyVariant === 'goblinWarlord'
    || unitTypeDef.championBodyVariant === 'goblinWarlord'
  );

  // --- Goblin Warlord: face only ----------------------------------------
  // The hooded face IS the identity. No weapon, no shield, no accent —
  // anything else would fight the cowl silhouette at icon scale.
  if (isWarlord) {
    parts.push(goblinWarlordFaceLayer());
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}">${parts.join('')}</svg>`;
  }

  // --- Skeleton horsemen: skeleton horse head+neck (+ optional shield) ---
  // No weapon, no skull corner accent — the horse skull is the read.
  if (isUndead && isCav) {
    if (unitTypeDef && unitTypeDef.hasShield) parts.push(shieldLayer());
    parts.push(skeletonHorseFaceLayer());
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}">${parts.join('')}</svg>`;
  }

  // --- Standard composition ----------------------------------------------
  if (unitTypeDef && unitTypeDef.hasShield) parts.push(shieldLayer());
  if (isCav) parts.push(horseHeadLayer());

  const weaponType = unitTypeDef ? unitTypeDef.weaponType : null;
  const weaponBuilder = WEAPON_LAYERS[weaponType] || spearLayer;
  parts.push(weaponBuilder());

  if (unitTypeDef && unitTypeDef.race === 'goblin') {
    parts.push(goblinLayer());
  }

  if (isUndead) parts.push(skullLayer());

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}">${parts.join('')}</svg>`;
}
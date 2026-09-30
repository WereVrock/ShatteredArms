// Composes an SVG unit icon: a weapon as the main element, with optional
// supporting elements layered around it —
//   shield     behind the weapon (if the unit type carries one)
//   horse head to the right side (if the unit is cavalry)
//   skull      top-left corner (if the unit is undead)
//
// Rendered as inline SVG rather than a rasterised 3D capture so the icons
// are crisp at any size, cost nothing at scenario start, and can be tuned
// by editing path data instead of repositioning meshes and re-rendering.
//
// Layer order is draw order (SVG has no z-buffer): shield, then horse head,
// then weapon, then skull. So the weapon sits in front of the shield where
// they overlap, the horse head peeks from behind the weapon on the right,
// and the skull sits clean on top in its corner.
//
// Viewbox is 100x100 for round numbers; all shape coordinates are in that
// space and the SVG element is sized by CSS (see .army-card-image svg).

import { isCavalry } from '../config/UnitClasses.js';

const VIEWBOX = '0 0 100 100';

// --- shield ----------------------------------------------------------------

// Big round wooden shield with a central boss. Deliberately dominant — the
// weapon crosses it as a thinner band, so shielded units read at a glance as
// "shield unit" first, weapon type second. That ordering is what the
// Total-War-style unit cards do and it scales down to small icons.
function shieldLayer() {
  return `
    <circle cx="36" cy="52" r="34" fill="#8b5a2b" stroke="#5a3d20" stroke-width="3"/>
    <circle cx="36" cy="52" r="10" fill="#e8d98a" stroke="#a89858" stroke-width="1.5"/>
  `;
}

// --- weapons ---------------------------------------------------------------

// Weapons run along their natural axis so the type is legible regardless of
// what is layered around them. Sword and spear run vertically down the
// shield's centerline (x=36) — the heraldic "sword-and-shield" composition,
// where the weapon overlaps the shield as the foreground element. The bow
// is a vertical arc for the same reason. The lance is the exception: it runs
// horizontally so it reads as a couched cavalry weapon rather than a second
// infantry spear.

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

// Bow with a nocked arrow. Bow arc bulges to the right, string on the left,
// arrow pointing right. Reads as a bow rather than a random curve because
// the string and arrow are both present.
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

// Horse head in profile, facing right: neck block rising from the bottom,
// two ears on top, forehead curving forward into a muzzle. Simplified
// silhouette — legible at 40px, recognisably equine.
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

// Skull in the top-left corner. Cranium + jaw + two sockets + a nose notch.
// Drawn last so it always sits on top, corner reserved by layout.
function skullLayer() {
  return `
    <circle cx="14" cy="14" r="10" fill="#d8d0b8" stroke="#a89c80" stroke-width="1"/>
    <rect x="9" y="22" width="10" height="6" rx="1" fill="#d8d0b8" stroke="#a89c80" stroke-width="1"/>
    <circle cx="10" cy="14" r="2.5" fill="#1a1408"/>
    <circle cx="18" cy="14" r="2.5" fill="#1a1408"/>
    <polygon points="14,18 12,21 16,21" fill="#1a1408"/>
  `;
}

// --- composer --------------------------------------------------------------

// Returns a complete SVG markup string for the given unit. Caller sets it as
// innerHTML on a container element — see ArmyBarView._installIcon.
//
// unitTypeDef fields read: hasShield, isCavalry, weaponType. These mirror
// what SoldierView and WeaponViewFactory already consume. A missing
// weaponType falls back to the spear silhouette so a misconfigured unit
// still shows something rather than an empty card.
export function unitIconSvg(unitTypeDef, isUndead) {
  const parts = [];

  if (unitTypeDef && unitTypeDef.hasShield) {
    parts.push(shieldLayer());
  }

  if (unitTypeDef && isCavalry(unitTypeDef)) {
    parts.push(horseHeadLayer());
  }

  const weaponType = unitTypeDef ? unitTypeDef.weaponType : null;
  const weaponBuilder = WEAPON_LAYERS[weaponType] || spearLayer;
  parts.push(weaponBuilder());

  if (isUndead) {
    parts.push(skullLayer());
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}">${parts.join('')}</svg>`;
}
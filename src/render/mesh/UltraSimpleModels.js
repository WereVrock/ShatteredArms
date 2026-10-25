// ===== src/render/mesh/UltraSimpleModels.js =====
// LOD tier 4 — "ultra-simple". Beyond tier 3 (SimpleModels.js) and below
// any distance at which race or weapon detail is legible. What survives is
// TEAM COLOUR and a rough height silhouette. That is it.
//
// DESIGN
// Every soldier is a body box + a head box, merged into ONE mesh, with the
// unit's team colour on the material. No legs, no legs pivots, no helmet,
// no shield — nothing that costs a draw call without carrying team identity
// at this distance.
//
// NO LEG PIVOTS means SoldierView._applyWalkCycle returns early (it checks
// for _legLeftPivot / _legRightPivot), so a soldier at this tier walks with
// a rigid, unanimated stride. That is the correct trade: leg swing is
// invisible at the distances ultra-simple is designed for, and the two
// pivots per leg are two scene-graph nodes the renderer no longer has to
// touch each frame.
//
// BILLBOARD READINESS
// The single merged mesh is deliberately the ONE draw call per soldier that
// a future billboard swap wants: replace the box geometry with a
// camera-facing quad carrying a pre-baked soldier sprite, keep the same
// material slot, keep the same position. No other structural change to the
// composer or view would be needed.
//
// WEAPONS
// A single thin box extending forward from the body carries the "this man
// has a long pointy thing" read. It uses the same team-tinted material as
// the body so it merges with the body geometry — ONE mesh per soldier even
// with the weapon stub included.
//
// HORSES
// Cavalry get a single long mount box behind them, in a neutral brown. The
// mount is a second mesh (different material) — two draw calls per
// mounted soldier at this tier, still tiny.
//
// USAGE — no wiring in this file. Callers pick a builder by unit body
// variant and compose the result as the soldier's whole visible model.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

// ---------------------------------------------------------------------------
// body dimensions
// ---------------------------------------------------------------------------
//
// Heights are chosen so the ultra-simple body silhouette lands at roughly
// the same vertical extent as the detailed body: feet at y=0, top of head
// at ~1.25 for a human. A future billboard swap uses these as the quad's
// world-space bounds.
const BODY_BOX_WIDTH = 0.34;
const BODY_BOX_HEIGHT = 0.80;
const BODY_BOX_DEPTH = 0.24;
const BODY_BOX_CENTER_Y = 0.65;

const HEAD_BOX_SIZE = 0.24;
const HEAD_BOX_CENTER_Y = BODY_BOX_CENTER_Y + BODY_BOX_HEIGHT / 2 + HEAD_BOX_SIZE / 2 - 0.02;

// Weapon stub — a thin, forward-pointing bar at hand height. Length varies
// per weapon family so a spear unit still reads as a spear unit.
const WEAPON_BAR_HEIGHT = 0.65;
const WEAPON_BAR_THICKNESS = 0.045;

// ---------------------------------------------------------------------------
// body builders
// ---------------------------------------------------------------------------

// Human (blob) body at ultra-simple: body box + head box + weapon bar, all
// merged into a single team-coloured mesh.
export function createUltraSimpleBlobBody(color) {
  const group = new THREE.Group();
  const mat = cachedMaterial(`ultraSimple.bodyMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color }));

  const geo = cachedGeometry('ultraSimple.humanBodyGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.BoxGeometry(BODY_BOX_WIDTH, BODY_BOX_HEIGHT, BODY_BOX_DEPTH),
        matrix: partMatrix(0, BODY_BOX_CENTER_Y, 0)
      },
      {
        geometry: new THREE.BoxGeometry(HEAD_BOX_SIZE, HEAD_BOX_SIZE, HEAD_BOX_SIZE * 0.9),
        matrix: partMatrix(0, HEAD_BOX_CENTER_Y, 0)
      }
    ]));
  group.add(new THREE.Mesh(geo, mat));

  group.userData.baseMaterial = mat;
  return group;
}

// Skeleton body: bone-tinted body box + head box (merged) + a team sash
// box. Two meshes total — the team colour lives on the sash, matching the
// skeleton's convention that the body is bone-coloured and only the sash
// carries team identity.
export function createUltraSimpleSkeletonBody(color, teamColor) {
  const group = new THREE.Group();

  const boneColor = new THREE.Color(color).lerp(new THREE.Color(0xe8e0c8), 0.55);
  const mat = cachedMaterial(`ultraSimple.skelBodyMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: boneColor }));

  const geo = cachedGeometry('ultraSimple.skeletonBodyGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.BoxGeometry(BODY_BOX_WIDTH, BODY_BOX_HEIGHT, BODY_BOX_DEPTH),
        matrix: partMatrix(0, BODY_BOX_CENTER_Y, 0)
      },
      {
        geometry: new THREE.BoxGeometry(HEAD_BOX_SIZE, HEAD_BOX_SIZE, HEAD_BOX_SIZE * 0.9),
        matrix: partMatrix(0, HEAD_BOX_CENTER_Y, 0)
      }
    ]));
  group.add(new THREE.Mesh(geo, mat));

  const sashGeo = cachedGeometry('ultraSimple.skeletonSashGeo', () =>
    new THREE.BoxGeometry(0.10, 0.60, BODY_BOX_DEPTH + 0.02));
  const sashMat = cachedMaterial(`ultraSimple.skelSashMat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({ color: teamColor }));
  const sash = new THREE.Mesh(sashGeo, sashMat);
  sash.position.y = BODY_BOX_CENTER_Y;
  sash.rotation.z = Math.PI / 6;
  group.add(sash);

  group.userData.baseMaterial = mat;
  return group;
}

// Goblin body: same boxes, shorter and slightly narrower, green-lerped
// team colour, plus a small team-coloured sash box so the team read stays
// legible (the body alone is 55% green).
const GOBLIN_BODY_WIDTH = 0.28;
const GOBLIN_BODY_HEIGHT = 0.62;
const GOBLIN_BODY_DEPTH = 0.22;
const GOBLIN_BODY_CENTER_Y = 0.52;
const GOBLIN_HEAD_SIZE = 0.22;
const GOBLIN_HEAD_CENTER_Y = GOBLIN_BODY_CENTER_Y + GOBLIN_BODY_HEIGHT / 2 + GOBLIN_HEAD_SIZE / 2 - 0.02;

export function createUltraSimpleGoblinBody(color) {
  const group = new THREE.Group();

  const skinColor = new THREE.Color(color).lerp(new THREE.Color(0x6a8a3a), 0.55);
  const mat = cachedMaterial(`ultraSimple.goblinBodyMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: skinColor }));

  const geo = cachedGeometry('ultraSimple.goblinBodyGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.BoxGeometry(GOBLIN_BODY_WIDTH, GOBLIN_BODY_HEIGHT, GOBLIN_BODY_DEPTH),
        matrix: partMatrix(0, GOBLIN_BODY_CENTER_Y, 0)
      },
      {
        geometry: new THREE.BoxGeometry(GOBLIN_HEAD_SIZE, GOBLIN_HEAD_SIZE, GOBLIN_HEAD_SIZE * 0.9),
        matrix: partMatrix(0, GOBLIN_HEAD_CENTER_Y, 0.03)
      }
    ]));
  group.add(new THREE.Mesh(geo, mat));

  const sashGeo = cachedGeometry('ultraSimple.goblinSashGeo', () =>
    new THREE.BoxGeometry(GOBLIN_BODY_WIDTH + 0.02, 0.14, GOBLIN_BODY_DEPTH + 0.02));
  const sashMat = cachedMaterial(`ultraSimple.goblinSashMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color }));
  const sash = new THREE.Mesh(sashGeo, sashMat);
  sash.position.y = GOBLIN_BODY_CENTER_Y - 0.05;
  group.add(sash);

  group.userData.baseMaterial = mat;
  return group;
}

// Hobgoblin ultra body: taller than the goblin's, with a dark armor box
// over the torso (one extra mesh) and a team-coloured skirt bar. At this
// tier the surviving reads are: TEAM COLOUR (body + skirt), HEIGHT
// (hobgoblin is taller than goblin), and "wearing something" (the armor
// box). No helmet — the armor box already reads as kit at this distance.
const HOBGOBLIN_BODY_WIDTH = 0.34;
const HOBGOBLIN_BODY_HEIGHT = 0.74;
const HOBGOBLIN_BODY_DEPTH = 0.24;
const HOBGOBLIN_BODY_CENTER_Y = 0.58;
const HOBGOBLIN_HEAD_SIZE = 0.24;
const HOBGOBLIN_HEAD_CENTER_Y =
  HOBGOBLIN_BODY_CENTER_Y + HOBGOBLIN_BODY_HEIGHT / 2 + HOBGOBLIN_HEAD_SIZE / 2 - 0.02;

export function createUltraSimpleHobgoblinBody(color) {
  const group = new THREE.Group();

  const skinColor = new THREE.Color(color).lerp(new THREE.Color(0x5a6a3a), 0.50);
  const mat = cachedMaterial(`ultraSimple.hobgoblinBodyMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: skinColor }));

  const geo = cachedGeometry('ultraSimple.hobgoblinBodyGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.BoxGeometry(
          HOBGOBLIN_BODY_WIDTH, HOBGOBLIN_BODY_HEIGHT, HOBGOBLIN_BODY_DEPTH),
        matrix: partMatrix(0, HOBGOBLIN_BODY_CENTER_Y, 0)
      },
      {
        geometry: new THREE.BoxGeometry(
          HOBGOBLIN_HEAD_SIZE, HOBGOBLIN_HEAD_SIZE, HOBGOBLIN_HEAD_SIZE * 0.9),
        matrix: partMatrix(0, HOBGOBLIN_HEAD_CENTER_Y, 0.03)
      }
    ]));
  group.add(new THREE.Mesh(geo, mat));

  // Armor: a slightly larger dark box around the torso.
  const armorMat = cachedMaterial('ultraSimple.hobgoblinArmorMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a4a52 }));
  const armorGeo = cachedGeometry('ultraSimple.hobgoblinArmorGeo', () =>
    new THREE.BoxGeometry(
      HOBGOBLIN_BODY_WIDTH + 0.04, HOBGOBLIN_BODY_HEIGHT * 0.55, HOBGOBLIN_BODY_DEPTH + 0.04));
  const armor = new THREE.Mesh(armorGeo, armorMat);
  armor.position.y = HOBGOBLIN_BODY_CENTER_Y + 0.10;
  group.add(armor);

  // Team-coloured skirt bar at the base of the armor.
  const skirtMat = cachedMaterial(`ultraSimple.hobgoblinSkirtMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color }));
  const skirtGeo = cachedGeometry('ultraSimple.hobgoblinSkirtGeo', () =>
    new THREE.BoxGeometry(
      HOBGOBLIN_BODY_WIDTH + 0.02, 0.14, HOBGOBLIN_BODY_DEPTH + 0.02));
  const skirt = new THREE.Mesh(skirtGeo, skirtMat);
  skirt.position.y = HOBGOBLIN_BODY_CENTER_Y - 0.20;
  group.add(skirt);

  group.userData.baseMaterial = mat;
  return group;
}

// ---------------------------------------------------------------------------
// weapons — thin team-tinted bars
// ---------------------------------------------------------------------------

// All ultra-simple weapons are a single bar at hand height, varying only in
// length. Colour matches the body so that a future pass could merge the bar
// into the body mesh; for now they are a separate mesh so the weapon slot
// stays at the same scene-graph depth as every other tier.
function buildWeaponBar(length, thickness, position) {
  const group = new THREE.Group();
  group.position.copy(position);

  const geo = cachedGeometry(`ultraSimple.barGeo.${length}.${thickness}`, () =>
    new THREE.BoxGeometry(thickness, thickness, length));
  const mesh = new THREE.Mesh(geo, group.userData._pendingMat);

  // Group is returned from buildWeaponBar with the mesh already added; the
  // material is filled in by the caller via a small two-step to keep this
  // helper material-agnostic.
  group.add(mesh);
  return group;
}

export function createUltraSimpleSpear(color) {
  const mat = cachedMaterial(`ultraSimple.weaponMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.75) }));
  const group = new THREE.Group();
  group.position.set(0.22, WEAPON_BAR_HEIGHT, 0);
  const geo = cachedGeometry('ultraSimple.spearBarGeo', () =>
    new THREE.BoxGeometry(WEAPON_BAR_THICKNESS, WEAPON_BAR_THICKNESS, 1.4));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = 0.55;
  group.add(mesh);
  return group;
}

// Goblin ultra spear: identical bar geometry to the standard ultra spear,
// with a darker material so the palette still reads as "goblin" at this
// abstraction level. Shares a material cache key with the goblin ultra
// shortbow — both are the same "dark goblin weapon" colour.
export function createUltraSimpleGoblinSpear(color) {
  const mat = cachedMaterial(`ultraSimple.goblinWeaponMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.55) }));
  const group = new THREE.Group();
  group.position.set(0.22, WEAPON_BAR_HEIGHT, 0);
  const geo = cachedGeometry('ultraSimple.spearBarGeo', () =>
    new THREE.BoxGeometry(WEAPON_BAR_THICKNESS, WEAPON_BAR_THICKNESS, 1.4));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = 0.55;
  group.add(mesh);
  return group;
}

export function createUltraSimpleLance(color) {
  const mat = cachedMaterial(`ultraSimple.weaponMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.75) }));
  const group = new THREE.Group();
  group.position.set(0.24, WEAPON_BAR_HEIGHT + 0.05, 0);
  const geo = cachedGeometry('ultraSimple.lanceBarGeo', () =>
    new THREE.BoxGeometry(WEAPON_BAR_THICKNESS, WEAPON_BAR_THICKNESS, 2.4));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = 1.0;
  group.add(mesh);
  return group;
}

export function createUltraSimpleSword(color) {
  const mat = cachedMaterial(`ultraSimple.weaponMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.75) }));
  const group = new THREE.Group();
  group.position.set(0.22, WEAPON_BAR_HEIGHT, 0);
  const geo = cachedGeometry('ultraSimple.swordBarGeo', () =>
    new THREE.BoxGeometry(WEAPON_BAR_THICKNESS, WEAPON_BAR_THICKNESS, 0.7));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = 0.30;
  group.add(mesh);
  return group;
}

export function createUltraSimpleCrudeSword(color) {
  const mat = cachedMaterial(`ultraSimple.weaponMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.75) }));
  const group = new THREE.Group();
  group.position.set(0.18, WEAPON_BAR_HEIGHT - 0.10, 0);
  const geo = cachedGeometry('ultraSimple.crudeBarGeo', () =>
    new THREE.BoxGeometry(WEAPON_BAR_THICKNESS, WEAPON_BAR_THICKNESS, 0.4));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = 0.20;
  group.add(mesh);
  return group;
}

export function createUltraSimpleBow(color) {
  // No limb arc at this tier — a bow's curve is the FIRST thing to disappear
  // when the LOD steps below SimpleModels' torus. A short horizontal bar at
  // arm height reads "this unit shoots" well enough to distinguish an
  // archer unit from a melee unit at distance.
  //
  // userData stubs match the detailed bow's shape so layoutBowString and
  // _applyBowDraw do not crash.
  const mat = cachedMaterial(`ultraSimple.weaponMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.75) }));
  const group = new THREE.Group();
  group.position.set(0.22, WEAPON_BAR_HEIGHT, 0);

  const geo = cachedGeometry('ultraSimple.bowBarGeo', () =>
    new THREE.BoxGeometry(0.04, 0.45, 0.04));
  group.add(new THREE.Mesh(geo, mat));

  const topPivot = new THREE.Object3D();
  const bottomPivot = new THREE.Object3D();
  const topString = new THREE.Object3D();
  const bottomString = new THREE.Object3D();
  const nockedArrow = new THREE.Object3D();
  topString.visible = false;
  bottomString.visible = false;
  nockedArrow.visible = false;
  group.userData.topLimbPivot = topPivot;
  group.userData.bottomLimbPivot = bottomPivot;
  group.userData.topString = topString;
  group.userData.bottomString = bottomString;
  group.userData.nockedArrow = nockedArrow;

  return group;
}

// Goblin ultra shortbow: a shorter bar than the standard ultra bow's 0.45
// tall vertical bar, in the darker goblin weapon material. Bar height is
// the only surviving length cue at this tier — the difference between a
// shortbow and a longbow has to be a straight height comparison.
// userData stubs match the detailed bow's shape so layoutBowString and
// _applyBowDraw do not crash.
export function createUltraSimpleGoblinShortbow(color) {
  const mat = cachedMaterial(`ultraSimple.goblinWeaponMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.55) }));
  const group = new THREE.Group();
  group.position.set(0.22, WEAPON_BAR_HEIGHT, 0);

  const geo = cachedGeometry('ultraSimple.goblinShortbowBarGeo', () =>
    new THREE.BoxGeometry(0.04, 0.32, 0.04));
  group.add(new THREE.Mesh(geo, mat));

  const topPivot = new THREE.Object3D();
  const bottomPivot = new THREE.Object3D();
  const topString = new THREE.Object3D();
  const bottomString = new THREE.Object3D();
  const nockedArrow = new THREE.Object3D();
  topString.visible = false;
  bottomString.visible = false;
  nockedArrow.visible = false;
  group.userData.topLimbPivot = topPivot;
  group.userData.bottomLimbPivot = bottomPivot;
  group.userData.topString = topString;
  group.userData.bottomString = bottomString;
  group.userData.nockedArrow = nockedArrow;

  return group;
}

// ---------------------------------------------------------------------------
// shields
// ---------------------------------------------------------------------------

export function createUltraSimpleShield() {
  const geo = cachedGeometry('ultraSimple.shieldGeo', () =>
    new THREE.BoxGeometry(0.42, 0.55, 0.03));
  const mat = cachedMaterial('ultraSimple.shieldMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x6a4526 }));
  return new THREE.Mesh(geo, mat);
}

// ---------------------------------------------------------------------------
// mounts
// ---------------------------------------------------------------------------

// A cavalry unit at ultra-simple: one long mount box that the rider's
// body box sits on top of. Only a single box per mount — no head, no
// neck, no legs, no ears. The long low shape reads "mount" against the
// tall thin rider silhouette.
//
// The `gaunt` flag shrinks the box's width and height for the skeleton
// variant, so a bone mount reads as a thin slab rather than as a
// recoloured flesh horse at any distance. Length is preserved so the
// mount's forward footprint and the rider's seat position stay the same.
const HORSE_BOX_LENGTH = 1.0;
const HORSE_BOX_WIDTH_FLESH = 0.4;
const HORSE_BOX_HEIGHT_FLESH = 0.5;
const HORSE_BOX_BOTTOM_Y = 0.20;   // mount's underside, kept off the ground
const ULTRA_HORSE_CROSS_SCALE_SKELETON = 0.65;

function buildUltraSimpleMount(bodyColor, matKeyPrefix, gaunt = false) {
  const group = new THREE.Group();

  const cs = gaunt ? ULTRA_HORSE_CROSS_SCALE_SKELETON : 1.0;
  const boxW = HORSE_BOX_WIDTH_FLESH * cs;
  const boxH = HORSE_BOX_HEIGHT_FLESH * cs;
  const centerY = HORSE_BOX_BOTTOM_Y + boxH / 2;

  const mountGeo = cachedGeometry(`${matKeyPrefix}.mountGeo`, () =>
    new THREE.BoxGeometry(boxW, boxH, HORSE_BOX_LENGTH));
  const mountMat = cachedMaterial(`${matKeyPrefix}.mountMat`, () =>
    new THREE.MeshLambertMaterial({ color: bodyColor }));
  const mount = new THREE.Mesh(mountGeo, mountMat);
  mount.position.y = centerY;
  group.add(mount);

  group.scale.setScalar(1.0);
  // The rider seat height is deliberately the same for both variants —
  // a skeleton rider sits at the same world height as a flesh rider,
  // so switching LOD tiers never moves the rider up or down. The
  // thinner skeleton box has a small gap between its top and the
  // rider's underside, which is invisible at the distances this tier
  // is used at.
  group.userData.riderMountHeight = 0.70;
  return group;
}

export function createUltraSimpleHorseBase() {
  return buildUltraSimpleMount(0x4a2f1a, 'ultraSimple.horse', false);
}

export function createUltraSimpleSkeletonHorseBase() {
  return buildUltraSimpleMount(0xe8e0c8, 'ultraSimple.skelHorse', true);
}

// ---------------------------------------------------------------------------
// icons
// ---------------------------------------------------------------------------

export function createUltraSimpleHorseHead() {
  const group = new THREE.Group();
  const mat = cachedMaterial('ultraSimple.horseHeadMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));
  const geo = cachedGeometry('ultraSimple.horseHeadGeo', () =>
    new THREE.BoxGeometry(0.22, 0.24, 0.52));
  group.add(new THREE.Mesh(geo, mat));
  return group;
}

export function createUltraSimpleSkull() {
  const group = new THREE.Group();
  const boneMat = cachedMaterial('ultraSimple.skullBoneMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xe8e0c8 }));
  const socketMat = cachedMaterial('ultraSimple.skullSocketMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x1a1408 }));

  const craniumGeo = cachedGeometry('ultraSimple.skullCraniumGeo', () =>
    new THREE.BoxGeometry(0.26, 0.24, 0.24));
  group.add(new THREE.Mesh(craniumGeo, boneMat));

  const socketGeo = cachedGeometry('ultraSimple.skullSocketGeo', () =>
    new THREE.BoxGeometry(0.06, 0.06, 0.02));
  for (const sx of [-0.06, 0.06]) {
    const socket = new THREE.Mesh(socketGeo, socketMat);
    socket.position.set(sx, 0.01, 0.12);
    group.add(socket);
  }
  return group;
}

// ---------------------------------------------------------------------------
// quiver — omitted at this tier
// ---------------------------------------------------------------------------
// A back-worn container is invisible at ultra-simple distances. Return an
// empty Group so callers that unconditionally parent a quiver (the
// composer currently does this for every bow unit) need no branch — the
// group costs nothing and draws nothing.
export function createUltraSimpleQuiver() {
  return new THREE.Group();
}
// ===== SwordScytheBuilder.js =====
// ===== src/render/mesh/SwordScytheBuilder.js =====
// Dothraki-style sword scythe (arakht): a short-handled blade with a
// STRAIGHT base half that transitions into an UPWARD-CURVING tip half.
// Carried by the beast-mounted hobgoblins (see SoldierModelComposer — any
// unit whose mountType is 'beast' gets this weapon in place of its
// declared weaponType's default model).
//
// DISTINCT FROM SPEAR OR SWORD AT BATTLE ZOOM
//   - The blade is STRAIGHT along the first half of its length, then
//     bends upward through the second half — a "broken-back" silhouette
//     (kukri / falcata family) rather than a uniform crescent or a plain
//     straight blade. That single piece of geometry is what stops the
//     weapon from reading as either a sword or a spear at zoom.
//   - SHORT single-hand grip. No long shaft — this is a hand weapon, not
//     a polearm. Overall reach is sword-like (~0.85 units), not
//     spear-like.
//   - Dark ferrule at the grip/blade junction. Same role as the sword's
//     hilt collar and the crude goblin sword's collar: a silhouette break
//     between handle and blade so the two do not read as one stick.
//
// ORIENTATION
// Built along +Z like every other weapon, so SoldierView's yaw/pitch
// composition works unchanged. The blade's curve lies in the YZ plane
// (blade length along +Z, curve along +Y) so it reads in profile from
// the side — the same camera angle the sword's edge profile reads from.
//
// Geometry and materials are cached (see MeshCache.js) — every scythe in
// the game shares them.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

// Grip: a short wooden handle sized for one hand, matching the standard
// sword's grip length so the weapon's overall envelope is similar.
const GRIP_LENGTH = 0.20;
const GRIP_RADIUS = 0.022;

// Ferrule: a dark metal band at the grip/blade junction. Slightly wider
// than the grip so it reads as a distinct fitting rather than a colour
// change on the same cylinder.
const FERRULE_RADIUS = 0.030;
const FERRULE_LENGTH = 0.045;

// Blade thickness along world X. Thin enough that the extruded
// cross-section reads as a blade rather than as a bar.
const BLADE_THICKNESS = 0.018;

// Hand position in body-local space. Sits at roughly hobgoblin shoulder
// height (hobgoblin shoulder is at 0.72; the hand slightly below it) and
// matches the sword's hand height so the two weapons sit at the same
// point on the body when swapped.
const HAND_X = 0.24;
const HAND_Y = 0.62;
const HAND_Z = 0.00;

// Where the blade base sits relative to the hand (world Z). The ferrule
// occupies the gap between the hand and the blade base.
const BLADE_BASE_Z = 0.06;

export function createSwordScythe() {
  const group = new THREE.Group();
  group.position.set(HAND_X, HAND_Y, HAND_Z);

  const gripMat = cachedMaterial('swordScythe.gripMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x3a2510 }));
  const ferruleMat = cachedMaterial('swordScythe.ferruleMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a1a0e }));
  const bladeMat = cachedMaterial('swordScythe.bladeMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xb8b8b0 }));

  // Grip: short wooden cylinder laid along Z. Positioned so the hand sits
  // near its forward end — the back of the grip extends behind the hand.
  const gripGeo = cachedGeometry('swordScythe.gripGeo', () =>
    new THREE.CylinderGeometry(GRIP_RADIUS, GRIP_RADIUS * 0.9, GRIP_LENGTH, 6));
  const grip = new THREE.Mesh(gripGeo, gripMat);
  grip.rotation.x = Math.PI / 2;
  grip.position.z = -GRIP_LENGTH / 2 + 0.04;
  group.add(grip);

  // Ferrule: short dark band between the grip and the blade base.
  const ferruleGeo = cachedGeometry('swordScythe.ferruleGeo', () =>
    new THREE.CylinderGeometry(FERRULE_RADIUS, FERRULE_RADIUS, FERRULE_LENGTH, 6));
  const ferrule = new THREE.Mesh(ferruleGeo, ferruleMat);
  ferrule.rotation.x = Math.PI / 2;
  ferrule.position.z = BLADE_BASE_Z - FERRULE_LENGTH / 2;
  group.add(ferrule);

  // Blade: straight base half, upward-curving tip half. See
  // buildBladeGeometry for the shape and orientation transform.
  const bladeGeo = cachedGeometry('swordScythe.bladeGeo', buildBladeGeometry);
  const blade = new THREE.Mesh(bladeGeo, bladeMat);
  blade.position.z = BLADE_BASE_Z;
  group.add(blade);

  return group;
}

// Blade profile, drawn in shape-space (XY) with:
//   shape X = blade curve  (becomes world Y, "up")
//   shape Y = blade length (becomes world Z, "forward")
//   extrude depth          (becomes world X, "thickness")
//
// SHAPE — TWO SEGMENTS:
//
//   1. STRAIGHT half (shape Y from 0.00 to 0.37). Both edges run roughly
//      parallel up the length, with a very slight taper. This is what
//      makes the weapon read as a proper blade base rather than a curved
//      sickle all the way down to the grip.
//
//   2. CURVED half (shape Y from 0.37 to 0.80). Both edges turn upward
//      (higher shape-X) together, holding the same ~0.08 width through
//      the bend and then tapering to a point at the tip. The curve is a
//      gentle single arc — matching real broken-back blades (kukri,
//      falcata, kopis), which bend once near the tip for a heavier
//      chopping arc than a straight blade can deliver.
//
// The bend starts at shape Y = 0.37 — slightly less than half the blade
// length — so the "straight" read dominates the base and the "curved"
// read dominates the tip. Both halves share the same ~0.08 width, so
// there is no visible pinch or bulge at the transition.
//
// Both edges keep the ~0.08 width through the straight half; the tip is
// reached via a single continuous narrowing in the curved half. Nothing
// on the profile is thinner than the grip, so the blade never reads as
// fragile at battle zoom.
//
// Points are drawn counter-clockwise in shape-space so ExtrudeGeometry
// produces an outward-facing front cap and the winding is consistent
// with the other extruded blades in the codebase (see SwordBuilder's
// crude blade and ShieldBuilder's banner shield).
//
// BASE RECENTERING: the shape is authored with its base at shape-X
// [0.00 .. 0.08], but shape-X maps to world Y after the orientation
// rotations below. The grip and ferrule cylinders both run along the
// world Z axis through Y = 0, so an un-recentered base sits entirely on
// one side of the grip — the blade visibly hangs off the handle rather
// than springing from it. A translate of -0.04 on shape-X (applied
// after the extrusion-thickness centering but BEFORE the orientation
// rotations) shifts the base to [-0.04 .. +0.04], so it straddles the
// grip axis.
function buildBladeGeometry() {
  const shape = new THREE.Shape();

  // --- base (grip-side end) ---
  shape.moveTo(0.00, 0.00);   // inner base (cutting-edge side)
  shape.lineTo(0.08, 0.00);   // outer base (spine side)

  // --- STRAIGHT HALF: spine edge, running up the length ---
  // Very slight taper (0.08 → 0.09) so the base reads as a blade blank,
  // not a machined bar. Still visually straight at any distance.
  shape.lineTo(0.09, 0.37);

  // --- CURVED HALF: spine edge, turning upward ---
  shape.lineTo(0.15, 0.50);
  shape.lineTo(0.28, 0.62);
  shape.lineTo(0.46, 0.73);
  shape.lineTo(0.60, 0.80);   // TIP

  // --- CURVED HALF: cutting edge, coming back down ---
  shape.lineTo(0.38, 0.73);
  shape.lineTo(0.20, 0.62);
  shape.lineTo(0.07, 0.50);

  // --- STRAIGHT HALF: cutting edge, back to the base ---
  shape.lineTo(0.02, 0.37);
  shape.lineTo(0.00, 0.15);

  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: BLADE_THICKNESS,
    bevelEnabled: false,
    curveSegments: 1
  });

  // Centre the extrusion thickness on shape Z=0 so the rotation below
  // keeps the blade symmetric about the world X=0 plane.
  geo.translate(0, 0, -BLADE_THICKNESS / 2);

  // Recenter the base on the grip axis. See the BASE RECENTERING note
  // above — this translate must run BEFORE the orientation rotations,
  // because it operates on shape-X, which the rotations subsequently
  // remap to world Y.
  geo.translate(-0.04, 0, 0);

  // Orient: shape X -> world Y (curve up), shape Y -> world Z (forward),
  // shape Z -> world X (thickness). The composed rotation is rotateZ
  // then rotateY, each by +pi/2. Verified by hand: shape-space basis
  // vectors (1,0,0), (0,1,0), (0,0,1) map to world (0,1,0), (0,0,1),
  // (1,0,0) respectively.
  geo.rotateZ(Math.PI / 2);
  geo.rotateY(Math.PI / 2);

  return geo;
}
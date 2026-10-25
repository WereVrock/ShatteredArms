// ===== src/render/mesh/SpearScytheBuilder.js =====
// Dothraki-style spear scythe: a long wooden shaft with a curved crescent
// blade at the tip. Carried by the beast-mounted hobgoblins (see
// SoldierModelComposer — any unit whose mountType is 'beast' gets this
// weapon in place of its declared weaponType's default model).
//
// Built along +Z like every other weapon so SoldierView's yaw/pitch
// composition works unchanged. The blade lies in the YZ plane (blade
// length along +Z, curve along +Y) so it reads in profile from the
// side — the same camera angle the sword's edge profile reads from.
//
// Distinguishing silhouette cues (so this doesn't read as a spear or
// sword at battle zoom):
//   - The blade is a wide crescent, not a narrow point.
//   - The blade sits at the tip of a long uniform shaft, not on a hilt.
//   - A dark leather wrap marks the hand position, and a leather ferrule
//     bands the shaft at the blade join.
//
// Geometry and materials are cached (see MeshCache.js) — every scythe in
// the game shares them.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

// Shaft length. Slightly longer than the spear's 1.4 shaft; the blade
// adds another ~0.4 in front, so the total reach is between the spear
// and the lance. The shaft origin sits 0.20 behind the hand so the grip
// reads clearly in front of the body.
const SHAFT_LENGTH = 1.40;
const SHAFT_RADIUS = 0.020;

// Blade thickness along X (in world-aligned terms after the rotate below).
const BLADE_THICKNESS = 0.020;

// Ferrule / wrap dimensions.
const WRAP_RADIUS = 0.026;
const WRAP_LENGTH = 0.24;
const FERRULE_RADIUS = 0.026;
const FERRULE_LENGTH = 0.10;

// Hand position in body-local space. Sits at roughly hobgoblin shoulder
// height (hobgoblin shoulder is at 0.72; the hand slightly below it) so
// a mounted hobgoblin holds the scythe level-forward like a foot
// spearman — reinforcing the "almost fights on foot" read.
const HAND_X = 0.24;
const HAND_Y = 0.62;
const HAND_Z = 0.00;

export function createSpearScythe() {
  const group = new THREE.Group();
  group.position.set(HAND_X, HAND_Y, HAND_Z);

  const shaftMat = cachedMaterial('spearScythe.shaftMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a2f18 }));
  const bladeMat = cachedMaterial('spearScythe.bladeMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xb8b8b0 }));
  const wrapMat = cachedMaterial('spearScythe.wrapMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a1a0e }));

  // Shaft: uniform cylinder laid along Z. Positioned so the hand sits
  // 0.20 in from the back end and the blade ferrule sits at the front.
  const shaftGeo = cachedGeometry('spearScythe.shaftGeo', () =>
    new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_LENGTH, 6));
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = SHAFT_LENGTH / 2 - 0.20;
  group.add(shaft);

  // Hand wrap: a slightly thicker dark leather band where the hand
  // actually grips.
  const wrapGeo = cachedGeometry('spearScythe.wrapGeo', () =>
    new THREE.CylinderGeometry(WRAP_RADIUS, WRAP_RADIUS, WRAP_LENGTH, 6));
  const wrap = new THREE.Mesh(wrapGeo, wrapMat);
  wrap.rotation.x = Math.PI / 2;
  wrap.position.z = 0.02;
  group.add(wrap);

  // Ferrule: a short dark band at the blade-shaft join. Reads as the
  // binding that holds the blade socket onto the shaft.
  const ferruleGeo = cachedGeometry('spearScythe.ferruleGeo', () =>
    new THREE.CylinderGeometry(FERRULE_RADIUS, FERRULE_RADIUS, FERRULE_LENGTH, 6));
  const ferrule = new THREE.Mesh(ferruleGeo, wrapMat);
  ferrule.rotation.x = Math.PI / 2;
  ferrule.position.z = SHAFT_LENGTH - 0.20 - FERRULE_LENGTH / 2;
  group.add(ferrule);

  // Blade: an extruded crescent. Drawn in the XY plane (length along X,
  // curve along Y), extruded thin along Z, then rotated so the blade's
  // long axis lies along world +Z and its curve sweeps up along world +Y.
  const bladeGeo = cachedGeometry('spearScythe.bladeGeo', buildBladeGeometry);
  const blade = new THREE.Mesh(bladeGeo, bladeMat);
  blade.position.z = SHAFT_LENGTH - 0.20;
  group.add(blade);

  return group;
}

// Blade profile, drawn in the shape's local XY. Runs CCW so ExtrudeGeometry
// produces an outward-facing front cap. Long dimension along +X (which
// becomes world +Z after the rotate), crescent curve along +Y (which
// becomes world +Y). Nine points is enough — more vertices would be
// invisible at battle zoom.
function buildBladeGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0.00,  0.00);   // base, upper edge (shaft side)
  shape.lineTo(0.00, -0.06);   // base, lower edge
  shape.lineTo(0.14, -0.05);   // inner curve starting back
  shape.lineTo(0.30,  0.02);
  shape.lineTo(0.42,  0.16);   // TIP
  shape.lineTo(0.32,  0.10);   // outer curve back toward base
  shape.lineTo(0.16,  0.04);
  shape.lineTo(0.04,  0.02);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: BLADE_THICKNESS,
    bevelEnabled: false,
    curveSegments: 1
  });
  // Centre the extrusion thickness on Z first so the rotate below keeps
  // the blade symmetric about the shaft plane.
  geo.translate(0, 0, -BLADE_THICKNESS / 2);
  // rotateY(-π/2) maps shape-X → world +Z (blade length along the shaft),
  // shape-Y → world +Y (blade curve upward), thickness → world ±X.
  geo.rotateY(-Math.PI / 2);
  return geo;
}
// Bow aimed along +Z. The limb arc bulges forward of the string so the bow
// reads as a bow rather than a random half-torus, and pitching the weapon
// group tilts the whole thing into the firing arc. The string is a thin
// cylinder spanning the two limb tips.
//
// Geometry derivation (kept here so it survives future edits):
//   TorusGeometry(R, t, seg, seg, PI) builds a half ring in the XY plane,
//   belly at +Y, tips at (±R, 0, 0).
//   arc.rotation.z = +PI/2  → tips move to (0, ±R, 0), belly to (-R, 0, 0).
//   pivot.rotation.y = +PI/2 → belly swings from -X to +Z, tips unchanged.
//   Net result: limbs up/down, belly forward. Yaw = facing, pitch = aim.
//
// Geometry and materials are cached (see MeshCache.js).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

export function createBow() {
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  const radius = 0.24;

  const bowGeo = cachedGeometry('bow.bowGeo', () =>
    new THREE.TorusGeometry(radius, 0.02, 6, 14, Math.PI));
  const bowMat = cachedMaterial('bow.bowMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  const arc = new THREE.Mesh(bowGeo, bowMat);
  arc.rotation.z = Math.PI / 2;

  const pivot = new THREE.Group();
  pivot.rotation.y = Math.PI / 2;
  pivot.add(arc);
  group.add(pivot);

  const stringGeo = cachedGeometry('bow.stringGeo', () =>
    new THREE.CylinderGeometry(0.007, 0.007, radius * 2, 4));
  const stringMat = cachedMaterial('bow.stringMat', () =>
    new THREE.MeshBasicMaterial({ color: 0xdddddd }));
  const string = new THREE.Mesh(stringGeo, stringMat);
  group.add(string);

  return group;
}
// Standalone horse head + neck stub, centred at the origin. Used as the
// cavalry accent on the army-bar unit icon (see UnitIconComposer, which
// rotates it 90° around Y so the muzzle points screen-right).
//
// Faces +Z in local space — the horse's forward axis, matching the live
// mount. Muzzle to +Z, mane on the back, ears on top.
//
// Geometries and both materials are cached (see MeshCache.js).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

export function createHorseHead() {
  const group = new THREE.Group();

  const bodyMat = cachedMaterial('horseHead.bodyMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));
  const darkMat = cachedMaterial('horseHead.darkMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a1a0e }));

  // Neck stub dropping down and back from under the head.
  const neckGeo = cachedGeometry('horseHead.neckGeo', () =>
    new THREE.CylinderGeometry(0.09, 0.12, 0.30, 6));
  const neck = new THREE.Mesh(neckGeo, bodyMat);
  neck.position.set(0, -0.14, -0.10);
  neck.rotation.x = 0.55;
  group.add(neck);

  // Skull block — the main read.
  const headGeo = cachedGeometry('horseHead.headGeo', () =>
    new THREE.BoxGeometry(0.16, 0.18, 0.34));
  const head = new THREE.Mesh(headGeo, bodyMat);
  head.position.set(0, 0.03, 0.03);
  head.rotation.x = 0.25;
  group.add(head);

  // Muzzle: a short narrower box off the front, tipped slightly down.
  const muzzleGeo = cachedGeometry('horseHead.muzzleGeo', () =>
    new THREE.BoxGeometry(0.11, 0.12, 0.16));
  const muzzle = new THREE.Mesh(muzzleGeo, bodyMat);
  muzzle.position.set(0, -0.03, 0.24);
  muzzle.rotation.x = 0.25;
  group.add(muzzle);

  // Mane strip running up the back of the neck.
  const maneGeo = cachedGeometry('horseHead.maneGeo', () =>
    new THREE.BoxGeometry(0.05, 0.06, 0.26));
  const mane = new THREE.Mesh(maneGeo, darkMat);
  mane.position.set(0, 0.13, -0.11);
  mane.rotation.x = 0.55;
  group.add(mane);

  // Ears.
  const earGeo = cachedGeometry('horseHead.earGeo', () =>
    new THREE.ConeGeometry(0.028, 0.10, 4));
  for (const ex of [-0.055, 0.055]) {
    const ear = new THREE.Mesh(earGeo, darkMat);
    ear.position.set(ex, 0.17, -0.08);
    group.add(ear);
  }

  return group;
}
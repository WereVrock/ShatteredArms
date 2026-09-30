// Sword: steel blade + wooden hilt, laid along +Z.
//
// Geometry and materials are cached (see MeshCache.js).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

export function createSword() {
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  const bladeGeo = cachedGeometry('sword.bladeGeo', () =>
    new THREE.BoxGeometry(0.05, 0.7, 0.12));
  const bladeMat = cachedMaterial('sword.bladeMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));
  const blade = new THREE.Mesh(bladeGeo, bladeMat);
  blade.rotation.x = Math.PI / 2;
  blade.position.z = 0.45;
  group.add(blade);

  const hiltGeo = cachedGeometry('sword.hiltGeo', () =>
    new THREE.CylinderGeometry(0.03, 0.03, 0.16, 6));
  const hiltMat = cachedMaterial('sword.hiltMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a3018 }));
  const hilt = new THREE.Mesh(hiltGeo, hiltMat);
  hilt.rotation.x = Math.PI / 2;
  hilt.position.z = 0.05;
  group.add(hilt);

  return group;
}
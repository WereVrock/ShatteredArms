// Spear: wooden shaft + steel tip, laid along +Z so SoldierView's weapon yaw
// and pitch compose cleanly.
//
// Geometry and materials are cached (see MeshCache.js) — all spears share
// one shaft geometry, one tip geometry, and two shared materials.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

export function createSpear() {
  const group = new THREE.Group();
  group.position.set(0.24, 0.65, 0);

  const shaftGeo = cachedGeometry('spear.shaftGeo', () =>
    new THREE.CylinderGeometry(0.02, 0.02, 1.4, 6));
  const shaftMat = cachedMaterial('spear.shaftMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.6;
  group.add(shaft);

  const tipGeo = cachedGeometry('spear.tipGeo', () =>
    new THREE.ConeGeometry(0.04, 0.18, 6));
  const tipMat = cachedMaterial('spear.tipMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));
  const tip = new THREE.Mesh(tipGeo, tipMat);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = 1.3;
  group.add(tip);

  return group;
}
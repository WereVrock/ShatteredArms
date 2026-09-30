// Cavalry lance: longer shaft than a spear, laid along +Z.
//
// Geometry and materials are cached (see MeshCache.js).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

export function createLance() {
  const group = new THREE.Group();
  group.position.set(0.26, 0.70, 0);

  const shaftGeo = cachedGeometry('lance.shaftGeo', () =>
    new THREE.CylinderGeometry(0.025, 0.025, 2.0, 6));
  const shaftMat = cachedMaterial('lance.shaftMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.9;
  group.add(shaft);

  const tipGeo = cachedGeometry('lance.tipGeo', () =>
    new THREE.ConeGeometry(0.05, 0.22, 6));
  const tipMat = cachedMaterial('lance.tipMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));
  const tip = new THREE.Mesh(tipGeo, tipMat);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = 1.95;
  group.add(tip);

  return group;
}
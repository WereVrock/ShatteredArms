// Small white flag on a short pole, hoisted above the soldier's head.
// Attached to the rider sub-group so it moves with the rider on cavalry.
// Hidden by default; SoldierView.sync() shows it while the soldier is
// routing. Pole + banner, ~0.6 units tall in local space.
//
// Geometry and both materials are cached (see MeshCache.js).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

export function createWhiteFlag() {
  const group = new THREE.Group();

  const poleGeo = cachedGeometry('flag.poleGeo', () =>
    new THREE.CylinderGeometry(0.012, 0.012, 0.6, 4));
  const poleMat = cachedMaterial('flag.poleMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  const pole = new THREE.Mesh(poleGeo, poleMat);
  group.add(pole);

  const bannerGeo = cachedGeometry('flag.bannerGeo', () =>
    new THREE.PlaneGeometry(0.28, 0.2));
  const bannerMat = cachedMaterial('flag.bannerMat', () =>
    new THREE.MeshLambertMaterial({
      color: 0xf2f2f2,
      side: THREE.DoubleSide
    }));
  const banner = new THREE.Mesh(bannerGeo, bannerMat);
  banner.position.set(0.14, 0.2, 0);
  group.add(banner);

  // Slight lean-back so it reads as a drooping banner, not a rigid pole.
  group.rotation.x = -0.15;

  return group;
}
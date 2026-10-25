// Small white flag on a short pole, hoisted above the soldier's head.
// Attached to the rider sub-group so it moves with the rider on cavalry.
// Hidden by default; SoldierView.sync() shows it while the soldier is
// routing.
//
// MERGE STRATEGY
// Pole and banner merge into a SINGLE vertex-coloured mesh. DoubleSide is
// required because the banner is a flat plane; the pole tolerates the
// flag without any visual change.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeColoredGeometries, partMatrix, paint } from './MeshMerge.js';

const POLE_COLOR   = 0x5a3d20;
const BANNER_COLOR = 0xf2f2f2;

export function createWhiteFlag() {
  const geo = cachedGeometry('flag.mergedGeo', buildMergedFlag);
  const mat = cachedMaterial('flag.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const mesh = new THREE.Mesh(geo, mat);
  // Slight lean-back so it reads as a drooping banner, not a rigid pole.
  mesh.rotation.x = -0.15;
  return mesh;
}

function buildMergedFlag() {
  const entries = [];

  // Pole.
  entries.push({
    geometry: paint(
      new THREE.CylinderGeometry(0.012, 0.012, 0.6, 4), POLE_COLOR)
  });

  // Banner.
  entries.push({
    geometry: paint(new THREE.PlaneGeometry(0.28, 0.2), BANNER_COLOR),
    matrix: partMatrix(0.14, 0.2, 0)
  });

  return mergeColoredGeometries(entries);
}
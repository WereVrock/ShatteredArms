import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './mesh/MeshCache.js';

// Builds a flat ring mesh shown under a selected unit's soldiers.
// Geometry and material are shared across every selection ring in the game
// (see MeshCache.js) — the ring is never mutated per-soldier.
export class SelectionRingFactory {
  static createRing() {
    const geo = cachedGeometry('selectionRing.geo', () =>
      new THREE.RingGeometry(0.28, 0.34, 16));
    const mat = cachedMaterial('selectionRing.mat', () =>
      new THREE.MeshBasicMaterial({ color: 0x4caf50, side: THREE.DoubleSide }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.02;
    mesh.visible = false;
    return mesh;
  }
}
// Round wooden shield. Rotated to stand upright facing +Z (the unit's forward
// axis) so SoldierView can position and rotate it per-soldier without further
// transformation.
//
// Geometry is cached (see MeshCache.js). Material is per-instance: SoldierView
// tints the shield toward black as shieldHp drops, so each shield needs its
// own material to write to.
import * as THREE from 'three';
import { cachedGeometry } from './MeshCache.js';

export function createShield() {
  const geo = cachedGeometry('shield.geo', () =>
    new THREE.CylinderGeometry(0.22, 0.22, 0.06, 12));
  // Per-instance: SoldierView tints this toward black as shieldHp drops.
  const mat = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}
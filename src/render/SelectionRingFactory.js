// Shared ring geometry + material for the army's selection indicators.
//
// The individual-mesh variant (createRing) is retained for any one-off
// use, but the primary path is now instanced: BattleRenderer owns ONE
// InstancedMesh of these rings and populates it from the currently-
// selected soldiers each frame. That removes one scene-graph node per
// soldier (196 in the reference battle) and one per-frame visibility
// write per soldier, with zero visual change.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './mesh/MeshCache.js';

const RING_INNER = 0.28;
const RING_OUTER = 0.34;
const RING_SEGMENTS = 16;
const RING_COLOR = 0x4caf50;

export class SelectionRingFactory {
  // Shared geometry — the ring shape never changes.
  static getGeometry() {
    return cachedGeometry('selectionRing.geo', () =>
      new THREE.RingGeometry(RING_INNER, RING_OUTER, RING_SEGMENTS));
  }

  // Shared material. Because the ring is drawn as an InstancedMesh, every
  // instance uses this one material instance — no per-soldier material
  // copy exists anywhere in the codebase.
  static getMaterial() {
    return cachedMaterial('selectionRing.mat', () =>
      new THREE.MeshBasicMaterial({ color: RING_COLOR, side: THREE.DoubleSide }));
  }

  // Legacy single-mesh variant. Kept so a caller that needs exactly one
  // standalone ring (an icon preview, a test scene) still has a
  // well-defined way to build it.
  static createRing() {
    const mesh = new THREE.Mesh(SelectionRingFactory.getGeometry(),
                                SelectionRingFactory.getMaterial());
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.02;
    mesh.visible = false;
    return mesh;
  }
}
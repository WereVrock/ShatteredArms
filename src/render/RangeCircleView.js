import * as THREE from 'three';
import { ActiveTerrain } from '../session/ActiveTerrain.js';

// Number of angular segments around the ring. 96 is the count the old
// RingGeometry used and is smooth at every zoom level this game supports.
const SEGMENTS = 96;

// Inner / outer radius of the ring band, as fractions of the range radius.
// 0.98-1.00 leaves a 2%-of-radius band, which at range 14 reads as a
// ~0.28 unit line — visible but not dominating.
const INNER_FRACTION = 0.98;
const OUTER_FRACTION = 1.00;

// Terrain lift: how far above the sampled surface the ring sits. Small
// enough that it reads as "painted on the ground", large enough that
// floating-point differences between the terrain render mesh and the
// heightfield sampler don't cause z-fighting.
const RING_Y_LIFT = 0.06;

// A flat ring on the ground marking a ranged unit's effective firing range.
// Projected onto the terrain: each vertex samples the heightfield at its
// own world XZ so the ring follows hills, valleys and shorelines instead of
// cutting through them as a flat horizontal disc would. Rebuilt when the
// archer moves or the range changes; unchanged positions are a no-op.
//
// Drawn THROUGH terrain and units (depthTest: false, high renderOrder) so
// the player can always see the boundary regardless of what is between the
// camera and the ground under it — the same choice Total War and similar
// games make for their range indicators. Combined with the per-vertex
// terrain sampling, the ring reads as a contour line projected onto the
// landscape even though it is technically a UI overlay.
export class RangeCircleView {
  constructor(scene) {
    this.scene = scene;

    // Vertex buffer: one inner and one outer vertex per segment endpoint,
    // shared at the seam (SEGMENTS + 1 pairs, i = 0 and i = SEGMENTS are
    // the same angle but different triangles).
    const vertexCount = (SEGMENTS + 1) * 2;
    const positions = new Float32Array(vertexCount * 3);

    // Two triangles per segment, wound so the ring faces up. FrontSide
    // would work but DoubleSide is more forgiving of a ring that tips
    // slightly on a steep slope; the cost is negligible for a 192-vertex
    // mesh.
    const indices = new Uint16Array(SEGMENTS * 6);
    for (let i = 0; i < SEGMENTS; i++) {
      const base = i * 6;
      const inner0 = i * 2;
      const outer0 = i * 2 + 1;
      const inner1 = (i + 1) * 2;
      const outer1 = (i + 1) * 2 + 1;
      indices[base + 0] = inner0;
      indices[base + 1] = outer0;
      indices[base + 2] = inner1;
      indices[base + 3] = inner1;
      indices[base + 4] = outer0;
      indices[base + 5] = outer1;
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geo.setIndex(new THREE.BufferAttribute(indices, 1));

    this.mat = new THREE.MeshBasicMaterial({
      color: 0x6fd6ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      depthTest: false
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    // After terrain (0), water (2), and soldier meshes (default 0). The
    // ring draws last so it sits on top of everything, even though the
    // vertices are on the terrain surface.
    this.mesh.renderOrder = 10;
    // The bounding sphere of a 192-vertex ring whose vertices are written
    // per frame would be stale without recomputation; since the ring is
    // only visible when the archer is in view, culling it saves nothing.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    scene.add(this.mesh);

    // Cache the last (x, z, radius) so an archer standing still does not
    // rebuild the ring every frame. The terrain does not change during a
    // battle, so a matching triple means the vertex positions are still
    // correct.
    this._lastX = NaN;
    this._lastZ = NaN;
    this._lastR = NaN;
  }

  show(x, z, radius) {
    this.mesh.visible = true;

    // Skip the rebuild when nothing changed. NaN never equals NaN, so
    // the first call after construction always rebuilds.
    if (x === this._lastX && z === this._lastZ && radius === this._lastR) {
      return;
    }
    this._lastX = x;
    this._lastZ = z;
    this._lastR = radius;

    const pos = this.geo.attributes.position.array;
    const innerR = INNER_FRACTION * radius;
    const outerR = OUTER_FRACTION * radius;

    for (let i = 0; i <= SEGMENTS; i++) {
      // Wrap the seam: i = SEGMENTS produces the same angle as i = 0,
      // but a separate vertex so the ring closes without a shared edge.
      const angle = (i / SEGMENTS) * Math.PI * 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      const innerX = x + cosA * innerR;
      const innerZ = z + sinA * innerR;
      const outerX = x + cosA * outerR;
      const outerZ = z + sinA * outerR;

      const innerY = ActiveTerrain.heightAt(innerX, innerZ) + RING_Y_LIFT;
      const outerY = ActiveTerrain.heightAt(outerX, outerZ) + RING_Y_LIFT;

      const iInner = i * 2 * 3;
      const iOuter = (i * 2 + 1) * 3;

      pos[iInner + 0] = innerX;
      pos[iInner + 1] = innerY;
      pos[iInner + 2] = innerZ;

      pos[iOuter + 0] = outerX;
      pos[iOuter + 1] = outerY;
      pos[iOuter + 2] = outerZ;
    }

    this.geo.attributes.position.needsUpdate = true;
    // frustumCulled is false, so the bounding sphere is never consulted;
    // no need to recompute it.
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
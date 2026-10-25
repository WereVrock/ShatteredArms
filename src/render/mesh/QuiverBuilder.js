// ===== QuiverBuilder.js =====
// Small cylindrical quiver with arrows poking out the top, worn on an
// archer's back. Attached to the body by SoldierModelComposer when the
// unit type's weaponType is 'bow'.
//
// MERGE STRATEGY
// Body, rim, two straps, and five arrows (each shaft + two crossed
// fletches) are all rigidly attached and share at most four colours. They
// merge into a SINGLE vertex-coloured mesh (see MeshMerge.paint /
// mergeColoredGeometries) — one draw call per quiver instead of nineteen,
// with zero visual change. Every geometry in the pre-merge list is built
// fresh; the merged result is what gets cached.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeColoredGeometries, partMatrix, paint } from './MeshMerge.js';

const QUIVER_HEIGHT = 0.22;
const QUIVER_RIM_RADIUS = 0.048;
const QUIVER_BASE_RADIUS = 0.040;

const ARROW_LAYOUT = [
  { x:  0.016, z:  0.008, y: QUIVER_HEIGHT + 0.06, tiltX:  0.03, tiltZ:  0.10 },
  { x: -0.016, z: -0.008, y: QUIVER_HEIGHT + 0.07, tiltX: -0.08, tiltZ: -0.05 },
  { x:  0.006, z: -0.020, y: QUIVER_HEIGHT + 0.05, tiltX: -0.04, tiltZ:  0.12 },
  { x: -0.022, z:  0.014, y: QUIVER_HEIGHT + 0.08, tiltX:  0.06, tiltZ: -0.09 },
  { x:  0.022, z: -0.004, y: QUIVER_HEIGHT + 0.04, tiltX:  0.02, tiltZ:  0.06 }
];

const ARROW_SHAFT_LENGTH = 0.20;
const ARROW_SHAFT_RADIUS = 0.007;

const LEATHER_COLOR = 0x5a3d20;
const TRIM_COLOR    = 0x3a2510;
const SHAFT_COLOR   = 0x8a5a24;
const FLETCH_COLOR  = 0xdddddd;

export function createQuiver() {
  const geo = cachedGeometry('quiver.mergedGeo', buildMergedQuiver);
  const mat = cachedMaterial('quiver.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  return new THREE.Mesh(geo, mat);
}

function buildMergedQuiver() {
  const entries = [];

  // Body: tapered cylinder, base at Y=0 rising to Y=QUIVER_HEIGHT.
  entries.push({
    geometry: paint(
      new THREE.CylinderGeometry(
        QUIVER_RIM_RADIUS, QUIVER_BASE_RADIUS, QUIVER_HEIGHT, 8),
      LEATHER_COLOR
    ),
    matrix: partMatrix(0, QUIVER_HEIGHT / 2, 0)
  });

  // Rim: slightly wider dark band at the mouth.
  entries.push({
    geometry: paint(
      new THREE.CylinderGeometry(
        QUIVER_RIM_RADIUS + 0.004, QUIVER_RIM_RADIUS + 0.004, 0.020, 8),
      TRIM_COLOR
    ),
    matrix: partMatrix(0, QUIVER_HEIGHT - 0.005, 0)
  });

  // Two straps hugging the sides. The second strap is authored at the
  // same local position as the first and then rotated 90° around Y — the
  // rotation is baked into the partMatrix, so no wrap group is needed.
  const strapOffset = 0.044;
  entries.push({
    geometry: paint(
      new THREE.BoxGeometry(0.010, QUIVER_HEIGHT, 0.006), TRIM_COLOR),
    matrix: partMatrix(0, QUIVER_HEIGHT / 2, strapOffset)
  });
  entries.push({
    geometry: paint(
      new THREE.BoxGeometry(0.010, QUIVER_HEIGHT, 0.006), TRIM_COLOR),
    matrix: partMatrix(strapOffset, QUIVER_HEIGHT / 2, 0, 0, Math.PI / 2, 0)
  });

  // Arrows. Each arrow's world matrix is one partMatrix; the shaft is at
  // the arrow's origin, the fletches are offset within it and rotated by
  // one of two angles.
  for (const a of ARROW_LAYOUT) {
    const arrowMatrix = partMatrix(a.x, a.y, a.z, a.tiltX, 0, a.tiltZ);

    entries.push({
      geometry: paint(
        new THREE.CylinderGeometry(
          ARROW_SHAFT_RADIUS, ARROW_SHAFT_RADIUS, ARROW_SHAFT_LENGTH, 5),
        SHAFT_COLOR
      ),
      matrix: arrowMatrix.clone()
    });

    for (const rot of [0, Math.PI / 2]) {
      const fletchLocal = partMatrix(0, ARROW_SHAFT_LENGTH / 2 - 0.03, 0, 0, rot, 0);
      entries.push({
        geometry: paint(
          new THREE.BoxGeometry(0.024, 0.045, 0.006), FLETCH_COLOR),
        matrix: arrowMatrix.clone().multiply(fletchLocal)
      });
    }
  }

  return mergeColoredGeometries(entries);
}
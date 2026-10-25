// ===== src/render/mesh/BlobBodyBuilder.js =====
// Bad-North-style blob body: an organically tapered lathe torso, sphere
// head, and the shared legs. Built from primitives with no external assets.
//
// Torso and head share one material and never move relative to each other,
// so they merge into a single mesh (see MeshMerge.js) — one draw call per
// soldier instead of two, with zero visual change. Legs stay separate:
// each hip and knee is a live pivot the walk cycle writes to.
//
// The merged body geometry is cached (see MeshCache.js); the body material
// stays per-instance because SoldierView.sync tints it toward black as HP
// drops.
import * as THREE from 'three';
import { HelmetFactory } from '../HelmetFactory.js';
import { LEG_HIP_Y, addLegs } from './LegBuilder.js';
import { cachedGeometry } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

// Blob torso geometry.
//
// TORSO_BOTTOM_Y sits one pelvis-half-height BELOW the leg hip line, so the
// torso visually covers the top of the legs — the SAME overlap the skeleton
// body's pelvis gives its legs. Without this overlap, the skeleton's hip
// would appear lower than the blob's (its pelvis extends visibly below the
// leg attachment) and the blob's legs would look longer even though both
// attach at the same LEG_HIP_Y. Matching the overlap is what makes the two
// body styles read as the same height and same visible leg length.
const PELVIS_HALF_HEIGHT = 0.05;
const TORSO_BOTTOM_Y = LEG_HIP_Y - PELVIS_HALF_HEIGHT;
const TORSO_TOP_Y = 1.05;

// Head centre. Sits just below the torso top by the same small offset the
// original used (0.03), so the head still nestles into the neck. The helmet
// builders position themselves relative to this Y via HelmetFactory.HEAD_Y,
// which MUST match this value.
export const BLOB_HEAD_Y = TORSO_TOP_Y - 0.03;

const HEAD_RADIUS = 0.16;

// Lathe profile for the torso silhouette: wide at the hip, curving
// organically to a narrow shoulder/neck. Each point is (radius, y). The
// first and last points sit on the axis so the lathe closes its top and
// bottom caps. A curved profile (rather than a linear cone) is what makes
// the taper read as a body rather than a traffic cone.
const TORSO_PROFILE = [
  // Bottom cap — on the axis, then out to the hip radius.
  new THREE.Vector2(0.00, TORSO_BOTTOM_Y),
  new THREE.Vector2(0.22, TORSO_BOTTOM_Y),
  // Curved taper up the body.
  new THREE.Vector2(0.21,  TORSO_BOTTOM_Y + 0.12),
  new THREE.Vector2(0.19,  TORSO_BOTTOM_Y + 0.26),
  new THREE.Vector2(0.17,  TORSO_BOTTOM_Y + 0.42),
  new THREE.Vector2(0.155, TORSO_BOTTOM_Y + 0.58),
  new THREE.Vector2(0.145, TORSO_BOTTOM_Y + 0.72),
  // Top edge and cap.
  new THREE.Vector2(0.14,  TORSO_TOP_Y),
  new THREE.Vector2(0.00,  TORSO_TOP_Y)
];

// 12 radial segments is enough for a smooth silhouette at battle zoom; the
// lathe auto-computes smooth vertex normals from the profile. 10 lat / 8
// lon for the head matches the original.
const TORSO_RADIAL_SEGMENTS = 12;
const HEAD_LAT_SEGMENTS = 10;
const HEAD_LON_SEGMENTS = 8;

export function createBlobBody(color, helmetType) {
  const group = new THREE.Group();
  // Per-instance: SoldierView tints this toward black as HP drops.
  const mat = new THREE.MeshLambertMaterial({ color });

  // Torso + head merged into one mesh. They share `mat` and are rigidly
  // attached, so a single draw call covers both parts.
  const bodyGeo = cachedGeometry('blob.bodyGeo', () =>
    mergeGeometries([
      { geometry: new THREE.LatheGeometry(TORSO_PROFILE, TORSO_RADIAL_SEGMENTS) },
      {
        geometry: new THREE.SphereGeometry(HEAD_RADIUS, HEAD_LAT_SEGMENTS, HEAD_LON_SEGMENTS),
        matrix: partMatrix(0, BLOB_HEAD_Y, 0)
      }
    ])
  );
  group.add(new THREE.Mesh(bodyGeo, mat));

  addLegs(group, mat);

  // Helmet is data-driven from UnitType.helmetType (see config/UnitTypes.js).
  // null / unknown helmetType leaves the head sphere bare — the sphere IS
  // the bare-head silhouette, so no separate fallback mesh is needed.
  const helmet = HelmetFactory.createForType(helmetType, color);
  if (helmet) group.add(helmet);

  group.userData.baseMaterial = mat;
  return group;
}
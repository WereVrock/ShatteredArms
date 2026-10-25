// ===== src/render/mesh/GoblinRags.js =====
// Tattered cloth for a humanoid body: a waist wrap with a hanging fringe,
// and an asymmetric drape slung over one side of the chest. Rendered in the
// OWNER'S TEAM COLOUR — the body mesh lerps toward race green, so the rags
// are the only place team identity survives on a goblin at battle zoom.
//
// WHY THIS IS A SEPARATE MODULE
// GoblinBodyBuilder owns anatomy: proportions, posture, silhouette. Rags are
// costume and must not know a goblin's leg length, and the body builder must
// not grow a second set of cloth constants. This module therefore asks the
// wearer for measurements only — the waist line, the radius there, and the
// chest profile — and can dress any biped with them.
//
// WHY TWO ENTRY POINTS
// The goblin torso is two lathes: a vertical pelvis and a tilted chest (see
// GoblinBodyBuilder). The waist wrap belongs to the vertical pelvis and is
// returned in body space; the chest drape belongs to the tilted chest and is
// returned in the slouch pivot's LOCAL space. The caller parents each piece
// to the right group — this module never guesses at the wearer's rig.
//
// MERGE STRATEGY
// Every rag piece uses the same per-instance material. The belt, the six
// fringe strips, and the two loincloth panels all merge into a single mesh
// per body (see MeshMerge.js) — one draw call for the entire costume
// instead of nine, with zero visual change. The chest drape remains a
// single mesh because it is a partial lathe.
//
// WHY THE MATERIAL IS DOUBLE-SIDED
// Every piece here is an open shell: an unclosed cylinder, a partial lathe, a
// flat panel. With FrontSide the inside of the drape would be invisible and
// you would see straight through the cloth. That flag is set here rather than
// by the caller because it is a property of the cloth, not of the wearer.
//
// Geometries are cached (see MeshCache.js) under a caller-supplied prefix, so
// two different races can wear rags without colliding in the cache. The
// material stays per-instance: SoldierView tints it toward black as HP drops.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

// --- waist wrap proportions ------------------------------------------------
// Expressed as multiples of the wearer's waist radius, so the cloth scales
// with the body instead of needing retuning per race.

const BELT_RADIUS_SCALE    = 1.30;
const BELT_HEIGHT_SCALE    = 0.80;
const BELT_RADIAL_SEGMENTS = 10;

const TATTER_WIDTH_SCALE = 0.42;
const TATTER_DEPTH_SCALE = 0.14;
const TATTER_FLARE_RAD   = 0.18;

// One entry per hanging strip: angle around the waist (0 = front, turning
// toward the wearer's left) and length as a multiple of the waist radius.
// Both are deliberately uneven — a uniform fringe reads as a skirt, not as
// rags.
const TATTERS = [
  { angle:  0.00, length: 1.70 },
  { angle:  0.72, length: 1.25 },
  { angle: -0.72, length: 1.50 },
  { angle:  1.62, length: 1.05 },
  { angle: -1.62, length: 1.35 },
  { angle:  2.95, length: 1.65 }
];

// --- chest drape proportions -----------------------------------------------

const DRAPE_SEGMENTS = 8;

// --- material --------------------------------------------------------------

// Pure team colour, no race tint: the body is already 55% green, so leaving
// the rags unmixed is what keeps the team read legible on the model.
// Shared per team colour: nothing mutates the rag material per soldier, so
// every goblin of a team can use the same instance (fewer state changes).
export function createRagMaterial(teamColor) {
  return cachedMaterial(`goblinRags.mat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({
      color: new THREE.Color(teamColor),
      side: THREE.DoubleSide
    }));
}

// --- waist wrap ------------------------------------------------------------

// Belt plus fringe, in the wearer's body space (the frame of the vertical
// pelvis). Belt and every strip share the same rag material, so they merge
// into a single Mesh.
export function createWaistRags(ragMat, { waistY, waistRadius, cachePrefix }) {
  const geo = cachedGeometry(`${cachePrefix}.waistRagsGeo`, () =>
    buildWaistRagsGeometry({ waistY, waistRadius }));

  return new THREE.Mesh(geo, ragMat);
}

function buildWaistRagsGeometry({ waistY, waistRadius }) {
  const beltRadius = waistRadius * BELT_RADIUS_SCALE;
  const beltHeight = waistRadius * BELT_HEIGHT_SCALE;

  // Unit cylinder, scaled per wearer. Open-ended: the caps would be hidden
  // inside the torso anyway.
  const entries = [
    {
      geometry: new THREE.CylinderGeometry(1, 1, 1, BELT_RADIAL_SEGMENTS, 1, true),
      matrix: new THREE.Matrix4().compose(
        new THREE.Vector3(0, waistY, 0),
        new THREE.Quaternion(),
        new THREE.Vector3(beltRadius, beltHeight, beltRadius)
      )
    }
  ];

  // One unit panel reused for every strip; width, length, and thickness
  // are all carried by the strip's own transform.
  const panelBase = () => new THREE.BoxGeometry(1, 1, 1);

  // Tops sit inside the belt's lower half, so each strip reads as tucked
  // under the belt rather than glued to its underside.
  const topY = waistY - beltHeight * 0.35;

  const outward = new THREE.Vector3();
  const hang = new THREE.Vector3();
  const attach = new THREE.Vector3();
  const panelQuat = new THREE.Quaternion();
  const panelScale = new THREE.Vector3();

  for (const tatter of TATTERS) {
    outward.set(Math.sin(tatter.angle), 0, Math.cos(tatter.angle));
    const length = waistRadius * tatter.length;

    // Hang direction: mostly straight down, swung outward by TATTER_FLARE_RAD
    // so the hem clears the thigh instead of clipping into it mid-stride.
    hang.set(0, -1, 0)
      .multiplyScalar(Math.cos(TATTER_FLARE_RAD))
      .addScaledVector(outward, Math.sin(TATTER_FLARE_RAD))
      .normalize();

    // Mesh centre sits half a length along `hang` from the attach point.
    attach.set(
      outward.x * beltRadius * 0.94,
      topY,
      outward.z * beltRadius * 0.94
    ).addScaledVector(hang, length / 2);

    panelQuat.setFromRotationMatrix(panelBasis(hang, outward));
    panelScale.set(
      waistRadius * TATTER_WIDTH_SCALE,
      length,
      waistRadius * TATTER_DEPTH_SCALE
    );

    entries.push({
      geometry: panelBase(),
      matrix: new THREE.Matrix4().compose(attach.clone(), panelQuat.clone(), panelScale.clone())
    });
  }

  return mergeGeometries(entries);
}

// --- chest drape -----------------------------------------------------------

// A partial lathe that follows the chest profile, pushed outward by `pad`.
// Because it reuses the wearer's own profile it hugs a tapering torso exactly
// — a cylinder or a torus would either float off the narrow end or sink into
// the wide one. phiStart/phiLength leave the rest of the chest bare, so the
// result reads as a slung cloth rather than a second belt.
//
// Returns null if the requested height range does not intersect the profile;
// callers should skip adding it rather than crash on a degenerate lathe.
export function createChestDrape(ragMat, {
  profile, pad, yFrom, yTo, phiStart, phiLength, cacheKey
}) {
  const slice = offsetProfileSlice(profile, yFrom, yTo, pad);
  if (slice.length < 2) return null;

  const geo = cachedGeometry(cacheKey, () =>
    new THREE.LatheGeometry(slice, DRAPE_SEGMENTS, phiStart, phiLength));

  return new THREE.Mesh(geo, ragMat);
}

// --- loincloth -------------------------------------------------------------

// A pair of curved panels hanging from the belt: one across the front of the
// pelvis, one across the back. Both are arcs of a cylinder — a flat box panel
// would read as a board, while a full cylinder would be a skirt. A partial
// arc keeps the pelvis open at the sides, which is what distinguishes a
// loincloth from a skirt at silhouette distance.
//
// Front and back panels are rigidly attached and share one material, so they
// merge into a single Mesh.
export function createLoincloth(ragMat, {
  waistY, waistRadius, cachePrefix,
  lengthScale = 1.9,
  arcRad      = 1.10,
  flare       = 1.35
}) {
  const geo = cachedGeometry(`${cachePrefix}.loinclothGeo`, () =>
    buildLoinclothGeometry({ waistY, waistRadius, lengthScale, arcRad, flare }));

  return new THREE.Mesh(geo, ragMat);
}

function buildLoinclothGeometry({ waistY, waistRadius, lengthScale, arcRad, flare }) {
  const height    = waistRadius * lengthScale;
  const topRadius = waistRadius * BELT_RADIUS_SCALE;
  const centreY   = waistY - height / 2;

  // Unit cylinder, tapering from 1 to `flare`, open-ended, arc centred on +Z.
  const frontGeo = new THREE.CylinderGeometry(1, flare, 1, 8, 1, true, -arcRad / 2, arcRad);
  const frontMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(0, centreY, 0),
    new THREE.Quaternion(),
    new THREE.Vector3(topRadius, height, topRadius)
  );

  // Back panel: same arc rotated 180° about Y. Rotating the geometry (not
  // scaling by -1 on Z) keeps the winding order intact.
  const backGeo = new THREE.CylinderGeometry(1, flare, 1, 8, 1, true, -arcRad / 2, arcRad);
  const backMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(0, centreY, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)),
    new THREE.Vector3(topRadius, height, topRadius)
  );

  return mergeGeometries([
    { geometry: frontGeo, matrix: frontMatrix },
    { geometry: backGeo,  matrix: backMatrix }
  ]);
}

// --- profile slicing -------------------------------------------------------

// Radius of a lathe profile at an arbitrary height, by linear interpolation
// between the two vertices that bracket it. Returns 0 outside the profile.
function profileRadiusAt(profile, y) {
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (b.y < y || a.y > y) continue;
    const dy = b.y - a.y;
    if (dy <= 0) continue;
    return a.x + (b.x - a.x) * ((y - a.y) / dy);
  }
  return 0;
}

// Slice the profile between two heights and push every point outward by
// `pad`. The endpoints are interpolated so the drape's top and bottom edges
// land exactly where the caller asked, not on the nearest profile vertex.
// Zero-radius vertices (the profile's closed caps) are dropped.
function offsetProfileSlice(profile, yFrom, yTo, pad) {
  const slice = [new THREE.Vector2(profileRadiusAt(profile, yFrom) + pad, yFrom)];

  for (const point of profile) {
    if (point.y > yFrom && point.y < yTo && point.x > 0) {
      slice.push(new THREE.Vector2(point.x + pad, point.y));
    }
  }

  slice.push(new THREE.Vector2(profileRadiusAt(profile, yTo) + pad, yTo));
  return slice;
}

// --- orientation helper ----------------------------------------------------

// Orthonormal frame for a flat panel: local +Y runs along `along` (the hang
// direction), local +Z faces `outward`. A basis is used instead of Euler
// angles because the panel has to satisfy two constraints at once — hang
// this way AND face that way — and a basis states exactly those two things.
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _basis = new THREE.Matrix4();

function panelBasis(along, outward) {
  _yAxis.copy(along).normalize();
  _zAxis.copy(outward).addScaledVector(_yAxis, -outward.dot(_yAxis)).normalize();
  _xAxis.copy(_yAxis).cross(_zAxis);
  return _basis.makeBasis(_xAxis, _yAxis, _zAxis);
}
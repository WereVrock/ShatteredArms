// ===== BlobBodyBuilder.js =====
// ===== src/render/mesh/BlobBodyBuilder.js =====
// Bad-North-style blob body: an organically tapered lathe torso, sphere
// head, hair on the back of the head, and the shared legs. Built from
// primitives with no external assets.
//
// Torso, head, and hair are THREE SEPARATE meshes because they carry
// different per-instance base colours: torso = team colour, head = random
// skin tone, hair = random hair colour. They cannot share one material, so
// they cannot merge. Every geometry is cached (see MeshCache.js); only the
// materials are per-instance. SoldierView tints all three together toward
// black as HP drops (see _applyBodyTint).
//
// Legs stay separate too: each hip and knee is a live pivot the walk cycle
// writes to. The merged/static-leg optimisation in SoldierModelComposer
// bakes the walk cycle onto the torso material, so legs dim in lockstep
// with the torso.
//
// The helmet (from HelmetFactory) is added on top of the head; hair pokes
// out from under it at the back.
import * as THREE from 'three';
import { HelmetFactory } from '../HelmetFactory.js';
import { LEG_HIP_Y, addLegs } from './LegBuilder.js';
import { cachedGeometry } from './MeshCache.js';

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
// organically to the shoulders, then narrowing sharply into a NECK so
// the head sphere reads as a head on a neck rather than a bump on the
// torso. Each point is (radius, y). The first and last points sit on the
// axis so the lathe closes its top and bottom caps. A curved profile
// (rather than a linear cone) is what makes the taper read as a body
// rather than a traffic cone.
//
// NECK GEOMETRY — why the top four points narrow:
// The head sphere is fixed at BLOB_HEAD_Y (1.02, radius 0.16) and its
// bottom pole sits at Y=0.86, well inside the shoulder mass. In the
// previous profile the torso was still 0.145–0.14 wide all the way up
// to 1.05, so the head's widest latitude (0.16 at Y=1.02) bulged over
// the torso by only ~0.013 — invisible at any camera distance. The
// soldier read as a blob with a head-shaped bump, which is the "body
// and head merged into one" complaint.
//
// The fix is to taper the torso sharply from the shoulder line (0.155
// at Y=0.83, UNCHANGED — the shoulder silhouette below the neck is
// untouched) down to a neck column (0.11 at Y=0.91, 0.085 at Y=0.98,
// 0.075 at Y=1.05). Numerically, at Y=0.94 the head sphere is 0.139
// wide while the torso is 0.099 — the head emerges through the surface
// with real clearance, and the visible neck band runs from roughly
// Y=0.92 up to the torso top at 1.05. Above that the head continues
// bare to 1.18 and the helmet caps it, exactly as before.
//
// No other constants moved: BLOB_HEAD_Y, HEAD_RADIUS, and HelmetFactory's
// HEAD_Y are unchanged, so every helmet still seats identically and the
// soldier's silhouette height is the same.
const TORSO_PROFILE = [
  // Bottom cap — on the axis, then out to the hip radius.
  new THREE.Vector2(0.00, TORSO_BOTTOM_Y),
  new THREE.Vector2(0.22, TORSO_BOTTOM_Y),
  // Curved taper up the body. Shoulders keep their previous width so the
  // torso silhouette below the neck is unchanged.
  new THREE.Vector2(0.21,  TORSO_BOTTOM_Y + 0.12),
  new THREE.Vector2(0.19,  TORSO_BOTTOM_Y + 0.26),
  new THREE.Vector2(0.17,  TORSO_BOTTOM_Y + 0.42),
  new THREE.Vector2(0.155, TORSO_BOTTOM_Y + 0.58),  // Y = 0.83  shoulder
  new THREE.Vector2(0.14,  TORSO_BOTTOM_Y + 0.62),  // Y = 0.87  shoulder top
  // Neck: sharp inward taper so the head sphere clears the torso.
  new THREE.Vector2(0.11,  TORSO_BOTTOM_Y + 0.66),  // Y = 0.91  neck base
  new THREE.Vector2(0.085, TORSO_BOTTOM_Y + 0.73),  // Y = 0.98  neck
  new THREE.Vector2(0.075, TORSO_TOP_Y),            // Y = 1.05  neck top
  // Top cap.
  new THREE.Vector2(0.00,  TORSO_TOP_Y)
];

// 12 radial segments is enough for a smooth silhouette at battle zoom; the
// lathe auto-computes smooth vertex normals from the profile. 10 lat / 8
// lon for the head matches the original.
const TORSO_RADIAL_SEGMENTS = 12;
const HEAD_LAT_SEGMENTS = 10;
const HEAD_LON_SEGMENTS = 8;

// Skin tones for human faces. Randomized per soldier so a formation shows
// varied faces instead of a uniform mask. Chosen to read as distinct skin
// tones at battle zoom without fragmenting the palette.
const SKIN_TONES = [
  0xf2d2b6, // pale
  0xe4ba94, // light
  0xd2a173, // medium-light
  0xb8845a, // medium
  0x9a6a42, // medium-dark
  0x7a5230, // dark
  0x5a3a20  // very dark
];

// Hair tones. Black and brown only — the game's palette is deliberately
// restrained and blond/red/grey read as fantasy at battle zoom. Any of
// these can combine with any of the skin tones above.
const HAIR_TONES = [
  0x0a0a0a, // black
  0x1a1208, // near-black brown
  0x2a1a10, // dark brown
  0x3a2412, // medium dark brown
  0x5a3a1a, // medium brown
  0x7a5a30  // light brown
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Hair geometry builders. Each returns a SphereGeometry sector centered on
// the head centre (local origin) covering the BACK (-Z) of the head.
// Forward is +Z, matching the weapon orientation convention.
//
// WHY A SPHERE SECTOR
// SphereGeometry with phi range [π, 2π] is exactly the -Z hemisphere: it
// sweeps from +X (φ=π), through -Z (φ=3π/2), to -X (φ=2π). The two flat
// phi-cut edges sit at ±X, so the hair covers the back of the head and
// stops cleanly at the sides — the front of the head (the face) is
// untouched.
//
// NOT PROTRUDING PAST THE HELMET
// HAIR_RADIUS = HEAD_RADIUS + 0.002 sits just outside the head sphere
// (visible) and inside every helmet's rim radius (0.18–0.19 depending on
// style) — so the hair cannot poke through the helmet dome. Theta START
// at exactly π/2 (the equator, which is HEAD_Y — the same plane every
// hemisphere helmet's rim sits on) means the hair's top edge is tucked
// just inside the helmet's bottom edge: for a round-cap-style helmet
// the hair emerges exactly at the rim, for a raised helmet (conical,
// hood) a small band of skin shows between rim and hair, and for a
// deep helmet (banded) the hair emerges just below the lower band.
// In no case can the hair intersect the helmet geometry.
//
// THETA LENGTH sets how far down the back of the head the hair reaches.
// Head bottom is at -HEAD_RADIUS. Short stops above the nape; long
// reaches almost to the base of the skull.
const HAIR_RADIUS = HEAD_RADIUS + 0.002;

function makeHairCap(downThetaLength) {
  return new THREE.SphereGeometry(
    HAIR_RADIUS, 8, 6,
    Math.PI, Math.PI,
    Math.PI / 2, downThetaLength
  );
}

function buildShortHair() {
  return makeHairCap(0.15 * Math.PI);  // θ to 117° — upper back of head
}

function buildMediumHair() {
  return makeHairCap(0.25 * Math.PI);  // θ to 135° — most of the back
}

function buildLongHair() {
  return makeHairCap(0.35 * Math.PI);  // θ to 153° — almost to the nape
}

const HAIR_BUILDERS = [buildShortHair, buildMediumHair, buildLongHair];

export function createBlobBody(color, helmetType) {
  const group = new THREE.Group();
  // Per-instance torso material. SoldierView tints this toward black as
  // HP drops; legs share it (see addLegs below and attachStaticLegs).
  const torsoMat = new THREE.MeshLambertMaterial({ color });

  // Torso.
  const torsoGeo = cachedGeometry('blob.torsoGeo', () =>
    new THREE.LatheGeometry(TORSO_PROFILE, TORSO_RADIAL_SEGMENTS));
  group.add(new THREE.Mesh(torsoGeo, torsoMat));

  // Head — random skin tone per soldier. Geometry is shared; only the
  // material differs. Tinted toward black with the torso via
  // SoldierView._applyBodyTint.
  const skinTone = pickRandom(SKIN_TONES);
  const headGeo = cachedGeometry('blob.headGeo', () =>
    new THREE.SphereGeometry(HEAD_RADIUS, HEAD_LAT_SEGMENTS, HEAD_LON_SEGMENTS));
  const headMat = new THREE.MeshLambertMaterial({ color: skinTone });
  const headMesh = new THREE.Mesh(headGeo, headMat);
  headMesh.position.y = BLOB_HEAD_Y;
  group.add(headMesh);

  // Hair — random style + colour per soldier. Cached geometry per style;
  // per-instance material. Tinted toward black with the torso.
  const hairStyle = Math.floor(Math.random() * HAIR_BUILDERS.length);
  const hairTone = pickRandom(HAIR_TONES);
  const hairGeo = cachedGeometry(
    `blob.hairGeo.${hairStyle}`,
    () => HAIR_BUILDERS[hairStyle]()
  );
  const hairMat = new THREE.MeshLambertMaterial({ color: hairTone });
  const hairMesh = new THREE.Mesh(hairGeo, hairMat);
  hairMesh.position.y = BLOB_HEAD_Y;
  group.add(hairMesh);

  addLegs(group, torsoMat);

  // Helmet is data-driven from UnitType.helmetType (see config/UnitTypes.js).
  // null / unknown helmetType leaves the head sphere bare — the sphere IS
  // the bare-head silhouette, so no separate fallback mesh is needed.
  const helmet = HelmetFactory.createForType(helmetType, color);
  if (helmet) group.add(helmet);

  // Three separate tint templates. SoldierView collects the meshes that
  // use each template and tints them together as HP drops. Blob bodies
  // are the only variant that sets skin/hair; every other body builder
  // leaves those undefined, so SoldierView's null checks skip them.
  group.userData.baseMaterial = torsoMat;
  group.userData.skinMaterial = headMat;
  group.userData.hairMaterial = hairMat;
  return group;
}
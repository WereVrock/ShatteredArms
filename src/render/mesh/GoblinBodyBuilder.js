// ===== src/render/mesh/GoblinBodyBuilder.js =====
// Goblin body: a slender, forward-slouched torso built as TWO separate
// lathes meeting at a waist pivot, an oversized round head thrust forward
// of the shoulders, a long droopy nose, and two long blade-like ears
// angled down and back. Built from primitives with no external assets,
// mirroring BlobBodyBuilder.
//
// POSTURE — why two pieces, not one
// A single lathe tilted around its base reads as a rigid object falling
// over, because the entire mass above the contact point is rotating as one
// unit and the base of support looks like a hinge rather than a stance.
// A slouch is anatomically a bend at the WAIST: the pelvis and belly stay
// over the feet, and only the chest, shoulders, and head fold forward.
//
// So the torso is two lathes:
//   lower torso  — vertical. Covers the pelvis and belly, no rotation.
//   upper torso  — chest and shoulders, parented to a pivot positioned at
//                  the waist line, tilted forward by GOBLIN_SLOUCH_RAD.
//   hunch        — a small squashed sphere on the upper torso's top-back.
//   head         — placed above and forward of the leaned upper torso top.
// The legs stay neutral. The walk cycle drives hip and knee rotations each
// frame (see SoldierView._applyWalkCycle), so any base bend baked into the
// mesh would be overwritten the moment the goblin moves.
//
// MERGE STRATEGY (see MeshMerge.js)
// The two skin meshes (lower torso + head + nose + 2 ears in body space,
// and upper torso + hump inside the slouch pivot) share one per-instance
// material and cannot be collapsed further without baking the pivot's
// transform into the geometry. Both are kept as separate meshes so the
// slouch pivot's rotation is preserved by construction. The rags (belt +
// six fringe strips + two loincloth panels) all merge into a single mesh
// — one draw call for the entire costume.
//
// EARS
// Each ear is a thin flattened cone: a four-segment cone squashed on one
// axis gives a blade-shaped diamond with a point. Both ears angle down and
// back — the direction of the ear axis is supplied as a unit vector and
// the mesh is oriented to it via a quaternion, so "down back" is a single
// tunable direction rather than a set of Euler rotations to reason about.
//
// HELMETS
// Goblins do NOT wear helmets. UnitTypes declares helmetType on the goblin
// variants (inherited from their human counterparts via the goblinOf helper)
// but this builder ignores it — a human-shaped cap sits wrong on a head with
// ears and a long nose, and the naked green head is the entire silhouette
// read. If a future variant wants a goblin-scale cap, add a distinct builder;
// do not reuse HelmetFactory.
//
// Geometries are cached (see MeshCache.js). The body material stays
// per-instance because SoldierView.sync tints it toward black as HP drops.
import * as THREE from 'three';
import { cachedGeometry } from './MeshCache.js';
import { mergeGeometries, partMatrix, poseMatrix } from './MeshMerge.js';
import {
  createRagMaterial,
  createWaistRags,
  createLoincloth
} from './GoblinRags.js';

// --- leg proportions -------------------------------------------------------

const GOBLIN_LEG_HIP_Y       = 0.21;
const GOBLIN_LEG_HIP_SPACING = 0.06;
const GOBLIN_LEG_RADIUS      = 0.022;
const GOBLIN_THIGH_LENGTH    = 0.105;
const GOBLIN_SHIN_LENGTH     = 0.105;

// --- torso geometry --------------------------------------------------------

const GOBLIN_PELVIS_HALF_HEIGHT = 0.04;
const GOBLIN_TORSO_BOTTOM_Y = GOBLIN_LEG_HIP_Y - GOBLIN_PELVIS_HALF_HEIGHT;  // 0.17

// Waist line — where the two lathes meet and where the upper torso's slouch
// pivot sits.
const GOBLIN_WAIST_Y      = 0.40;
const GOBLIN_LOWER_TOP_Y  = 0.42;
const GOBLIN_TORSO_TOP_Y  = 0.66;  // UNTILTED top of the upper torso

// Slouch angle for the UPPER torso only.
const GOBLIN_SLOUCH_RAD = 0.40;

const GOBLIN_UPPER_HEIGHT = GOBLIN_TORSO_TOP_Y - GOBLIN_WAIST_Y;  // 0.26
const GOBLIN_TOP_Y = GOBLIN_WAIST_Y + GOBLIN_UPPER_HEIGHT * Math.cos(GOBLIN_SLOUCH_RAD);
const GOBLIN_TOP_Z = GOBLIN_UPPER_HEIGHT * Math.sin(GOBLIN_SLOUCH_RAD);

// --- head ------------------------------------------------------------------

const GOBLIN_HEAD_RADIUS = 0.13;
const GOBLIN_HEAD_FORWARD_EXTRA = 0.025;
const GOBLIN_HEAD_Y = GOBLIN_TOP_Y + GOBLIN_HEAD_RADIUS * 0.60;
const GOBLIN_HEAD_Z = GOBLIN_TOP_Z + GOBLIN_HEAD_FORWARD_EXTRA;

// --- ears ------------------------------------------------------------------

const GOBLIN_EAR_LENGTH = 0.17;
function goblinEarDirection(side) {
  return new THREE.Vector3(side * 0.30, -0.50, -0.80).normalize();
}

// --- skin tint -------------------------------------------------------------

const GOBLIN_GREEN = 0x6a8a3a;
const GOBLIN_TINT  = 0.55;

// --- rags ------------------------------------------------------------------

const GOBLIN_WAIST_RADIUS = 0.093;

const GOBLIN_LOINCLOTH_LENGTH = 2.4;
const GOBLIN_LOINCLOTH_ARC    = 1.40;
const GOBLIN_LOINCLOTH_FLARE  = 1.50;

// --- lathe profiles --------------------------------------------------------

const GOBLIN_TORSO_RADIAL_SEGMENTS = 10;

const GOBLIN_LOWER_PROFILE = [
  new THREE.Vector2(0.000, GOBLIN_TORSO_BOTTOM_Y),
  new THREE.Vector2(0.100, GOBLIN_TORSO_BOTTOM_Y),
  new THREE.Vector2(0.110, GOBLIN_TORSO_BOTTOM_Y + 0.10),
  new THREE.Vector2(0.100, GOBLIN_TORSO_BOTTOM_Y + 0.18),
  new THREE.Vector2(0.090, GOBLIN_LOWER_TOP_Y),
  new THREE.Vector2(0.000, GOBLIN_LOWER_TOP_Y)
];

const GOBLIN_UPPER_PROFILE = [
  new THREE.Vector2(0.000, 0),
  new THREE.Vector2(0.100, 0),
  new THREE.Vector2(0.092, GOBLIN_UPPER_HEIGHT * 0.25),
  new THREE.Vector2(0.080, GOBLIN_UPPER_HEIGHT * 0.55),
  new THREE.Vector2(0.063, GOBLIN_UPPER_HEIGHT * 0.85),
  new THREE.Vector2(0.050, GOBLIN_UPPER_HEIGHT),
  new THREE.Vector2(0.000, GOBLIN_UPPER_HEIGHT)
];

// Hump sizing on the upper torso — kept as constants so the cached
// geometry factory and the pivot's local frame agree.
const HUMP_RADIUS = 0.055;
const HUMP_LOCAL_Y = GOBLIN_UPPER_HEIGHT - 0.07;
const HUMP_LOCAL_Z = -0.030;

// --- builder ---------------------------------------------------------------

export function createGoblinBody(color) {
  const group = new THREE.Group();

  // Per-instance: SoldierView tints this toward black as HP drops.
  const skinColor = new THREE.Color(color).lerp(new THREE.Color(GOBLIN_GREEN), GOBLIN_TINT);
  const mat = new THREE.MeshLambertMaterial({ color: skinColor });

  // Rags keep the pure team colour — the body is 55% race green, so the
  // cloth is where team identity stays legible on the model.
  const ragMat = createRagMaterial(color);

  // Body-space skin parts: lower torso + head + nose + two ears. They share
  // `mat` and are rigidly attached to the body group, so they merge into a
  // single mesh.
  addBodySkin(group, mat);

  // Waist wrap and loincloth hang off the vertical pelvis. Both are single
  // meshes (their internal parts merged inside GoblinRags).
  group.add(createWaistRags(ragMat, {
    waistY: GOBLIN_WAIST_Y,
    waistRadius: GOBLIN_WAIST_RADIUS,
    cachePrefix: 'goblin'
  }));

  group.add(createLoincloth(ragMat, {
    waistY: GOBLIN_WAIST_Y,
    waistRadius: GOBLIN_WAIST_RADIUS,
    cachePrefix: 'goblin',
    lengthScale: GOBLIN_LOINCLOTH_LENGTH,
    arcRad:      GOBLIN_LOINCLOTH_ARC,
    flare:       GOBLIN_LOINCLOTH_FLARE
  }));

  // Upper torso + hunch inside the slouch pivot. They share `mat` and are
  // rigidly attached inside the pivot, so they merge into a single mesh.
  addUpperTorsoAndHunch(group, mat);

  addGoblinLegs(group, mat);

  group.userData.baseMaterial = mat;
  group.userData.ragMaterial = ragMat;
  return group;
}

// --- lower torso + head + nose + ears (body-space skin mesh) --------------

function addBodySkin(group, mat) {
  const geo = cachedGeometry('goblin.bodySkinGeo', () => {
    const entries = [
      {
        geometry: new THREE.LatheGeometry(GOBLIN_LOWER_PROFILE, GOBLIN_TORSO_RADIAL_SEGMENTS)
      }
    ];

    // Head: sphere, squashed on Y by 0.9. Scale is baked into the geometry
    // (via a scale matrix in the entry) so the position is a plain
    // translation.
    {
      const headGeo = new THREE.SphereGeometry(GOBLIN_HEAD_RADIUS, 10, 8);
      headGeo.scale(1, 0.9, 1);
      entries.push({
        geometry: headGeo,
        matrix: partMatrix(0, GOBLIN_HEAD_Y, GOBLIN_HEAD_Z)
      });
    }

    // Nose: single cone, tip forward-and-down. rotation.x = PI/2 lays the
    // cone along +Z (horizontal, forward); adding 0.45 rad tips the axis
    // below horizontal so the tip drops.
    entries.push({
      geometry: new THREE.ConeGeometry(0.042, 0.20, 6),
      matrix: partMatrix(
        0,
        GOBLIN_HEAD_Y - 0.015,
        GOBLIN_HEAD_Z + GOBLIN_HEAD_RADIUS - 0.02,
        Math.PI / 2 + 0.45, 0, 0
      )
    });

    // Ears: blade-shaped (a four-segment cone squashed on local X to 0.22).
    // Each ear's axis is a unit vector `dir`; the mesh's local +Y is
    // rotated to it via a quaternion, then the whole thing is translated
    // to `base + dir * (L/2)`.
    const up = new THREE.Vector3(0, 1, 0);
    for (const side of [-1, 1]) {
      const dir = goblinEarDirection(side);
      const base = new THREE.Vector3(
        side * (GOBLIN_HEAD_RADIUS - 0.030),
        GOBLIN_HEAD_Y + 0.020,
        GOBLIN_HEAD_Z - 0.010
      );

      const position = base.clone().addScaledVector(dir, GOBLIN_EAR_LENGTH / 2);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(up, dir);
      const scale = new THREE.Vector3(0.22, 1, 1);

      entries.push({
        geometry: new THREE.ConeGeometry(0.035, GOBLIN_EAR_LENGTH, 4),
        matrix: poseMatrix(position, quaternion, scale)
      });
    }

    return mergeGeometries(entries);
  });

  group.add(new THREE.Mesh(geo, mat));
}

// --- upper torso + hunch (slouch-pivot-local skin mesh) -------------------

// Upper torso and hunch live inside a pivot group positioned at the waist
// and rotated forward by GOBLIN_SLOUCH_RAD. They share `mat` and are
// rigidly attached inside the pivot, so they merge into a single mesh in
// the pivot's local frame.
function addUpperTorsoAndHunch(group, mat) {
  const pivot = new THREE.Group();
  pivot.position.set(0, GOBLIN_WAIST_Y, 0);
  pivot.rotation.x = GOBLIN_SLOUCH_RAD;

  const geo = cachedGeometry('goblin.upperSkinGeo', () => {
    // Hump is a squashed sphere; the squash is baked into the geometry so
    // the entry is a plain translation.
    const humpGeo = new THREE.SphereGeometry(HUMP_RADIUS, 8, 6);
    humpGeo.scale(1.20, 0.85, 0.95);

    return mergeGeometries([
      {
        geometry: new THREE.LatheGeometry(GOBLIN_UPPER_PROFILE, GOBLIN_TORSO_RADIAL_SEGMENTS)
      },
      {
        geometry: humpGeo,
        matrix: partMatrix(0, HUMP_LOCAL_Y, HUMP_LOCAL_Z)
      }
    ]);
  });
  pivot.add(new THREE.Mesh(geo, mat));

  group.add(pivot);
}

// --- legs ------------------------------------------------------------------

// Two-piece leg matching LegBuilder's userData contract (hip pivot + knee
// pivot under fixed keys) but with goblin proportions. Same pivot-driven
// walk cycle as the human blob.
function addGoblinLegs(group, mat) {
  const thighGeo = cachedGeometry('goblin.thighGeo', () =>
    new THREE.CylinderGeometry(GOBLIN_LEG_RADIUS, GOBLIN_LEG_RADIUS, GOBLIN_THIGH_LENGTH, 5));
  const shinGeo = cachedGeometry('goblin.shinGeo', () =>
    new THREE.CylinderGeometry(GOBLIN_LEG_RADIUS, GOBLIN_LEG_RADIUS, GOBLIN_SHIN_LENGTH, 5));

  const left = buildGoblinLeg(mat, thighGeo, shinGeo, -GOBLIN_LEG_HIP_SPACING);
  group.add(left.hip);

  const right = buildGoblinLeg(mat, thighGeo, shinGeo, GOBLIN_LEG_HIP_SPACING);
  group.add(right.hip);

  group.userData.legLeftPivot  = left.hip;
  group.userData.legRightPivot = right.hip;
  group.userData.legLeftKnee   = left.knee;
  group.userData.legRightKnee  = right.knee;
}

function buildGoblinLeg(mat, thighGeo, shinGeo, x) {
  const hip = new THREE.Group();
  hip.position.set(x, GOBLIN_LEG_HIP_Y, 0);

  const thigh = new THREE.Mesh(thighGeo, mat);
  thigh.position.y = -GOBLIN_THIGH_LENGTH / 2;
  thigh.userData.noShadow = true;
  hip.add(thigh);

  const knee = new THREE.Group();
  knee.position.y = -GOBLIN_THIGH_LENGTH;
  hip.add(knee);

  const shin = new THREE.Mesh(shinGeo, mat);
  shin.position.y = -GOBLIN_SHIN_LENGTH / 2;
  shin.userData.noShadow = true;
  knee.add(shin);

  return { hip, knee };
}
// ===== src/render/mesh/GoblinSlaveBodyBuilder.js =====
// Goblin slave: the common goblin frame stripped down to the marks of
// captivity — a heavy iron collar and a single loincloth. No waist wrap,
// no fringe, no helmet, no issued gear beyond the club in hand.
//
// WHY A DEDICATED BUILDER, NOT A FLAG ON GoblinBodyBuilder
// The silhouette difference IS the missing waist wrap and the collar.
// Reusing GoblinBodyBuilder and hide-toggling pieces would leave the
// collar bolted on from outside and every future goblin change silently
// propagating to the slave; a dedicated builder isolates the two so
// either can evolve without disturbing the other. Cache prefixes are
// therefore separate ('goblinSlave.*' rather than 'goblin.*') even
// where the underlying geometry shape is identical.
//
// STRUCTURE (same as GoblinBodyBuilder, minus the waist wrap, plus the
// collar):
//   body-space skin : lower torso + head + nose + 2 ears (merged)
//   upper-torso skin: inside the slouch pivot, merged with the hunch
//   loincloth       : GoblinRags.createLoincloth, shorter scale
//   collar          : dark iron band around the neck (separate mesh)
//   legs            : two-piece pivot rig, same contract as the goblin
//                     builder so SoldierView's walk cycle drives them
//                     without any slave-specific branch.
//
// The collar sits below the head sphere (head bottom lands at ~0.587
// in body space) and outside the upper torso's cross-section at that
// height, so it reads as a band at the base of the neck.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix, poseMatrix } from './MeshMerge.js';
import {
  createRagMaterial,
  createLoincloth
} from './GoblinRags.js';

// --- leg proportions -------------------------------------------------------
// Identical to GoblinBodyBuilder's. A slave is a common goblin, not a
// different species.

const GOBLIN_LEG_HIP_Y       = 0.21;
const GOBLIN_LEG_HIP_SPACING = 0.06;
const GOBLIN_LEG_RADIUS      = 0.022;
const GOBLIN_THIGH_LENGTH    = 0.105;
const GOBLIN_SHIN_LENGTH     = 0.105;

// --- torso geometry --------------------------------------------------------

const GOBLIN_PELVIS_HALF_HEIGHT = 0.04;
const GOBLIN_TORSO_BOTTOM_Y = GOBLIN_LEG_HIP_Y - GOBLIN_PELVIS_HALF_HEIGHT;

const GOBLIN_WAIST_Y      = 0.40;
const GOBLIN_LOWER_TOP_Y  = 0.42;
const GOBLIN_TORSO_TOP_Y  = 0.66;
const GOBLIN_SLOUCH_RAD   = 0.40;
const GOBLIN_UPPER_HEIGHT = GOBLIN_TORSO_TOP_Y - GOBLIN_WAIST_Y;
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

// Shorter than the standard goblin's 2.4/1.40/1.50 — reads as bare
// necessity, not as a crafted skirt.
const SLAVE_LOINCLOTH_LENGTH = 1.9;
const SLAVE_LOINCLOTH_ARC    = 1.30;
const SLAVE_LOINCLOTH_FLARE  = 1.35;

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

const HUMP_RADIUS = 0.055;
const HUMP_LOCAL_Y = GOBLIN_UPPER_HEIGHT - 0.07;
const HUMP_LOCAL_Z = -0.030;

// --- collar ---------------------------------------------------------------
// Heavy iron band at the base of the neck. Radius is wide enough to
// clear the upper torso's cross-section at that height (~0.069 in body
// space) and narrow enough to read as a neck band rather than a bowl.
// Y chosen just below the head sphere's bottom (0.7175 - 0.13 ≈ 0.5875),
// so the collar sits BELOW the jaw and does not bite into the head.

const SLAVE_COLLAR_COLOR         = 0x2c2c30;
// Positioned in the SLOUCH PIVOT's local frame (origin at GOBLIN_WAIST_Y,
// rotated by GOBLIN_SLOUCH_RAD around X), not in body space. Local y =
// 0.19 lands at body-space y ≈ 0.575, z ≈ 0.074 — around the base of the
// neck, just below the head sphere. The previous constant placed the
// collar in BODY space at z = 0, which left it behind the neck in empty
// air: the slouched upper torso carries the neck forward of z = 0.
const SLAVE_COLLAR_LOCAL_Y       = 0.19;
// Tightened from 0.090 to sit snug around the neck cross-section
// (upper-torso profile radius ≈ 0.070 at this height) rather than float
// as a detached hoop.
const SLAVE_COLLAR_RADIUS_OUTER  = 0.078;
const SLAVE_COLLAR_HEIGHT        = 0.045;

// --- builder ---------------------------------------------------------------

export function createGoblinSlaveBody(color) {
  const group = new THREE.Group();

  const skinColor = new THREE.Color(color).lerp(
    new THREE.Color(GOBLIN_GREEN), GOBLIN_TINT
  );
  const mat = new THREE.MeshLambertMaterial({ color: skinColor });
  const ragMat = createRagMaterial(color);

  addBodySkin(group, mat);

  // Only the loincloth. Waist wraps (belt + fringe) are exactly the
  // "issued gear" a slave has been stripped of — the cloth that remains
  // is what could not be taken away.
  group.add(createLoincloth(ragMat, {
    waistY: GOBLIN_WAIST_Y,
    waistRadius: GOBLIN_WAIST_RADIUS,
    cachePrefix: 'goblinSlave',
    lengthScale: SLAVE_LOINCLOTH_LENGTH,
    arcRad:      SLAVE_LOINCLOTH_ARC,
    flare:       SLAVE_LOINCLOTH_FLARE
  }));

  group.add(createSlaveCollar(color));

  addUpperTorsoAndHunch(group, mat);
  addGoblinLegs(group, mat);

  group.userData.baseMaterial = mat;
  group.userData.ragMaterial = ragMat;
  return group;
}

// --- lower torso + head + nose + ears (body-space skin mesh) --------------

function addBodySkin(group, mat) {
  const geo = cachedGeometry('goblinSlave.bodySkinGeo', () => {
    const entries = [
      {
        geometry: new THREE.LatheGeometry(GOBLIN_LOWER_PROFILE, GOBLIN_TORSO_RADIAL_SEGMENTS)
      }
    ];

    {
      const headGeo = new THREE.SphereGeometry(GOBLIN_HEAD_RADIUS, 10, 8);
      headGeo.scale(1, 0.9, 1);
      entries.push({
        geometry: headGeo,
        matrix: partMatrix(0, GOBLIN_HEAD_Y, GOBLIN_HEAD_Z)
      });
    }

    entries.push({
      geometry: new THREE.ConeGeometry(0.042, 0.20, 6),
      matrix: partMatrix(
        0,
        GOBLIN_HEAD_Y - 0.015,
        GOBLIN_HEAD_Z + GOBLIN_HEAD_RADIUS - 0.02,
        Math.PI / 2 + 0.45, 0, 0
      )
    });

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

function addUpperTorsoAndHunch(group, mat) {
  const pivot = new THREE.Group();
  pivot.position.set(0, GOBLIN_WAIST_Y, 0);
  pivot.rotation.x = GOBLIN_SLOUCH_RAD;

  const geo = cachedGeometry('goblinSlave.upperSkinGeo', () => {
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

// --- collar (body-space metal mesh) ---------------------------------------

function createSlaveCollar(color) {
  const geo = cachedGeometry('goblinSlave.collarGeo', () =>
    new THREE.CylinderGeometry(
      SLAVE_COLLAR_RADIUS_OUTER,
      SLAVE_COLLAR_RADIUS_OUTER,
      SLAVE_COLLAR_HEIGHT,
      10, 1, true
    ));
  // Team-tinted metal. The raw team colour is blended 30% toward the
  // iron base so the band still reads as beaten metal rather than a
  // pasted-on colour swatch — 70% team / 30% iron sits at the point
  // where "whose collar is this" is instant but the material does not
  // look plastic. Cached per team colour: only two teams in play, so at
  // most two shared materials regardless of unit count. The cache key
  // embeds `color` so each team gets its own material instead of the
  // first team's colour being locked in for everyone.
  const mat = cachedMaterial(`goblinSlave.collarMat.${color}`, () => {
    const collarColor = new THREE.Color(color).lerp(
      new THREE.Color(SLAVE_COLLAR_COLOR), 0.3
    );
    return new THREE.MeshLambertMaterial({
      color: collarColor,
      side: THREE.DoubleSide
    });
  });
  const mesh = new THREE.Mesh(geo, mat);

  // Mount the collar in a pivot that reproduces the upper torso's slouch,
  // so the band both POSITIONS and TILTS with the neck. The upper torso
  // (which the neck is part of) is rotated by GOBLIN_SLOUCH_RAD around
  // the waist, which pushes the neck forward of body-space z = 0. A
  // body-space horizontal cylinder at z = 0 (the old setup) put the back
  // of the band in empty air and the front of the band against the
  // neck's front instead of wrapping it. Placing the collar inside a
  // matching pivot makes the band follow the neck axis, hugging the
  // taper instead of floating.
  const pivot = new THREE.Group();
  pivot.position.set(0, GOBLIN_WAIST_Y, 0);
  pivot.rotation.x = GOBLIN_SLOUCH_RAD;
  mesh.position.y = SLAVE_COLLAR_LOCAL_Y;
  pivot.add(mesh);
  return pivot;
}

// --- legs ------------------------------------------------------------------

function addGoblinLegs(group, mat) {
  const thighGeo = cachedGeometry('goblinSlave.thighGeo', () =>
    new THREE.CylinderGeometry(GOBLIN_LEG_RADIUS, GOBLIN_LEG_RADIUS, GOBLIN_THIGH_LENGTH, 5));
  const shinGeo = cachedGeometry('goblinSlave.shinGeo', () =>
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
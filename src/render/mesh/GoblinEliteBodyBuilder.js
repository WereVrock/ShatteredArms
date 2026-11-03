// ===== src/render/mesh/GoblinEliteBodyBuilder.js =====
// Elite goblin body: same goblin proportions, posture, and race
// silhouette as GoblinBodyBuilder, but cleaner-kept and marked with team
// livery. Three differences carry the "elite" read at battle zoom:
//
//   1. FEWER RAG TATTERS. The common goblin's waist wrap carries six
//      hanging strips; the elite keeps three (front + both flanks).
//
//   2. FRONT-TO-BACK CREST. A team-coloured half-torus band runs from
//      the forehead over the crown to the nape — a crest, not a
//      horizontal ring. (An earlier horizontal band floated around the
//      head like a halo; the crest hugs the skull.)
//
//   3. TEAM-COLOURED T-SHIRT. A torso-covering tunic in the owner's
//      team colour, following the body's hunch. (Replaces earlier
//      armband rings that read as belly halos.)
//
// Everything else — proportions, slouch, ears, nose, lathe profiles,
// leg dimensions — is inherited from GoblinBodyBuilder.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix, poseMatrix } from './MeshMerge.js';
import {
  createRagMaterial,
  createWaistRags,
  createLoincloth
} from './GoblinRags.js';

const GOBLIN_LEG_HIP_Y       = 0.21;
const GOBLIN_LEG_HIP_SPACING = 0.06;
const GOBLIN_LEG_RADIUS      = 0.022;
const GOBLIN_THIGH_LENGTH    = 0.105;
const GOBLIN_SHIN_LENGTH     = 0.105;

const GOBLIN_PELVIS_HALF_HEIGHT = 0.04;
const GOBLIN_TORSO_BOTTOM_Y = GOBLIN_LEG_HIP_Y - GOBLIN_PELVIS_HALF_HEIGHT;

const GOBLIN_WAIST_Y      = 0.40;
const GOBLIN_LOWER_TOP_Y  = 0.42;
const GOBLIN_TORSO_TOP_Y  = 0.66;

const GOBLIN_SLOUCH_RAD = 0.40;

const GOBLIN_UPPER_HEIGHT = GOBLIN_TORSO_TOP_Y - GOBLIN_WAIST_Y;
const GOBLIN_TOP_Y = GOBLIN_WAIST_Y + GOBLIN_UPPER_HEIGHT * Math.cos(GOBLIN_SLOUCH_RAD);
const GOBLIN_TOP_Z = GOBLIN_UPPER_HEIGHT * Math.sin(GOBLIN_SLOUCH_RAD);

const GOBLIN_HEAD_RADIUS = 0.13;
const GOBLIN_HEAD_FORWARD_EXTRA = 0.025;
const GOBLIN_HEAD_Y = GOBLIN_TOP_Y + GOBLIN_HEAD_RADIUS * 0.60;
const GOBLIN_HEAD_Z = GOBLIN_TOP_Z + GOBLIN_HEAD_FORWARD_EXTRA;

const GOBLIN_EAR_LENGTH = 0.17;
function goblinEarDirection(side) {
  return new THREE.Vector3(side * 0.30, -0.50, -0.80).normalize();
}

const GOBLIN_GREEN = 0x6a8a3a;
const GOBLIN_TINT  = 0.55;

const GOBLIN_WAIST_RADIUS = 0.093;

const GOBLIN_LOINCLOTH_LENGTH = 2.2;
const GOBLIN_LOINCLOTH_ARC    = 1.40;
const GOBLIN_LOINCLOTH_FLARE  = 1.50;

// Three even-spaced strips — front and both flanks — all the same length.
// The common goblin's six-strip fringe is deliberately uneven; the
// elite's three are uniform.
const ELITE_TATTERS = [
  { angle:  0.00, length: 1.55 },
  { angle:  1.62, length: 1.55 },
  { angle: -1.62, length: 1.55 }
];

// Crest: a flat team-coloured band running front-to-back over the crown,
// hugging the squashed head. Replaces the old half-torus, which read as
// a 3D tube rather than a painted stripe. The band tapers to a point at
// forehead and nape so its ends stay on the skull instead of poking out
// sideways.
const CREST_HALF_WIDTH = 0.015;   // max half-width of the stripe
const CREST_LIFT       = 0.002;   // outward offset to avoid z-fighting
const CREST_SEGMENTS   = 16;

// T-shirt: team-coloured torso cover running from just below the waist
// up to the base of the neck. Radii are ~0.01 larger than the upper
// torso lathe so the garment drapes just outside the skin. Local Y=0 is
// the waist (pivot origin); negative Y extends down over the waistline.
const GOBLIN_TSHIRT_PROFILE = [
  new THREE.Vector2(0.000, -0.03),
  new THREE.Vector2(0.108, -0.03),
  new THREE.Vector2(0.112, -0.02),
  new THREE.Vector2(0.112,  0.02),
  new THREE.Vector2(0.108,  0.06),
  new THREE.Vector2(0.100,  0.10),
  new THREE.Vector2(0.090,  0.15),
  new THREE.Vector2(0.086,  0.19),
  new THREE.Vector2(0.080,  0.22),
  new THREE.Vector2(0.000,  0.22)
];

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

export function createGoblinEliteBody(color) {
  const group = new THREE.Group();

  const skinColor = new THREE.Color(color).lerp(new THREE.Color(GOBLIN_GREEN), GOBLIN_TINT);
  const mat = new THREE.MeshLambertMaterial({ color: skinColor });

  const ragMat = createRagMaterial(color);
  const liveryMat = cachedMaterial(`goblinElite.liveryMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));

  addBodySkin(group, mat);
  group.add(createWaistRags(ragMat, {
    waistY: GOBLIN_WAIST_Y,
    waistRadius: GOBLIN_WAIST_RADIUS,
    cachePrefix: 'goblinElite',
    tatters: ELITE_TATTERS
  }));
  group.add(createLoincloth(ragMat, {
    waistY: GOBLIN_WAIST_Y,
    waistRadius: GOBLIN_WAIST_RADIUS,
    cachePrefix: 'goblinElite',
    lengthScale: GOBLIN_LOINCLOTH_LENGTH,
    arcRad:      GOBLIN_LOINCLOTH_ARC,
    flare:       GOBLIN_LOINCLOTH_FLARE
  }));
  const upperPivot = addUpperTorsoAndHunch(group, mat);
  addTShirt(upperPivot, liveryMat);
  addLivery(group, liveryMat);
  addGoblinLegs(group, mat);

  group.userData.baseMaterial = mat;
  group.userData.ragMaterial = ragMat;
  group.userData.liveryMaterial = liveryMat;
  return group;
}

function addBodySkin(group, mat) {
  const geo = cachedGeometry('goblinElite.bodySkinGeo', () => {
    const entries = [
      { geometry: new THREE.LatheGeometry(GOBLIN_LOWER_PROFILE, GOBLIN_TORSO_RADIAL_SEGMENTS) }
    ];

    const headGeo = new THREE.SphereGeometry(GOBLIN_HEAD_RADIUS, 10, 8);
    headGeo.scale(1, 0.9, 1);
    entries.push({
      geometry: headGeo,
      matrix: partMatrix(0, GOBLIN_HEAD_Y, GOBLIN_HEAD_Z)
    });

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

function addUpperTorsoAndHunch(group, mat) {
  const pivot = new THREE.Group();
  pivot.position.set(0, GOBLIN_WAIST_Y, 0);
  pivot.rotation.x = GOBLIN_SLOUCH_RAD;

  const geo = cachedGeometry('goblinElite.upperSkinGeo', () => {
    const humpGeo = new THREE.SphereGeometry(HUMP_RADIUS, 8, 6);
    humpGeo.scale(1.20, 0.85, 0.95);
    return mergeGeometries([
      { geometry: new THREE.LatheGeometry(GOBLIN_UPPER_PROFILE, GOBLIN_TORSO_RADIAL_SEGMENTS) },
      { geometry: humpGeo, matrix: partMatrix(0, HUMP_LOCAL_Y, HUMP_LOCAL_Z) }
    ]);
  });
  pivot.add(new THREE.Mesh(geo, mat));
  group.add(pivot);
  return pivot;
}

// Team-coloured t-shirt. A lathe shell outside the upper torso, added to
// the same pivot so the garment follows the body's hunch. Covers the
// region the removed armbands occupied.
function addTShirt(pivot, liveryMat) {
  const geo = cachedGeometry('goblinElite.tshirtGeo', () =>
    new THREE.LatheGeometry(GOBLIN_TSHIRT_PROFILE, GOBLIN_TORSO_RADIAL_SEGMENTS));
  pivot.add(new THREE.Mesh(geo, liveryMat));
}

// Team-colour livery: front-to-back head crest only. The earlier
// armbands have been replaced by the t-shirt (see addTShirt).
//
// The crest is a flat ribbon that hugs the head's ellipsoid surface,
// sampled along the YZ meridian from forehead to nape. Width tapers to
// a point at both ends so the crest meets the skull instead of poking
// sideways into the air (the failure mode of a constant-width strip on
// a curved surface). Normals are taken from the ellipsoid gradient so
// the shading matches the head underneath.
function addLivery(group, liveryMat) {
  const geo = cachedGeometry('goblinElite.crestRibbonGeo', buildCrestRibbonGeometry);
  group.add(new THREE.Mesh(geo, liveryMat));
}

function buildCrestRibbonGeometry() {
  const R  = GOBLIN_HEAD_RADIUS;
  const RY = R * 0.9;
  const positions = [];
  const normals = [];
  const indices = [];

  for (let i = 0; i <= CREST_SEGMENTS; i++) {
    const theta = (i / CREST_SEGMENTS) * Math.PI;

    // Full width across the crown, tapering to a point at forehead
    // (θ=0) and nape (θ=π). The 3× multiplier keeps the wide section
    // broad and confines the taper to the very ends.
    const taper = Math.min(1, Math.sin(theta) * 3);
    const halfW = CREST_HALF_WIDTH * Math.max(0.001, taper);

    const yLocal = RY * Math.sin(theta);
    const zLocal = R * Math.cos(theta);

    // Ellipsoid outward normal at this meridian point.
    const n = new THREE.Vector3(
      0, yLocal / (RY * RY), zLocal / (R * R)
    ).normalize();

    // Lift slightly along the normal so the ribbon renders in front of
    // the head skin instead of z-fighting with it.
    const cx = n.x * CREST_LIFT;
    const cy = GOBLIN_HEAD_Y + yLocal + n.y * CREST_LIFT;
    const cz = GOBLIN_HEAD_Z + zLocal + n.z * CREST_LIFT;

    positions.push(cx - halfW, cy, cz, cx + halfW, cy, cz);
    normals.push(n.x, n.y, n.z, n.x, n.y, n.z);

    if (i < CREST_SEGMENTS) {
      const b = i * 2;
      indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

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
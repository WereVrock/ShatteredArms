// ===== src/render/mesh/MediumModels.js =====
// LOD tier 2 — "medium". Sits between the fully-detailed tier (tier 1,
// the individual *Builder.js files) and the existing low-poly set (tier 3,
// SimpleModels.js).
//
// DESIGN
// Medium keeps the STRUCTURE of the detailed tier — the same parts, in the
// same places, at the same pivots — but halves the segment counts on every
// curved primitive and drops the smallest detail meshes. It is a
// "decimation" tier, not a "replacement" tier. That means:
//
//   - Every animation hook the detailed tier exposes still works:
//     legLeftPivot / legRightPivot for the walk cycle, weaponArm for the
//     sword slash and bow aim, topLimbPivot / bottomLimbPivot /
//     topString / bottomString / nockedArrow on the bow.
//   - The body material is still per-instance (SoldierView tints it toward
//     black as HP drops), and the shield material is still per-instance
//     (shieldHp tint).
//   - All merged geometry and shared materials go through MeshCache, so
//     medium meshes cost the same GPU-resource budget as detailed meshes
//     of the same shape.
//
// The one structural simplification: LEGS ARE SINGLE-PIECE. Detailed legs
// are a hip-pivot + nested knee-pivot pair; medium legs are one cylinder on
// a single hip pivot. SoldierView._applyWalkCycle already null-checks
// _legLeftKnee / _legRightKnee and simply skips the knee bend, so a
// medium soldier walks with a stiff-legged stride that is correct at the
// distance medium is designed for.
//
// HORSE LEGS keep their four pivots — a trotting mount is legible further
// out than a marching man's knee, so the extra two pivots are worth it.
//
// USAGE — no wiring in this file. It exports the same surface as the
// detailed builders so a later LOD router can pick between them without
// special-casing any unit type.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';
import { HelmetFactory } from '../HelmetFactory.js';
import {
  createRagMaterial,
  createWaistRags,
  createLoincloth
} from './GoblinRags.js';

// ---------------------------------------------------------------------------
// shared leg helper — single-piece, one hip pivot per leg
// ---------------------------------------------------------------------------

// One cylinder per leg, hip pivot at the top. No knee group. userData
// exposes null knees so SoldierView._applyWalkCycle skips the bend.
function addMediumLegs(group, mat, { hipY, hipSpacing, radius, length }) {
  const legGeo = cachedGeometry(
    `medium.legGeo.${length}.${radius}`,
    () => new THREE.CylinderGeometry(radius, radius, length, 4)
  );

  const left = buildMediumLeg(mat, legGeo, -hipSpacing, hipY, length);
  group.add(left.hip);

  const right = buildMediumLeg(mat, legGeo, hipSpacing, hipY, length);
  group.add(right.hip);

  group.userData.legLeftPivot = left.hip;
  group.userData.legRightPivot = right.hip;
  group.userData.legLeftKnee = null;
  group.userData.legRightKnee = null;
}

function buildMediumLeg(mat, geo, x, hipY, length) {
  const hip = new THREE.Group();
  hip.position.set(x, hipY, 0);

  const leg = new THREE.Mesh(geo, mat);
  leg.position.y = -length / 2;
  hip.add(leg);

  return { hip };
}

// ---------------------------------------------------------------------------
// blob body
// ---------------------------------------------------------------------------

// Torso profile — same shape as BlobBodyBuilder's, kept here as a literal so
// this file has no import of the detailed builder's private constants. If
// the detailed torso is ever retuned, mirror the change here.
const MEDIUM_TORSO_BOTTOM_Y = 0.25;
const MEDIUM_TORSO_TOP_Y = 1.05;
const MEDIUM_BLOB_HEAD_Y = MEDIUM_TORSO_TOP_Y - 0.03;
const MEDIUM_TORSO_PROFILE = [
  new THREE.Vector2(0.00, MEDIUM_TORSO_BOTTOM_Y),
  new THREE.Vector2(0.22, MEDIUM_TORSO_BOTTOM_Y),
  new THREE.Vector2(0.21, MEDIUM_TORSO_BOTTOM_Y + 0.12),
  new THREE.Vector2(0.19, MEDIUM_TORSO_BOTTOM_Y + 0.26),
  new THREE.Vector2(0.17, MEDIUM_TORSO_BOTTOM_Y + 0.42),
  new THREE.Vector2(0.155, MEDIUM_TORSO_BOTTOM_Y + 0.58),
  new THREE.Vector2(0.145, MEDIUM_TORSO_BOTTOM_Y + 0.72),
  new THREE.Vector2(0.14, MEDIUM_TORSO_TOP_Y),
  new THREE.Vector2(0.00, MEDIUM_TORSO_TOP_Y)
];

export function createMediumBlobBody(color, helmetType) {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color });

  const bodyGeo = cachedGeometry('medium.blobBodyGeo', () =>
    mergeGeometries([
      { geometry: new THREE.LatheGeometry(MEDIUM_TORSO_PROFILE, 6) },
      {
        geometry: new THREE.SphereGeometry(0.16, 6, 5),
        matrix: partMatrix(0, MEDIUM_BLOB_HEAD_Y, 0)
      }
    ]));
  group.add(new THREE.Mesh(bodyGeo, mat));

  addMediumLegs(group, mat, {
    hipY: 0.30, hipSpacing: 0.08, radius: 0.035, length: 0.30
  });

  // Helmet: detailed-tier helmet factory (helmets are already only 1-2
  // low-poly primitives — nothing worth shrinking).
  const helmet = HelmetFactory.createForType(helmetType, color);
  if (helmet) group.add(helmet);

  group.userData.baseMaterial = mat;
  return group;
}

// ---------------------------------------------------------------------------
// skeleton body
// ---------------------------------------------------------------------------

export function createMediumSkeletonBody(color, teamColor) {
  const group = new THREE.Group();

  const boneColor = new THREE.Color(color).lerp(new THREE.Color(0xe8e0c8), 0.55);
  const mat = new THREE.MeshLambertMaterial({ color: boneColor });

  // Rib count drops from 5 to 3 — the ribcage read is preserved, the
  // per-rib cost is not. Segment counts on the skull sphere and the spine
  // cylinder are halved. All parts merge into one bone mesh.
  const boneGeo = cachedGeometry('medium.skeletonBoneGeo', () => {
    const entries = [
      {
        geometry: new THREE.BoxGeometry(0.22, 0.1, 0.14),
        matrix: partMatrix(0, 0.30, 0)
      },
      {
        geometry: new THREE.CylinderGeometry(0.03, 0.03, 0.36, 4),
        matrix: partMatrix(0, 0.51, 0)
      }
    ];
    const ribWidths = [0.27, 0.28, 0.24];
    for (let i = 0; i < ribWidths.length; i++) {
      entries.push({
        geometry: new THREE.BoxGeometry(ribWidths[i], 0.028, 0.16),
        matrix: partMatrix(0, 0.58 + i * 0.085, 0)
      });
    }
    entries.push({
      geometry: new THREE.SphereGeometry(0.15, 6, 5),
      matrix: partMatrix(0, 1.03, 0)
    });
    entries.push({
      geometry: new THREE.BoxGeometry(0.11, 0.05, 0.10),
      matrix: partMatrix(0, 0.93, 0.08)
    });
    return mergeGeometries(entries);
  });
  group.add(new THREE.Mesh(boneGeo, mat));

  const socketMat = cachedMaterial('medium.skeletonSocketMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x1a1408 }));
  const socketGeo = cachedGeometry('medium.skeletonSocketsGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.SphereGeometry(0.028, 4, 4),
        matrix: partMatrix(-0.05, 1.04, 0.125)
      },
      {
        geometry: new THREE.SphereGeometry(0.028, 4, 4),
        matrix: partMatrix(0.05, 1.04, 0.125)
      }
    ]));
  group.add(new THREE.Mesh(socketGeo, socketMat));

  addMediumLegs(group, mat, {
    hipY: 0.30, hipSpacing: 0.08, radius: 0.035, length: 0.30
  });

  const sashGeo = cachedGeometry('medium.skeletonSashGeo', () =>
    new THREE.BoxGeometry(0.08, 0.42, 0.19));
  const sashMat = cachedMaterial(`medium.skeletonSashMat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({ color: teamColor }));
  const sash = new THREE.Mesh(sashGeo, sashMat);
  sash.position.y = 0.72;
  sash.rotation.z = Math.PI / 5;
  group.add(sash);

  group.userData.baseMaterial = mat;
  return group;
}

// ---------------------------------------------------------------------------
// goblin body
// ---------------------------------------------------------------------------

// Same slouch structure as GoblinBodyBuilder (vertical pelvis + tilted
// chest), half the segments on each lathe, ears and hunch dropped. The
// rags are reused straight from GoblinRags — they are already single-mesh
// per piece and their tatter table is proportion-tuned, so shrinking it
// would flatten the silhouette for no real cost saving.
const GOBLIN_WAIST_Y = 0.40;
const GOBLIN_LOWER_TOP_Y = 0.42;
const GOBLIN_TORSO_BOTTOM_Y = 0.17;
const GOBLIN_TORSO_TOP_Y = 0.66;
const GOBLIN_SLOUCH_RAD = 0.40;
const GOBLIN_UPPER_HEIGHT = GOBLIN_TORSO_TOP_Y - GOBLIN_WAIST_Y;
const GOBLIN_TOP_Y = GOBLIN_WAIST_Y + GOBLIN_UPPER_HEIGHT * Math.cos(GOBLIN_SLOUCH_RAD);
const GOBLIN_TOP_Z = GOBLIN_UPPER_HEIGHT * Math.sin(GOBLIN_SLOUCH_RAD);
const GOBLIN_HEAD_RADIUS = 0.13;
const GOBLIN_HEAD_Y = GOBLIN_TOP_Y + GOBLIN_HEAD_RADIUS * 0.60;
const GOBLIN_HEAD_Z = GOBLIN_TOP_Z + 0.025;

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

export function createMediumGoblinBody(color) {
  const group = new THREE.Group();

  const skinColor = new THREE.Color(color).lerp(new THREE.Color(0x6a8a3a), 0.55);
  const mat = new THREE.MeshLambertMaterial({ color: skinColor });
  const ragMat = createRagMaterial(color);

  // Lower torso + head + nose (no ears). Head sphere scaled to 0.9 on Y via
  // the geometry before the merge so the shape matches the detailed goblin
  // head.
  const bodyGeo = cachedGeometry('medium.goblinBodyGeo', () => {
    const headGeo = new THREE.SphereGeometry(GOBLIN_HEAD_RADIUS, 7, 6);
    headGeo.scale(1, 0.9, 1);

    return mergeGeometries([
      { geometry: new THREE.LatheGeometry(GOBLIN_LOWER_PROFILE, 6) },
      {
        geometry: headGeo,
        matrix: partMatrix(0, GOBLIN_HEAD_Y, GOBLIN_HEAD_Z)
      },
      {
        geometry: new THREE.ConeGeometry(0.042, 0.20, 5),
        matrix: partMatrix(
          0,
          GOBLIN_HEAD_Y - 0.015,
          GOBLIN_HEAD_Z + GOBLIN_HEAD_RADIUS - 0.02,
          Math.PI / 2 + 0.45, 0, 0
        )
      }
    ]);
  });
  group.add(new THREE.Mesh(bodyGeo, mat));

  // Upper torso inside the slouch pivot. No hunch at medium.
  const pivot = new THREE.Group();
  pivot.position.set(0, GOBLIN_WAIST_Y, 0);
  pivot.rotation.x = GOBLIN_SLOUCH_RAD;
  const upperGeo = cachedGeometry('medium.goblinUpperGeo', () =>
    new THREE.LatheGeometry(GOBLIN_UPPER_PROFILE, 6));
  pivot.add(new THREE.Mesh(upperGeo, mat));
  group.add(pivot);

  group.add(createWaistRags(ragMat, {
    waistY: GOBLIN_WAIST_Y,
    waistRadius: 0.093,
    cachePrefix: 'goblin'
  }));
  group.add(createLoincloth(ragMat, {
    waistY: GOBLIN_WAIST_Y,
    waistRadius: 0.093,
    cachePrefix: 'goblin',
    lengthScale: 2.4,
    arcRad: 1.40,
    flare: 1.50
  }));

  addMediumLegs(group, mat, {
    hipY: 0.21, hipSpacing: 0.06, radius: 0.022, length: 0.21
  });

  group.userData.baseMaterial = mat;
  group.userData.ragMaterial = ragMat;
  return group;
}

// ---------------------------------------------------------------------------
// hobgoblin body (medium)
// ---------------------------------------------------------------------------

// Same two-lathe torso structure as the detailed hobgoblin, with the
// hobgoblin's larger, more upright proportions and a simplified set of
// armor: a metal cuirass cylinder, a belt, a cloth skirt, and a helmet
// dome + brow band. Ears and nose are dropped (both are sub-pixel trim at
// medium distance); the team-coloured skirt carries team identity.
//
// Constants mirror the detailed builder's. Kept as literals so this file
// has no import of the detailed builder's private constants — if the
// detailed hobgoblin is retuned, mirror the change here.
const HOBGOBLIN_WAIST_Y = 0.56;
const HOBGOBLIN_LOWER_TOP_Y = 0.58;
const HOBGOBLIN_TORSO_BOTTOM_Y = 0.25;
const HOBGOBLIN_TORSO_TOP_Y = 0.92;
const HOBGOBLIN_SLOUCH_RAD = 0.16;
const HOBGOBLIN_UPPER_HEIGHT = HOBGOBLIN_TORSO_TOP_Y - HOBGOBLIN_WAIST_Y;
const HOBGOBLIN_TOP_Y = HOBGOBLIN_WAIST_Y + HOBGOBLIN_UPPER_HEIGHT * Math.cos(HOBGOBLIN_SLOUCH_RAD);
const HOBGOBLIN_TOP_Z = HOBGOBLIN_UPPER_HEIGHT * Math.sin(HOBGOBLIN_SLOUCH_RAD);
const HOBGOBLIN_HEAD_RADIUS = 0.155;
const HOBGOBLIN_HEAD_Y = HOBGOBLIN_TOP_Y + HOBGOBLIN_HEAD_RADIUS * 0.60;
const HOBGOBLIN_HEAD_Z = HOBGOBLIN_TOP_Z + 0.020;

const HOBGOBLIN_LOWER_PROFILE = [
  new THREE.Vector2(0.000, HOBGOBLIN_TORSO_BOTTOM_Y),
  new THREE.Vector2(0.130, HOBGOBLIN_TORSO_BOTTOM_Y),
  new THREE.Vector2(0.142, HOBGOBLIN_TORSO_BOTTOM_Y + 0.10),
  new THREE.Vector2(0.132, HOBGOBLIN_TORSO_BOTTOM_Y + 0.20),
  new THREE.Vector2(0.115, HOBGOBLIN_LOWER_TOP_Y),
  new THREE.Vector2(0.000, HOBGOBLIN_LOWER_TOP_Y)
];
const HOBGOBLIN_UPPER_PROFILE = [
  new THREE.Vector2(0.000, 0),
  new THREE.Vector2(0.130, 0),
  new THREE.Vector2(0.135, HOBGOBLIN_UPPER_HEIGHT * 0.25),
  new THREE.Vector2(0.125, HOBGOBLIN_UPPER_HEIGHT * 0.55),
  new THREE.Vector2(0.105, HOBGOBLIN_UPPER_HEIGHT * 0.85),
  new THREE.Vector2(0.075, HOBGOBLIN_UPPER_HEIGHT),
  new THREE.Vector2(0.000, HOBGOBLIN_UPPER_HEIGHT)
];

export function createMediumHobgoblinBody(color) {
  const group = new THREE.Group();

  const skinColor = new THREE.Color(color).lerp(new THREE.Color(0x5a6a3a), 0.50);
  const mat = new THREE.MeshLambertMaterial({ color: skinColor });

  // Cached materials — uniform metal and a per-team cloth. Not disposed on
  // rebuildModel; they are shared across every hobgoblin of the same team.
  const metalMat = cachedMaterial('medium.hobgoblin.metalMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x50505a }));
  const clothMat = cachedMaterial(`medium.hobgoblin.clothMat.${color}`, () =>
    new THREE.MeshLambertMaterial({
      color: new THREE.Color(color).multiplyScalar(0.82),
      side: THREE.DoubleSide
    }));

  // Lower torso + head, both in body space.
  const lowerGeo = cachedGeometry('medium.hobgoblinLowerGeo', () =>
    new THREE.LatheGeometry(HOBGOBLIN_LOWER_PROFILE, 6));
  group.add(new THREE.Mesh(lowerGeo, mat));

  const headGeo = cachedGeometry('medium.hobgoblinHeadGeo', () => {
    const g = new THREE.SphereGeometry(HOBGOBLIN_HEAD_RADIUS, 7, 6);
    g.scale(1, 0.92, 1);
    return g;
  });
  const head = new THREE.Mesh(headGeo, mat);
  head.position.set(0, HOBGOBLIN_HEAD_Y, HOBGOBLIN_HEAD_Z);
  group.add(head);

  // Upper torso + cuirass inside the slouch pivot.
  const pivot = new THREE.Group();
  pivot.position.set(0, HOBGOBLIN_WAIST_Y, 0);
  pivot.rotation.x = HOBGOBLIN_SLOUCH_RAD;

  const upperGeo = cachedGeometry('medium.hobgoblinUpperGeo', () =>
    new THREE.LatheGeometry(HOBGOBLIN_UPPER_PROFILE, 6));
  pivot.add(new THREE.Mesh(upperGeo, mat));

  // Cuirass: a tapered cylinder hugging the chest in pivot space.
  const cuirassGeo = cachedGeometry('medium.hobgoblinCuirassGeo', () =>
    new THREE.CylinderGeometry(0.130, 0.145, 0.24, 8, 1, true));
  const cuirass = new THREE.Mesh(cuirassGeo, metalMat);
  cuirass.position.y = 0.14;
  pivot.add(cuirass);
  group.add(pivot);

  // Belt: metal ring at waist.
  const beltGeo = cachedGeometry('medium.hobgoblinBeltGeo', () =>
    new THREE.CylinderGeometry(0.138, 0.138, 0.06, 10, 1, true));
  const belt = new THREE.Mesh(beltGeo, metalMat);
  belt.position.y = HOBGOBLIN_WAIST_Y;
  group.add(belt);

  // Cloth skirt hanging from the belt — team-colour carry.
  const SKIRT_LENGTH = 0.12;
  const skirtGeo = cachedGeometry('medium.hobgoblinSkirtGeo', () =>
    new THREE.CylinderGeometry(0.140, 0.190, SKIRT_LENGTH, 8, 1, true,
      -Math.PI * 0.65, Math.PI * 1.3));
  const skirt = new THREE.Mesh(skirtGeo, clothMat);
  skirt.position.y = HOBGOBLIN_WAIST_Y - SKIRT_LENGTH / 2 - 0.02;
  group.add(skirt);

  // Helmet dome + brow band on the head, merged.
  const helmetGeo = cachedGeometry('medium.hobgoblinHelmetGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.SphereGeometry(
          HOBGOBLIN_HEAD_RADIUS + 0.022, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
        matrix: partMatrix(0, HOBGOBLIN_HEAD_Y, HOBGOBLIN_HEAD_Z)
      },
      {
        geometry: new THREE.BoxGeometry(0.20, 0.026, 0.04),
        matrix: partMatrix(0, HOBGOBLIN_HEAD_Y + 0.035,
          HOBGOBLIN_HEAD_Z + HOBGOBLIN_HEAD_RADIUS * 0.85)
      }
    ]));
  group.add(new THREE.Mesh(helmetGeo, metalMat));

  addMediumLegs(group, mat, {
    hipY: 0.30, hipSpacing: 0.075, radius: 0.028, length: 0.30
  });

  group.userData.baseMaterial = mat;
  return group;
}

// ---------------------------------------------------------------------------
// mounts
// ---------------------------------------------------------------------------

const MEDIUM_HORSE_LEG_TOP_Y = 0.32;
const MEDIUM_HORSE_LEG_MID_Y = -0.16;
const MEDIUM_HORSE_LEG_LENGTH = 0.32;

// Medium flesh horse: two box torso volumes (chest + haunch), a neck box,
// a head box, dark mane/ears/tail accents, four leg pivots. Same shape
// approach as the previous shared builder, with the skeleton variant
// pulled out into its own builder below.
function buildMediumFleshHorse() {
  const group = new THREE.Group();

  const bodyMat = cachedMaterial('medium.horse.bodyMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));
  const darkMat = cachedMaterial('medium.horse.darkMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a1a0e }));

  const bodyGeo = cachedGeometry('medium.horse.bodyGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.BoxGeometry(0.32, 0.32, 0.36),
        matrix: partMatrix(0, 0.41, 0.10)
      },
      {
        geometry: new THREE.BoxGeometry(0.28, 0.28, 0.44),
        matrix: partMatrix(0, 0.40, -0.16)
      },
      {
        geometry: new THREE.BoxGeometry(0.14, 0.30, 0.16),
        matrix: partMatrix(0, 0.55, 0.22, 0.75, 0, 0)
      },
      {
        geometry: new THREE.BoxGeometry(0.12, 0.14, 0.24),
        matrix: partMatrix(0, 0.73, 0.42, 0.35, 0, 0)
      }
    ]));
  group.add(new THREE.Mesh(bodyGeo, bodyMat));

  const darkGeo = cachedGeometry('medium.horse.darkGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.BoxGeometry(0.04, 0.05, 0.32),
        matrix: partMatrix(0, 0.62, 0.16, 0.75, 0, 0)
      },
      {
        geometry: new THREE.ConeGeometry(0.022, 0.07, 4),
        matrix: partMatrix(-0.04, 0.84, 0.37)
      },
      {
        geometry: new THREE.ConeGeometry(0.022, 0.07, 4),
        matrix: partMatrix(0.04, 0.84, 0.37)
      },
      {
        geometry: new THREE.ConeGeometry(0.045, 0.22, 4),
        matrix: partMatrix(0, 0.48, -0.38, -2.6, 0, 0)
      }
    ]));
  group.add(new THREE.Mesh(darkGeo, darkMat));

  const legGeo = cachedGeometry('medium.horse.legGeo', () =>
    new THREE.CylinderGeometry(0.03, 0.025, MEDIUM_HORSE_LEG_LENGTH, 4));

  const horseLegs = {};
  for (const lx of [-0.1, 0.1]) {
    for (const lz of [-0.18, 0.18]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, MEDIUM_HORSE_LEG_TOP_Y, lz);
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.y = MEDIUM_HORSE_LEG_MID_Y;
      pivot.add(leg);
      group.add(pivot);

      const end = lz > 0 ? 'f' : 'b';
      const side = lx < 0 ? 'l' : 'r';
      horseLegs[end + side] = pivot;
    }
  }
  group.userData.horseLegs = horseLegs;

  group.scale.setScalar(1.4);
  group.userData.riderMountHeight = 0.50;
  return group;
}

// Medium skeleton horse: thin spine + four leg-connection plates + thin
// head + thin legs, all merged into one bone mesh.
//
// Same reasoning as the simple-tier skeleton horse. The previous medium
// build reused the flesh horse's boxes with cs=0.65, which still gave a
// torso roughly 1.5x the detailed skeleton horse's ribcage width. At
// medium distance that reads as a recoloured barrel-on-legs, not as a
// skeleton mount — the exact failure the simple-tier fix addresses.
//
// The four plates are the important piece: they CONNECT the legs to the
// spine. Spine half-width is only 0.04, and leg pivots sit at X=±0.10
// — a gap of 0.06 with no geometry between them would leave the legs
// visibly floating off the body. Each plate is a box, tilted around Z,
// whose top tucks under the spine and whose bottom lands on the leg
// pivot — the same role SkeletonHorseBuilder's pelvis and scapula
// plates play in the detailed tier, collapsed to one box per leg.
//
// Every pivot position, leg mesh offset, group scale, and
// riderMountHeight matches the flesh mount byte-for-byte, so the trot
// cycle and rider seating read the same across variants and across LOD
// tiers.
function buildMediumSkeletonHorse() {
  const group = new THREE.Group();
  const mat = cachedMaterial('medium.skelHorse.boneMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xe8e0c8 }));

  // Plate maths (see the simple-tier skeleton horse for the full
  // derivation): spine bottom edge at (±0.04, 0.40), leg pivot at
  // (±0.10, 0.32). A 0.20-long plate tilted 0.55 rad around Z spans
  // from (≈0.003, 0.465) to (≈0.107, 0.295) — top buried in the spine,
  // bottom covering the top of the leg.
  const boneGeo = cachedGeometry('medium.skelHorse.boneGeo', () =>
    mergeGeometries([
      {
        // Spine spans from the front-leg row to just past the rear-leg
        // row — same footprint as SkeletonHorseBuilder's SPINE_FRONT_Z
        // (0.26) / SPINE_BACK_Z (-0.32), i.e. length 0.58 centred at
        // Z = -0.03. The previous 0.88 length reached well past both
        // leg rows, giving the mount a stretched, detached-looking
        // torso that read as a bare tube with legs tacked underneath.
        geometry: new THREE.BoxGeometry(0.08, 0.08, 0.58),
        matrix: partMatrix(0, 0.44, -0.03)
      },
      {
        geometry: new THREE.BoxGeometry(0.035, 0.20, 0.06),
        matrix: partMatrix(-0.055, 0.38, -0.18, 0, 0, -0.55)
      },
      {
        geometry: new THREE.BoxGeometry(0.035, 0.20, 0.06),
        matrix: partMatrix(0.055, 0.38, -0.18, 0, 0, 0.55)
      },
      {
        geometry: new THREE.BoxGeometry(0.035, 0.20, 0.06),
        matrix: partMatrix(-0.055, 0.38, 0.18, 0, 0, -0.55)
      },
      {
        geometry: new THREE.BoxGeometry(0.035, 0.20, 0.06),
        matrix: partMatrix(0.055, 0.38, 0.18, 0, 0, 0.55)
      },
      {
        // Head: dimensions match the detailed tier's upper-skull + jaw
        // envelope (SkeletonHorseBuilder.addSkull: ~0.08 wide, ~0.09 tall,
        // 0.30 long). The previous 0.10 × 0.14 × 0.42 box was roughly 40%
        // larger in every axis, which read as an oversized skull on an
        // otherwise-skinny spine. Position unchanged so the head still
        // overlaps the spine's front end.
        geometry: new THREE.BoxGeometry(0.075, 0.10, 0.30),
        matrix: partMatrix(0, 0.68, 0.42, 0.30, 0, 0)
      }
    ]));
  group.add(new THREE.Mesh(boneGeo, mat));

  const legGeo = cachedGeometry('medium.skelHorse.legGeo', () =>
    new THREE.CylinderGeometry(0.016, 0.013, MEDIUM_HORSE_LEG_LENGTH, 4));

  const horseLegs = {};
  for (const lx of [-0.1, 0.1]) {
    for (const lz of [-0.18, 0.18]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, MEDIUM_HORSE_LEG_TOP_Y, lz);
      const leg = new THREE.Mesh(legGeo, mat);
      leg.position.y = MEDIUM_HORSE_LEG_MID_Y;
      pivot.add(leg);
      group.add(pivot);

      const end = lz > 0 ? 'f' : 'b';
      const side = lx < 0 ? 'l' : 'r';
      horseLegs[end + side] = pivot;
    }
  }
  group.userData.horseLegs = horseLegs;

  group.scale.setScalar(1.4);
  group.userData.riderMountHeight = 0.50;
  return group;
}

export function createMediumHorseBase() {
  return buildMediumFleshHorse();
}

export function createMediumSkeletonHorseBase() {
  return buildMediumSkeletonHorse();
}

export function createMediumHorseHead() {
  // Icon accent, muzzle forward on +Z (UnitIconComposer rotates it +90°Y).
  // Two boxes merged into one — the live mount's skull block and muzzle
  // block, at icon scale.
  const group = new THREE.Group();
  const mat = cachedMaterial('medium.horseHeadMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));
  const geo = cachedGeometry('medium.horseHeadGeo', () =>
    mergeGeometries([
      { geometry: new THREE.BoxGeometry(0.16, 0.18, 0.34) },
      {
        geometry: new THREE.BoxGeometry(0.11, 0.12, 0.16),
        matrix: partMatrix(0, -0.06, 0.21, 0.25, 0, 0)
      }
    ]));
  group.add(new THREE.Mesh(geo, mat));
  return group;
}

// ---------------------------------------------------------------------------
// shields
// ---------------------------------------------------------------------------

export function createMediumShield() {
  // Banner shield: same heater outline as detailed, no bevel. Bevels cost
  // a couple dozen vertices per shield and are invisible past a few metres.
  const HALF_W = 0.23;
  const TOP_Y = 0.31;
  const BOTTOM_Y = -0.31;
  const DEPTH = 0.035;

  const geo = cachedGeometry('medium.shieldGeo', () => {
    const shape = new THREE.Shape();
    shape.moveTo(-HALF_W, TOP_Y);
    shape.lineTo(-HALF_W, TOP_Y - 0.13);
    shape.lineTo(-HALF_W + 0.02, TOP_Y - 0.26);
    shape.lineTo(-HALF_W + 0.06, TOP_Y - 0.39);
    shape.lineTo(-HALF_W + 0.12, TOP_Y - 0.51);
    shape.lineTo(-HALF_W + 0.18, TOP_Y - 0.59);
    shape.lineTo(0, BOTTOM_Y);
    shape.lineTo(HALF_W - 0.18, TOP_Y - 0.59);
    shape.lineTo(HALF_W - 0.12, TOP_Y - 0.51);
    shape.lineTo(HALF_W - 0.06, TOP_Y - 0.39);
    shape.lineTo(HALF_W - 0.02, TOP_Y - 0.26);
    shape.lineTo(HALF_W, TOP_Y - 0.13);
    shape.lineTo(HALF_W, TOP_Y);
    shape.closePath();

    const g = new THREE.ExtrudeGeometry(shape, {
      depth: DEPTH,
      bevelEnabled: false,
      curveSegments: 1
    });
    g.translate(0, 0, -DEPTH / 2);
    return g;
  });
  const mat = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
  return new THREE.Mesh(geo, mat);
}

export function createMediumGoblinShield() {
  const geo = cachedGeometry('medium.goblinShieldGeo', () => {
    const g = new THREE.CylinderGeometry(0.20, 0.20, 0.05, 6);
    g.rotateX(Math.PI / 2);
    return g;
  });
  const mat = new THREE.MeshLambertMaterial({ color: 0x6a4526 });
  return new THREE.Mesh(geo, mat);
}

// ---------------------------------------------------------------------------
// weapons
// ---------------------------------------------------------------------------

export function createMediumSpear() {
  const group = new THREE.Group();
  group.position.set(0.24, 0.65, 0);

  const shaftGeo = cachedGeometry('medium.spearShaftGeo', () =>
    new THREE.CylinderGeometry(0.02, 0.02, 1.4, 4));
  const shaftMat = cachedMaterial('medium.spearShaftMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.6;
  group.add(shaft);

  const tipGeo = cachedGeometry('medium.spearTipGeo', () =>
    new THREE.ConeGeometry(0.04, 0.18, 4));
  const tipMat = cachedMaterial('medium.spearTipMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));
  const tip = new THREE.Mesh(tipGeo, tipMat);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = 1.3;
  group.add(tip);

  return group;
}

// Goblin spear. Same geometry as createMediumSpear — the composer scales
// it by GOBLIN_WEAPON_SCALE. Only the materials differ: darker wood and a
// flint/bone tip, matching the detailed-tier goblin spear's palette.
export function createMediumGoblinSpear() {
  const group = new THREE.Group();
  group.position.set(0.24, 0.65, 0);

  const shaftGeo = cachedGeometry('medium.spearShaftGeo', () =>
    new THREE.CylinderGeometry(0.02, 0.02, 1.4, 4));
  const shaftMat = cachedMaterial('medium.goblinSpearShaftMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x3f2a12 }));
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.6;
  group.add(shaft);

  const tipGeo = cachedGeometry('medium.spearTipGeo', () =>
    new THREE.ConeGeometry(0.04, 0.18, 4));
  const tipMat = cachedMaterial('medium.goblinSpearTipMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x8a8060 }));
  const tip = new THREE.Mesh(tipGeo, tipMat);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = 1.3;
  group.add(tip);

  return group;
}

export function createMediumLance() {
  const group = new THREE.Group();
  group.position.set(0.26, 0.70, 0);

  const SHAFT_LEN = 2.4;

  const shaftGeo = cachedGeometry('medium.lanceShaftGeo', () =>
    new THREE.CylinderGeometry(0.014, 0.038, SHAFT_LEN, 5));
  const shaftMat = cachedMaterial('medium.lanceShaftMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = SHAFT_LEN / 2 - 0.5;
  group.add(shaft);

  const gripGeo = cachedGeometry('medium.lanceGripGeo', () =>
    new THREE.CylinderGeometry(0.048, 0.048, 0.45, 6));
  const gripMat = cachedMaterial('medium.lanceGripMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a1a0e }));
  const grip = new THREE.Mesh(gripGeo, gripMat);
  grip.rotation.x = Math.PI / 2;
  grip.position.z = -0.15;
  group.add(grip);

  const vamplateGeo = cachedGeometry('medium.lanceVamplateGeo', () =>
    new THREE.ConeGeometry(0.15, 0.24, 8, 1, true));
  const vamplateMat = cachedMaterial('medium.lanceVamplateMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x8a6a3a, side: THREE.DoubleSide }));
  const vamplate = new THREE.Mesh(vamplateGeo, vamplateMat);
  vamplate.rotation.x = -Math.PI / 2;
  vamplate.position.z = 0.25;
  group.add(vamplate);

  const tipGeo = cachedGeometry('medium.lanceTipGeo', () =>
    new THREE.ConeGeometry(0.04, 0.38, 5));
  const tipMat = cachedMaterial('medium.lanceTipMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));
  const tip = new THREE.Mesh(tipGeo, tipMat);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = SHAFT_LEN - 0.5 + 0.38 / 2 - 0.03;
  group.add(tip);

  const pennonGeo = cachedGeometry('medium.lancePennonGeo', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(0, -0.20);
    s.lineTo(-0.28, -0.06);
    s.closePath();
    return new THREE.ShapeGeometry(s);
  });
  const pennonMat = cachedMaterial('medium.lancePennonMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xb03030, side: THREE.DoubleSide }));
  const pennon = new THREE.Mesh(pennonGeo, pennonMat);
  pennon.position.z = SHAFT_LEN - 0.7;
  group.add(pennon);

  return group;
}

export function createMediumSword() {
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  const bladeGeo = cachedGeometry('medium.swordBladeGeo', () =>
    new THREE.BoxGeometry(0.05, 0.7, 0.12));
  const bladeMat = cachedMaterial('medium.swordBladeMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));
  const blade = new THREE.Mesh(bladeGeo, bladeMat);
  blade.rotation.x = Math.PI / 2;
  blade.position.z = 0.45;
  group.add(blade);

  const hiltGeo = cachedGeometry('medium.swordHiltGeo', () =>
    new THREE.CylinderGeometry(0.03, 0.03, 0.16, 4));
  const hiltMat = cachedMaterial('medium.swordHiltMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a3018 }));
  const hilt = new THREE.Mesh(hiltGeo, hiltMat);
  hilt.rotation.x = Math.PI / 2;
  hilt.position.z = 0.05;
  group.add(hilt);

  return group;
}

export function createMediumCrudeSword() {
  // Crude goblin sword: simplified from the detailed extruded-outline build
  // (which has 9 profile vertices) to a tapered box blade + collar + grip.
  // The chip notch is dropped — at medium distance it reads as noise.
  const group = new THREE.Group();

  const bladeGeo = cachedGeometry('medium.crudeBladeGeo', () =>
    new THREE.BoxGeometry(0.018, 0.08, 0.32));
  const bladeMat = cachedMaterial('medium.crudeBladeMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x6a5e52 }));
  const blade = new THREE.Mesh(bladeGeo, bladeMat);
  blade.position.z = 0.20;
  group.add(blade);

  const collarGeo = cachedGeometry('medium.crudeCollarGeo', () =>
    new THREE.BoxGeometry(0.035, 0.095, 0.028));
  const collarMat = cachedMaterial('medium.crudeCollarMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a1a0e }));
  const collar = new THREE.Mesh(collarGeo, collarMat);
  collar.position.z = 0.045;
  group.add(collar);

  const gripGeo = cachedGeometry('medium.crudeGripGeo', () =>
    new THREE.CylinderGeometry(0.016, 0.013, 0.11, 4));
  const gripMat = cachedMaterial('medium.crudeGripMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x3a2510 }));
  const grip = new THREE.Mesh(gripGeo, gripMat);
  grip.rotation.x = Math.PI / 2;
  grip.position.z = -0.010;
  group.add(grip);

  return group;
}

export function createMediumBow() {
  // C-shaped limb arc — same shape approach as the simple bow, with more
  // tubular segments so the curve reads smooth at medium distance. String
  // halves and nocked arrow are stubbed as invisible Object3Ds so
  // layoutBowString and _applyBowDraw do not crash; the draw animation is
  // a no-op at this tier.
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  const ARC = Math.PI * 1.25;
  const geo = cachedGeometry('medium.bowGeo', () => {
    const g = new THREE.TorusGeometry(0.24, 0.014, 5, 12, ARC);
    g.rotateY(Math.PI / 2);
    g.rotateX(Math.PI - ARC / 2);
    return g;
  });
  const mat = cachedMaterial('medium.bowMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  group.add(new THREE.Mesh(geo, mat));

  const topPivot = new THREE.Object3D();
  const bottomPivot = new THREE.Object3D();
  const topString = new THREE.Object3D();
  const bottomString = new THREE.Object3D();
  const nockedArrow = new THREE.Object3D();
  topString.visible = false;
  bottomString.visible = false;
  nockedArrow.visible = false;
  group.userData.topLimbPivot = topPivot;
  group.userData.bottomLimbPivot = bottomPivot;
  group.userData.topString = topString;
  group.userData.bottomString = bottomString;
  group.userData.nockedArrow = nockedArrow;

  return group;
}

// Goblin shortbow: shorter, darker than the composite silhouette above.
// Same Object3D userData stubs so layoutBowString and _applyBowDraw run
// unchanged.
export function createMediumGoblinShortbow() {
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  const ARC = Math.PI * 1.25;
  const geo = cachedGeometry('medium.goblinShortbowGeo', () => {
    const g = new THREE.TorusGeometry(0.18, 0.014, 5, 12, ARC);
    g.rotateY(Math.PI / 2);
    g.rotateX(Math.PI - ARC / 2);
    return g;
  });
  const mat = cachedMaterial('medium.goblinShortbowMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x3f2a12 }));
  group.add(new THREE.Mesh(geo, mat));

  const topPivot = new THREE.Object3D();
  const bottomPivot = new THREE.Object3D();
  const topString = new THREE.Object3D();
  const bottomString = new THREE.Object3D();
  const nockedArrow = new THREE.Object3D();
  topString.visible = false;
  bottomString.visible = false;
  nockedArrow.visible = false;
  group.userData.topLimbPivot = topPivot;
  group.userData.bottomLimbPivot = bottomPivot;
  group.userData.topString = topString;
  group.userData.bottomString = bottomString;
  group.userData.nockedArrow = nockedArrow;

  return group;
}

export function createMediumArrowProjectile() {
  // One shaft + one head, merged. Rotation baked into the geometry (not the
  // mesh) so ProjectileView.sync's per-frame yaw/pitch writes are free.
  const geo = cachedGeometry('medium.arrowGeo', () => {
    const shaft = new THREE.CylinderGeometry(0.007, 0.007, 0.5, 4);
    shaft.rotateX(Math.PI / 2);
    const head = new THREE.ConeGeometry(0.014, 0.06, 4);
    head.rotateX(Math.PI / 2);
    head.translate(0, 0, 0.25 + 0.03 - 0.005);

    return mergeGeometries([
      { geometry: shaft },
      { geometry: head }
    ]);
  });
  const mat = cachedMaterial('medium.arrowMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x8a5a24 }));
  return new THREE.Mesh(geo, mat);
}

// ---------------------------------------------------------------------------
// quiver
// ---------------------------------------------------------------------------

export function createMediumQuiver() {
  // Tapered cylinder + rim, merged. Arrows and side straps dropped — the
  // quiver read is "something strapped on the back" and both the arrows and
  // straps disappear first when the LOD steps down.
  const group = new THREE.Group();

  const geo = cachedGeometry('medium.quiverGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.CylinderGeometry(0.048, 0.040, 0.22, 6),
        matrix: partMatrix(0, 0.11, 0)
      },
      {
        geometry: new THREE.CylinderGeometry(0.052, 0.052, 0.020, 6),
        matrix: partMatrix(0, 0.215, 0)
      }
    ]));
  const mat = cachedMaterial('medium.quiverMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  group.add(new THREE.Mesh(geo, mat));

  return group;
}

// ---------------------------------------------------------------------------
// icons (army-bar thumbnail accents)
// ---------------------------------------------------------------------------

export function createMediumSkull() {
  const group = new THREE.Group();
  const boneMat = cachedMaterial('medium.skullBoneMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xe8e0c8 }));
  const socketMat = cachedMaterial('medium.skullSocketMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x1a1408 }));

  const craniumGeo = cachedGeometry('medium.skullCraniumGeo', () =>
    new THREE.SphereGeometry(0.15, 7, 5));
  group.add(new THREE.Mesh(craniumGeo, boneMat));

  const socketGeo = cachedGeometry('medium.skullSocketGeo', () =>
    new THREE.SphereGeometry(0.045, 4, 4));
  for (const sx of [-0.055, 0.055]) {
    const socket = new THREE.Mesh(socketGeo, socketMat);
    socket.position.set(sx, 0.01, 0.125);
    group.add(socket);
  }

  const jawGeo = cachedGeometry('medium.skullJawGeo', () =>
    new THREE.BoxGeometry(0.14, 0.07, 0.12));
  const jaw = new THREE.Mesh(jawGeo, boneMat);
  jaw.position.set(0, -0.13, 0.06);
  group.add(jaw);

  return group;
}
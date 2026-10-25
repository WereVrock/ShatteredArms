// ===== src/render/mesh/HobgoblinBodyBuilder.js =====
// Hobgoblin body: a taller, broader, more upright goblin body wearing
// structured armor — cuirass, pauldrons, belt, cloth skirt, helmet. Built
// from primitives with no external assets, mirroring GoblinBodyBuilder.
//
// POSTURE
// Hobgoblins are disciplined soldiers, not skulkers. Where the goblin's
// upper torso folds forward by 0.40 rad, the hobgoblin folds by only 0.16 —
// enough to read as a non-human stance, not enough to read as a slouch.
// The two-lathe torso structure (vertical pelvis + tilted chest at a waist
// pivot) is preserved so the walk cycle and mounted pose that drive the
// upper pivot are unchanged.
//
// SIZE
// Roughly 1.4x the goblin's height — human-scale, not goblin-scale. The
// head is proportionally slightly smaller than the goblin's, and the ears
// are shorter and swept back rather than long blades. The helmet is baked
// into the body (no helmetType is consulted). Silhouette is distinct from
// a human (pointed ears, dark steel helm) and from a goblin (bulkier,
// armored, upright).
//
// ARMOR
// See HobgoblinArmor.js. Team colour lives on the cloth skirt hanging from
// the belt — the plates are dark steel, matching a military kit rather than
// the goblins' scavenged look. The helmet is baked in (unlike goblins,
// hobgoblins wear helmets), so no helmetType is consulted.
//
// MERGE STRATEGY (see MeshMerge.js)
// The body skin is two meshes: lower torso + head + nose + ears in body
// space, and upper torso inside the slouch pivot. The armor is three
// meshes: cuirass + pauldrons (in the pivot), belt + helmet (in body
// space), cloth skirt (in body space). The legs are four meshes (2 legs ×
// hip + knee). Total ~9 meshes, in line with the goblin's ~8.
//
// Geometries are cached (see MeshCache.js). The body material is
// per-instance because SoldierView.sync tints it toward black as HP drops.
// The armor materials are cached (see HobgoblinArmor) — they are uniform
// across hobgoblins, so no per-instance disposal is needed.
import * as THREE from 'three';
import { cachedGeometry } from './MeshCache.js';
import { mergeGeometries, partMatrix, poseMatrix } from './MeshMerge.js';
import {
  getHobgoblinMetalMaterial,
  getHobgoblinClothMaterial,
  createHobgoblinTorsoArmor,
  createHobgoblinBodyArmor,
  createHobgoblinSkirt
} from './HobgoblinArmor.js';

// --- leg proportions -------------------------------------------------------

const HOBGOBLIN_LEG_HIP_Y       = 0.30;
const HOBGOBLIN_LEG_HIP_SPACING = 0.075;
const HOBGOBLIN_LEG_RADIUS      = 0.028;
const HOBGOBLIN_THIGH_LENGTH    = 0.15;
const HOBGOBLIN_SHIN_LENGTH     = 0.15;

// --- torso geometry --------------------------------------------------------

const HOBGOBLIN_PELVIS_HALF_HEIGHT = 0.05;
const HOBGOBLIN_TORSO_BOTTOM_Y = HOBGOBLIN_LEG_HIP_Y - HOBGOBLIN_PELVIS_HALF_HEIGHT;  // 0.25

const HOBGOBLIN_WAIST_Y     = 0.56;
const HOBGOBLIN_LOWER_TOP_Y = 0.58;
const HOBGOBLIN_TORSO_TOP_Y = 0.92;

// Far more upright than the goblin's 0.40. A hobgoblin stands like a soldier.
const HOBGOBLIN_SLOUCH_RAD = 0.16;

const HOBGOBLIN_UPPER_HEIGHT = HOBGOBLIN_TORSO_TOP_Y - HOBGOBLIN_WAIST_Y;  // 0.36
const HOBGOBLIN_TOP_Y = HOBGOBLIN_WAIST_Y + HOBGOBLIN_UPPER_HEIGHT * Math.cos(HOBGOBLIN_SLOUCH_RAD);
const HOBGOBLIN_TOP_Z = HOBGOBLIN_UPPER_HEIGHT * Math.sin(HOBGOBLIN_SLOUCH_RAD);

// --- head ------------------------------------------------------------------

const HOBGOBLIN_HEAD_RADIUS = 0.155;
const HOBGOBLIN_HEAD_FORWARD_EXTRA = 0.020;
const HOBGOBLIN_HEAD_Y = HOBGOBLIN_TOP_Y + HOBGOBLIN_HEAD_RADIUS * 0.60;
const HOBGOBLIN_HEAD_Z = HOBGOBLIN_TOP_Z + HOBGOBLIN_HEAD_FORWARD_EXTRA;

// --- ears ------------------------------------------------------------------

// Shorter and swept back compared to the goblin's long blade ears. A
// hobgoblin's ears still mark the race at silhouette distance, but they do
// not dominate the profile.
const HOBGOBLIN_EAR_LENGTH = 0.10;
function hobgoblinEarDirection(side) {
  return new THREE.Vector3(side * 0.35, -0.35, -0.87).normalize();
}

// --- skin tint -------------------------------------------------------------

// Darker olive than the goblin's bright green, so the two races read
// different at a glance even before the armor.
const HOBGOBLIN_SKIN = 0x5a6a3a;
const HOBGOBLIN_TINT = 0.50;

// --- lathe profiles --------------------------------------------------------

const HOBGOBLIN_TORSO_RADIAL_SEGMENTS = 10;

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

// --- armor layout ----------------------------------------------------------

const HOBGOBLIN_BELT_Y = HOBGOBLIN_WAIST_Y;
const HOBGOBLIN_BELT_RADIUS = 0.138;
const HOBGOBLIN_SKIRT_LENGTH = 0.12;
const HOBGOBLIN_SKIRT_FLARE = 1.35;

// Cuirass covers the mid-chest in pivot-local space.
const HOBGOBLIN_CUIRASS_Y_FROM = 0.03;
const HOBGOBLIN_CUIRASS_Y_TO   = 0.30;
const HOBGOBLIN_CUIRASS_PAD    = 0.020;

// Pauldrons sit at the top of the upper profile in pivot-local space.
const HOBGOBLIN_PAULDRON_Y = 0.26;
const HOBGOBLIN_PAULDRON_X = 0.110;
const HOBGOBLIN_PAULDRON_RADIUS = 0.075;

// --- builder ---------------------------------------------------------------

export function createHobgoblinBody(teamColor) {
  const group = new THREE.Group();

  // Per-instance: SoldierView tints this toward black as HP drops.
  const skinColor = new THREE.Color(teamColor).lerp(
    new THREE.Color(HOBGOBLIN_SKIN), HOBGOBLIN_TINT
  );
  const skinMat = new THREE.MeshLambertMaterial({ color: skinColor });
  const metalMat = getHobgoblinMetalMaterial();
  const clothMat = getHobgoblinClothMaterial(teamColor);

  // Body-space skin: lower torso + head + nose + two ears.
  addBodySkin(group, skinMat);

  // Body-space armor: belt + helmet (merged).
  group.add(createHobgoblinBodyArmor(metalMat, {
    beltY: HOBGOBLIN_BELT_Y,
    beltRadius: HOBGOBLIN_BELT_RADIUS,
    headY: HOBGOBLIN_HEAD_Y,
    headRadius: HOBGOBLIN_HEAD_RADIUS,
    headZ: HOBGOBLIN_HEAD_Z,
    cachePrefix: 'hobgoblin'
  }));

  // Cloth skirt hanging from the belt — team-colour carry.
  group.add(createHobgoblinSkirt(clothMat, {
    beltY: HOBGOBLIN_BELT_Y,
    beltRadius: HOBGOBLIN_BELT_RADIUS,
    length: HOBGOBLIN_SKIRT_LENGTH,
    flare: HOBGOBLIN_SKIRT_FLARE,
    cachePrefix: 'hobgoblin'
  }));

  // Upper torso + cuirass + pauldrons inside the slouch pivot.
  addUpperTorsoAndArmor(group, skinMat, metalMat);

  addHobgoblinLegs(group, skinMat);

  group.userData.baseMaterial = skinMat;
  return group;
}

// --- lower torso + head + nose + ears (body-space skin mesh) ---------------

function addBodySkin(group, mat) {
  const geo = cachedGeometry('hobgoblin.bodySkinGeo', () => {
    const entries = [
      {
        geometry: new THREE.LatheGeometry(
          HOBGOBLIN_LOWER_PROFILE, HOBGOBLIN_TORSO_RADIAL_SEGMENTS
        )
      }
    ];

    // Head: sphere, squashed slightly on Y.
    {
      const headGeo = new THREE.SphereGeometry(HOBGOBLIN_HEAD_RADIUS, 10, 8);
      headGeo.scale(1, 0.92, 1);
      entries.push({
        geometry: headGeo,
        matrix: partMatrix(0, HOBGOBLIN_HEAD_Y, HOBGOBLIN_HEAD_Z)
      });
    }

    // Nose — shorter and blunter than the goblin's.
    entries.push({
      geometry: new THREE.ConeGeometry(0.045, 0.14, 6),
      matrix: partMatrix(
        0,
        HOBGOBLIN_HEAD_Y - 0.020,
        HOBGOBLIN_HEAD_Z + HOBGOBLIN_HEAD_RADIUS - 0.02,
        Math.PI / 2 + 0.30, 0, 0
      )
    });

    // Ears: blade-shaped cones oriented via a quaternion.
    //
    // The base sits WELL BELOW the head's equator, not just under the
    // helmet's rim. The helmet is a full upper hemisphere of radius
    // (headRadius + 0.022); an ear base at or above the equator puts the
    // cone's base disk (radius 0.035) inside the helmet volume, so the
    // ear only emerges past the dome most of the way along its length and
    // the base disk z-fights the helmet surface. Dropping the base by
    // 0.055 — more than the cone's own vertical thickness once swept back
    // — puts the whole ear on exposed skin, and the down-and-back sweep
    // carries the tip clear without touching the helmet shell.
    const up = new THREE.Vector3(0, 1, 0);
    for (const side of [-1, 1]) {
      const dir = hobgoblinEarDirection(side);
      const base = new THREE.Vector3(
        side * (HOBGOBLIN_HEAD_RADIUS - 0.030),
        HOBGOBLIN_HEAD_Y - 0.055,
        HOBGOBLIN_HEAD_Z - 0.020
      );
      const position = base.clone().addScaledVector(dir, HOBGOBLIN_EAR_LENGTH / 2);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(up, dir);
      const scale = new THREE.Vector3(0.32, 1, 1);

      entries.push({
        geometry: new THREE.ConeGeometry(0.035, HOBGOBLIN_EAR_LENGTH, 4),
        matrix: poseMatrix(position, quaternion, scale)
      });
    }

    return mergeGeometries(entries);
  });

  group.add(new THREE.Mesh(geo, mat));
}

// --- upper torso + armor (slouch-pivot-local) ------------------------------

function addUpperTorsoAndArmor(group, skinMat, metalMat) {
  const pivot = new THREE.Group();
  pivot.position.set(0, HOBGOBLIN_WAIST_Y, 0);
  pivot.rotation.x = HOBGOBLIN_SLOUCH_RAD;

  const skinGeo = cachedGeometry('hobgoblin.upperSkinGeo', () =>
    new THREE.LatheGeometry(
      HOBGOBLIN_UPPER_PROFILE, HOBGOBLIN_TORSO_RADIAL_SEGMENTS
    ));
  pivot.add(new THREE.Mesh(skinGeo, skinMat));

  const armorMesh = createHobgoblinTorsoArmor(metalMat, {
    profile: HOBGOBLIN_UPPER_PROFILE,
    pad: HOBGOBLIN_CUIRASS_PAD,
    yFrom: HOBGOBLIN_CUIRASS_Y_FROM,
    yTo: HOBGOBLIN_CUIRASS_Y_TO,
    pauldronY: HOBGOBLIN_PAULDRON_Y,
    pauldronX: HOBGOBLIN_PAULDRON_X,
    pauldronRadius: HOBGOBLIN_PAULDRON_RADIUS,
    cachePrefix: 'hobgoblin'
  });
  pivot.add(armorMesh);

  group.add(pivot);
}

// --- legs ------------------------------------------------------------------

function addHobgoblinLegs(group, mat) {
  const thighGeo = cachedGeometry('hobgoblin.thighGeo', () =>
    new THREE.CylinderGeometry(
      HOBGOBLIN_LEG_RADIUS, HOBGOBLIN_LEG_RADIUS, HOBGOBLIN_THIGH_LENGTH, 5));
  const shinGeo = cachedGeometry('hobgoblin.shinGeo', () =>
    new THREE.CylinderGeometry(
      HOBGOBLIN_LEG_RADIUS, HOBGOBLIN_LEG_RADIUS, HOBGOBLIN_SHIN_LENGTH, 5));

  const left = buildHobgoblinLeg(mat, thighGeo, shinGeo, -HOBGOBLIN_LEG_HIP_SPACING);
  group.add(left.hip);

  const right = buildHobgoblinLeg(mat, thighGeo, shinGeo, HOBGOBLIN_LEG_HIP_SPACING);
  group.add(right.hip);

  group.userData.legLeftPivot  = left.hip;
  group.userData.legRightPivot = right.hip;
  group.userData.legLeftKnee   = left.knee;
  group.userData.legRightKnee  = right.knee;
}

function buildHobgoblinLeg(mat, thighGeo, shinGeo, x) {
  const hip = new THREE.Group();
  hip.position.set(x, HOBGOBLIN_LEG_HIP_Y, 0);

  const thigh = new THREE.Mesh(thighGeo, mat);
  thigh.position.y = -HOBGOBLIN_THIGH_LENGTH / 2;
  thigh.userData.noShadow = true;
  hip.add(thigh);

  const knee = new THREE.Group();
  knee.position.y = -HOBGOBLIN_THIGH_LENGTH;
  hip.add(knee);

  const shin = new THREE.Mesh(shinGeo, mat);
  shin.position.y = -HOBGOBLIN_SHIN_LENGTH / 2;
  shin.userData.noShadow = true;
  knee.add(shin);

  return { hip, knee };
}
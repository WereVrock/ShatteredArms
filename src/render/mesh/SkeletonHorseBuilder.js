// ===== src/render/mesh/SkeletonHorseBuilder.js =====
// Skeleton mount. Same footprint, scale, and userData contract as
// HorseBuilder.createHorseBase, so SoldierView's trot cycle, rider seating,
// and pick proxy all work unchanged — swapping a flesh mount for a bone one
// is a builder swap, not a view change.
//
// Bony geometry replaces the flesh barrel/neck/head:
//   - ribcage: spine cylinder + torus rings stacked along Z
//   - neck: thin tapering cylinder with vertebra bumps
//   - skull: cranium block, muzzle block, dark eye sockets and nostrils
//   - tail: chain of shrinking bone spheres
// Legs remain single-pivot bone cylinders, so the existing trot cycle is
// unchanged.
//
// MERGE STRATEGY (see MeshMerge.js)
//   - All bone-material parts that hang directly on the mount group
//     (spine, ribs, pelvis plates, hip sockets, withers, scapula plates,
//     shoulder sockets) merge into one "bone body" mesh.
//   - The neck group's contents (neck bone + four vertebra) merge into
//     one mesh inside the neck group.
//   - The head group's contents merge into TWO meshes inside the head
//     group: one bone (upper skull + lower jaw), one dark (eye sockets +
//     nasal opening).
//   - The tail group's four bone spheres merge into one mesh inside the
//     tail group.
//   - Legs stay as four separate pivots (they animate).
// Net: ~24 static meshes collapse to 4 (bone body + neck + head×2 + tail),
// with zero visual change — every vertex keeps its exact position,
// rotation, and material.
//
// Interface contract with SoldierView (MUST match HorseBuilder):
//   group.userData.horseLegs = { fl, fr, bl, br }  — leg pivots
//   group.userData.riderMountHeight = 0.50
//   group.scale = 1.4
//
// All merged geometries and both materials are cached (see MeshCache.js).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

// Palette matched to SkeletonBodyBuilder so rider and mount read as one
// material family. Both are cached — every skeleton horse shares them.
const BONE_COLOR = 0xe8e0c8;
const DARK_COLOR = 0x1a1408;

// Dimensions mirrored from HorseBuilder. Anything the rider position or the
// trot cycle depends on (mount height, leg pivot Y, leg mesh offset) must
// match exactly or the rider will float/sink relative to the flesh mount.
// Radius of the ribcage torus rings. Stepped down from the flesh mount's
// 0.15 → 0.10 → 0.075. A skeleton mount is a bare ribcage hung on a
// spine, and at 0.075 it reads visibly gaunt next to the flesh mount —
// which is the entire point of the bone variant.
const BARREL_CENTER_Y = 0.42;
const BARREL_RADIUS = 0.075;

const HORSE_LEG_TOP_Y = 0.32;
const HORSE_LEG_MID_Y = -0.16;
const HORSE_LEG_LENGTH = 0.32;

const NECK_CENTER_Y = 0.55;
const NECK_CENTER_Z = 0.22;
const NECK_TILT_X = 0.75;
const NECK_LENGTH = 0.32;

const HEAD_CENTER_Y = 0.73;
const HEAD_CENTER_Z = 0.42;
const HEAD_TILT_X = 0.35;

const MOUNT_SCALE = 1.4;
const RIDER_MOUNT_HEIGHT = 0.50;

// Shared plate dimensions used by both the pelvis and the shoulder girdle.
const PLATE_LENGTH = 0.242;
const PLATE_TILT_RAD = 0.427;

// Spine anchor (see addRibcage below).
const SPINE_FRONT_Z = 0.26;
const SPINE_BACK_Z  = -0.32;
const SPINE_LENGTH  = SPINE_FRONT_Z - SPINE_BACK_Z;
const SPINE_Y       = BARREL_CENTER_Y + BARREL_RADIUS - 0.03;
const SPINE_MID_Z   = (SPINE_FRONT_Z + SPINE_BACK_Z) / 2;

// Rib cluster (see addRibcage below).
const RIB_COUNT   = 5;
const RIB_FRONT_Z = 0.12;
const RIB_BACK_Z  = -0.10;

// Neck vertebra bumps (see addNeck below).
const VERTEBRA_COUNT = 4;
const VERTEBRA_INSET = 0.04;
const VERTEBRA_SPAN  = NECK_LENGTH - VERTEBRA_INSET * 2;

// Tail segment layout (see addTail below).
const TAIL_SEGMENT_COUNT = 4;
const TAIL_SEGMENT_SPAN  = 0.22;

export function createSkeletonHorseBase() {
  const group = new THREE.Group();

  const boneMat = cachedMaterial('skelHorse.boneMat', () =>
    new THREE.MeshLambertMaterial({ color: BONE_COLOR }));
  const darkMat = cachedMaterial('skelHorse.darkMat', () =>
    new THREE.MeshLambertMaterial({ color: DARK_COLOR }));

  // --- bone body: spine + ribs + pelvis + sockets + withers + scapula ---
  // Everything that hangs directly on the mount group (no nested pivot)
  // and uses the bone material.
  const boneBodyGeo = cachedGeometry('skelHorse.boneBodyGeo', () => {
    const entries = [];

    // Spine: thin bone running the length of the skeleton, high on the
    // back. Deliberately SHORTER than the flesh mount's barrel — a bare
    // bone rod has to stop where the skeleton stops. Front end at Z=+0.26
    // sits flush with the withers block's front face; rear end at Z=-0.32
    // leaves a short lumbar stretch behind the pelvis before the tail.
    entries.push({
      geometry: new THREE.CylinderGeometry(0.012, 0.012, SPINE_LENGTH, 5),
      matrix: partMatrix(0, SPINE_Y, SPINE_MID_Z, Math.PI / 2, 0, 0)
    });

    // Ribs: five rings over the front-middle of the body. The front rib
    // is the largest; each successive rib behind it is smaller, so the
    // ribcage narrows toward the pelvis the way a real ribcage does.
    for (let i = 0; i < RIB_COUNT; i++) {
      const t = RIB_COUNT === 1 ? 0 : i / (RIB_COUNT - 1);
      const scale = 1 - t * 0.45;
      const z = RIB_FRONT_Z + (RIB_BACK_Z - RIB_FRONT_Z) * t;
      entries.push({
        geometry: new THREE.TorusGeometry(BARREL_RADIUS * scale, 0.006, 5, 10),
        matrix: partMatrix(0, BARREL_CENTER_Y, z)
      });
    }

    // Pelvis: two bone plates bridging the spine's rear down and outward
    // to each hind-leg pivot. Mirrored on the Z axis.
    for (const side of [-1, 1]) {
      entries.push({
        geometry: new THREE.BoxGeometry(0.017, PLATE_LENGTH, 0.072),
        matrix: partMatrix(side * 0.05, 0.43, -0.18, 0, 0, side * PLATE_TILT_RAD)
      });
    }

    // Hip sockets: a small bone nub at each hind-leg pivot, capping the
    // top of the leg mesh and closing the joint with the plate's lower
    // end.
    for (const hx of [-0.10, 0.10]) {
      entries.push({
        geometry: new THREE.SphereGeometry(0.034, 6, 5),
        matrix: partMatrix(hx, HORSE_LEG_TOP_Y, -0.18)
      });
    }

    // Withers vertebra: thick bone block bridging the spine's front end
    // down to the neck cylinder's base.
    entries.push({
      geometry: new THREE.BoxGeometry(0.05, 0.16, 0.12),
      matrix: partMatrix(0, 0.47, 0.18)
    });

    // Scapula plates: same geometry and tilt as the pelvis plates.
    for (const side of [-1, 1]) {
      entries.push({
        geometry: new THREE.BoxGeometry(0.017, PLATE_LENGTH, 0.072),
        matrix: partMatrix(side * 0.05, 0.43, 0.18, 0, 0, side * PLATE_TILT_RAD)
      });
    }

    // Shoulder sockets: mirror of the hip sockets.
    for (const sx of [-0.10, 0.10]) {
      entries.push({
        geometry: new THREE.SphereGeometry(0.034, 6, 5),
        matrix: partMatrix(sx, HORSE_LEG_TOP_Y, 0.18)
      });
    }

    return mergeGeometries(entries);
  });
  group.add(new THREE.Mesh(boneBodyGeo, boneMat));

  // --- neck group: bone + vertebra merged inside the neck's local frame -
  addNeck(group, boneMat);

  // --- head group: bone parts and dark parts merged inside head frame --
  addSkull(group, boneMat, darkMat);

  // --- tail group: four bone segments merged inside tail frame ---------
  addTail(group, boneMat);

  // --- legs: four pivots, never merged (they animate) ------------------
  addLegs(group, boneMat);

  // Same scale as the flesh mount: the rider sits at the same world height,
  // so the pick proxy and camera framing need no change.
  group.scale.setScalar(MOUNT_SCALE);
  group.userData.riderMountHeight = RIDER_MOUNT_HEIGHT;

  return group;
}

// Thin bony neck. Same anchor and tilt as the flesh mount's neck. The
// neck bone and every vertebra bump are rigidly attached inside the neck
// group and share one material, so they merge into a single mesh in the
// neck's local frame.
function addNeck(group, mat) {
  const neck = new THREE.Group();
  neck.position.set(0, NECK_CENTER_Y, NECK_CENTER_Z);
  neck.rotation.x = NECK_TILT_X;

  const neckGeo = cachedGeometry('skelHorse.neckGeo', () => {
    const entries = [
      { geometry: new THREE.CylinderGeometry(0.022, 0.038, NECK_LENGTH, 6) }
    ];
    for (let i = 0; i < VERTEBRA_COUNT; i++) {
      const t = i / (VERTEBRA_COUNT - 1);
      const yLocal = -NECK_LENGTH / 2 + VERTEBRA_INSET + t * VERTEBRA_SPAN;
      entries.push({
        geometry: new THREE.BoxGeometry(0.05, 0.018, 0.038),
        matrix: partMatrix(0, yLocal, 0)
      });
    }
    return mergeGeometries(entries);
  });
  neck.add(new THREE.Mesh(neckGeo, mat));

  group.add(neck);
}

// Horse skull. Three things carry the read:
//
//   1. A LONG TAPERED UPPER SKULL. Six-sided (not a box) so the facets
//      catch light as bone, tapered wide-at-the-back / narrow-at-the-front.
//   2. A SEPARATE LOWER JAW hanging below the upper skull with a visible
//      gap between them — the single strongest "this is a skull" cue.
//   3. Large, dark eye sockets and a single nasal opening.
//
// The upper skull and lower jaw share one material and merge into a single
// bone mesh; the eye sockets and nasal share a second material and merge
// into a single dark mesh. Both merges happen inside the head group's
// local frame, so the head's transform is preserved unchanged.
function addSkull(group, boneMat, darkMat) {
  const head = new THREE.Group();
  head.position.set(0, HEAD_CENTER_Y, HEAD_CENTER_Z);
  head.rotation.x = HEAD_TILT_X;

  const boneGeo = cachedGeometry('skelHorse.headBoneGeo', () =>
    mergeGeometries([
      {
        // Upper skull: one long tapered bone from cranium to nose. The +Y
        // end of the cylinder (radius 0.024) becomes the nose after
        // rotation; the -Y end (radius 0.040) becomes the cranium.
        // rotation.x = PI/2 lays the axis along +Z (forward); the +0.10
        // adds a slight downward tilt so the nose drops the way a horse's
        // head hangs.
        geometry: new THREE.CylinderGeometry(0.024, 0.040, 0.30, 6),
        matrix: partMatrix(0, 0, 0.02, Math.PI / 2 + 0.10, 0, 0)
      },
      {
        // Lower jaw (mandible): shorter, thinner, hanging below the upper
        // skull, tilted on the same 0.10 rad axis so the two run roughly
        // parallel with a thin consistent gap between them.
        geometry: new THREE.BoxGeometry(0.046, 0.028, 0.24),
        matrix: partMatrix(0, -0.070, 0.01, 0.10, 0, 0)
      }
    ])
  );
  head.add(new THREE.Mesh(boneGeo, boneMat));

  const darkGeo = cachedGeometry('skelHorse.headDarkGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.SphereGeometry(0.024, 6, 5),
        matrix: partMatrix(-0.045, 0.015, -0.05)
      },
      {
        geometry: new THREE.SphereGeometry(0.024, 6, 5),
        matrix: partMatrix(0.045, 0.015, -0.05)
      },
      {
        geometry: new THREE.BoxGeometry(0.04, 0.03, 0.03),
        matrix: partMatrix(0, -0.02, 0.16)
      }
    ])
  );
  head.add(new THREE.Mesh(darkGeo, darkMat));

  group.add(head);
}

// Tail: chain of shrinking bone spheres. Same anchor and droop angle as
// the flesh mount's tail. Merged into one mesh inside the tail group.
function addTail(group, mat) {
  const tail = new THREE.Group();
  tail.position.set(0, 0.48, -0.38);
  tail.rotation.x = -2.6;

  const tailGeo = cachedGeometry('skelHorse.tailGeo', () => {
    const entries = [];
    for (let i = 0; i < TAIL_SEGMENT_COUNT; i++) {
      const t = i / (TAIL_SEGMENT_COUNT - 1);
      const radius = 0.018 - t * 0.010;
      entries.push({
        geometry: new THREE.SphereGeometry(radius, 5, 4),
        matrix: partMatrix(0, t * TAIL_SEGMENT_SPAN, 0)
      });
    }
    return mergeGeometries(entries);
  });
  tail.add(new THREE.Mesh(tailGeo, mat));

  group.add(tail);
}

// Four stubby bone legs, each hanging from a shoulder/hip pivot so the view
// can swing them for a walk cycle. Same pivot Y and mesh offset as the flesh
// mount, so the trot cycle reads identically.
function addLegs(group, mat) {
  const legGeo = cachedGeometry('skelHorse.legGeo', () =>
    new THREE.CylinderGeometry(0.015, 0.012, HORSE_LEG_LENGTH, 5));

  const horseLegs = {};
  for (const lx of [-0.1, 0.1]) {
    for (const lz of [-0.18, 0.18]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, HORSE_LEG_TOP_Y, lz);

      const leg = new THREE.Mesh(legGeo, mat);
      leg.position.y = HORSE_LEG_MID_Y;
      pivot.add(leg);
      group.add(pivot);

      // End-first keying ('fl','fr','bl','br') so the view reads legs.fl /
      // legs.fr / legs.bl / legs.br naturally. Reversing this order silently
      // breaks the walk cycle — _horseLegs is truthy but every read is
      // undefined.
      const end = lz > 0 ? 'f' : 'b';
      const side = lx < 0 ? 'l' : 'r';
      horseLegs[end + side] = pivot;
    }
  }
  group.userData.horseLegs = horseLegs;
}
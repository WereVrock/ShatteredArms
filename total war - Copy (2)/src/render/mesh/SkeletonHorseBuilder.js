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
// Interface contract with SoldierView (MUST match HorseBuilder):
//   group.userData.horseLegs = { fl, fr, bl, br }  — leg pivots
//   group.userData.riderMountHeight = 0.50
//   group.scale = 1.4
//
// All geometries and both materials are cached (see MeshCache.js).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

// Palette matched to SkeletonBodyBuilder so rider and mount read as one
// material family. Both are cached — every skeleton horse shares them.
const BONE_COLOR = 0xe8e0c8;
const DARK_COLOR = 0x1a1408;

// Dimensions mirrored from HorseBuilder. Anything the rider position or the
// trot cycle depends on (mount height, leg pivot Y, leg mesh offset) must
// match exactly or the rider will float/sink relative to the flesh mount.
const BARREL_CENTER_Y = 0.42;
const BARREL_RADIUS = 0.15;
const BARREL_LENGTH = 0.72; // flesh capsule total: cylinder 0.42 + 2 × 0.15 radius

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
// Kept module-level so the two plate geometries are keyed identically and
// share one cached instance.
const PLATE_LENGTH = 0.242;
const PLATE_TILT_RAD = 0.427;

export function createSkeletonHorseBase() {
  const group = new THREE.Group();

  const boneMat = cachedMaterial('skelHorse.boneMat', () =>
    new THREE.MeshLambertMaterial({ color: BONE_COLOR }));
  const darkMat = cachedMaterial('skelHorse.darkMat', () =>
    new THREE.MeshLambertMaterial({ color: DARK_COLOR }));

  addRibcage(group, boneMat);
  addShoulders(group, boneMat);
  addLegs(group, boneMat);
  addNeck(group, boneMat);
  addSkull(group, boneMat, darkMat);
  addTail(group, boneMat);

  // Same scale as the flesh mount: the rider sits at the same world height,
  // so the pick proxy and camera framing need no change.
  group.scale.setScalar(MOUNT_SCALE);
  group.userData.riderMountHeight = RIDER_MOUNT_HEIGHT;

  return group;
}

// Ribcage + pelvis. The ribcage occupies only the front-middle of the body
// — a tight cluster of rings over the shoulder, tapering toward the rear,
// ending well short of the hind legs. Behind it, two bone plates bridge the
// spine's rear down-and-out to each hind-leg pivot, so the pelvis is what
// visually connects the spine to the hind legs. Without the pelvis, the
// ribs simply stop and the hind legs hang from air.
//
// A torus is authored in the XY plane with its hole axis along Z, so a
// stack of them already encircles the Z axis — no rotation needed. A full
// ring reads as a ribcage from the side view without any curved-rib
// geometry.
function addRibcage(group, mat) {
  // Spine: thin bone running the length of the skeleton, high on the back.
  // Ribs hang from it; pelvis attaches at the rear, withers and neck at the
  // front. Deliberately SHORTER than BARREL_LENGTH — the flesh mount's
  // barrel ends in rounded caps that don't need to go anywhere, but a bare
  // bone rod has to actually stop where the skeleton stops. Front end at
  // Z=+0.26 sits flush with the withers block's front face; rear end at
  // Z=-0.32 leaves a short lumbar stretch behind the pelvis before the
  // tail. Anything longer sticks out past the mount as a bare rod.
  const SPINE_FRONT_Z = 0.26;
  const SPINE_BACK_Z  = -0.32;
  const SPINE_LENGTH  = SPINE_FRONT_Z - SPINE_BACK_Z;
  const spineGeo = cachedGeometry('skelHorse.spineGeo', () =>
    new THREE.CylinderGeometry(0.022, 0.022, SPINE_LENGTH, 5));
  const spine = new THREE.Mesh(spineGeo, mat);
  spine.rotation.x = Math.PI / 2;
  spine.position.set(
    0,
    BARREL_CENTER_Y + BARREL_RADIUS - 0.03,
    (SPINE_FRONT_Z + SPINE_BACK_Z) / 2
  );
  group.add(spine);

  // Ribs: five rings over the front-middle of the body. The front rib is
  // the largest (at the shoulder, near the front-leg pivot at Z=+0.18);
  // each successive rib behind it is smaller, so the ribcage narrows toward
  // the pelvis the way a real ribcage does. The rear rib stops well clear
  // of the hind-leg pivot at Z=-0.18, leaving the lumbar gap that the
  // pelvis's ilium plates then bridge.
  const ribCount = 5;
  const ribFrontZ = 0.12;
  const ribBackZ = -0.10;
  for (let i = 0; i < ribCount; i++) {
    const t = ribCount === 1 ? 0 : i / (ribCount - 1);
    // 1.00 at the front, 0.55 at the back — the taper is what turns the
    // rings from a uniform barrel into a ribcage.
    const scale = 1 - t * 0.45;
    const ribGeo = cachedGeometry(`skelHorse.ribGeo.${i}`, () =>
      new THREE.TorusGeometry(BARREL_RADIUS * scale, 0.012, 5, 10));
    const rib = new THREE.Mesh(ribGeo, mat);
    const z = ribFrontZ + (ribBackZ - ribFrontZ) * t;
    rib.position.set(0, BARREL_CENTER_Y, z);
    group.add(rib);
  }

  // Pelvis: two bone plates bridging the spine's rear (X=0, Y=0.54) down
  // and outward to each hind-leg pivot (X=±0.10, Y=0.32, Z=-0.18). Each
  // plate is centred at the midpoint of that span and tilted to run along
  // it, so the rear silhouette reads as spine -> haunch -> leg rather than
  // as a barrel that simply ends.
  const plateGeo = cachedGeometry('skelHorse.plateGeo', () =>
    new THREE.BoxGeometry(0.025, PLATE_LENGTH, 0.10));
  for (const side of [-1, 1]) {
    const plate = new THREE.Mesh(plateGeo, mat);
    plate.position.set(side * 0.05, 0.43, -0.18);
    plate.rotation.z = side * PLATE_TILT_RAD;
    group.add(plate);
  }

  // Hip sockets: a small bone nub at each hind-leg pivot, capping the top
  // of the leg mesh and closing the joint with the ilium plate's lower
  // end. Without these the plate and the leg read as two disconnected
  // pieces meeting near — but not at — the same point.
  const socketGeo = cachedGeometry('skelHorse.legSocketGeo', () =>
    new THREE.SphereGeometry(0.05, 6, 5));
  for (const hx of [-0.10, 0.10]) {
    const socket = new THREE.Mesh(socketGeo, mat);
    socket.position.set(hx, HORSE_LEG_TOP_Y, -0.18);
    group.add(socket);
  }
}

// Shoulder girdle: the front mirror of the pelvis. Three pieces, all of
// which the mount was missing — without them, the neck hangs above a
// ribcage with no visible bone connecting the two, and the front legs
// dangle from bare pivots with nothing above them.
//
//   1. WITHERS VERTEBRA — a thick bone block that bridges the spine's
//      front end down to the neck cylinder's base. The neck's base sits
//      at world (0, 0.43, 0.11); the spine runs at Y=0.54. Without this
//      block there is a visible gap between the two, and the neck reads
//      as floating on top of the skeleton rather than growing out of it.
//      Sized to overlap both: Y 0.38..0.56, Z 0.10..0.26.
//   2. SCAPULA PLATES — one per side, mirroring the pelvis ilium plates.
//      Each runs from the spine's front (top end at world (0, 0.54, +0.18))
//      down and outward to its front-leg pivot (bottom end at
//      (±0.10, 0.32, +0.18)). Same geometry and same 0.427 rad tilt as
//      the pelvis plates — the shoulder and the haunch are structurally
//      identical in this build, which is what makes the two ends of the
//      horse read as the two ends of the same animal.
//   3. SHOULDER SOCKETS — a bone nub at each front-leg pivot, capping the
//      top of the leg mesh and closing the joint with the scapula plate's
//      lower end. Mirror of the hip sockets.
function addShoulders(group, mat) {
  // Withers vertebra. Tall (Y 0.38..0.56) and deep (Z 0.10..0.26) so it
  // merges with the spine above and swallows the neck's base below.
  const withersGeo = cachedGeometry('skelHorse.withersGeo', () =>
    new THREE.BoxGeometry(0.07, 0.18, 0.16));
  const withers = new THREE.Mesh(withersGeo, mat);
  withers.position.set(0, 0.47, 0.18);
  group.add(withers);

  // Scapula plates: same geometry and tilt as the pelvis ilium plates.
  const plateGeo = cachedGeometry('skelHorse.plateGeo', () =>
    new THREE.BoxGeometry(0.025, PLATE_LENGTH, 0.10));
  for (const side of [-1, 1]) {
    const plate = new THREE.Mesh(plateGeo, mat);
    plate.position.set(side * 0.05, 0.43, 0.18);
    plate.rotation.z = side * PLATE_TILT_RAD;
    group.add(plate);
  }

  // Shoulder sockets: mirror of the hip sockets.
  const socketGeo = cachedGeometry('skelHorse.legSocketGeo', () =>
    new THREE.SphereGeometry(0.05, 6, 5));
  for (const sx of [-0.10, 0.10]) {
    const socket = new THREE.Mesh(socketGeo, mat);
    socket.position.set(sx, HORSE_LEG_TOP_Y, 0.18);
    group.add(socket);
  }
}

// Four stubby bone legs, each hanging from a shoulder/hip pivot so the view
// can swing them for a walk cycle. Same pivot Y and mesh offset as the flesh
// mount, so the trot cycle reads identically.
function addLegs(group, mat) {
  const legGeo = cachedGeometry('skelHorse.legGeo', () =>
    new THREE.CylinderGeometry(0.03, 0.025, HORSE_LEG_LENGTH, 5));

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

// Thin bony neck. Same anchor and tilt as the flesh mount's neck. Vertebra
// bumps live in neck-local space so they follow the tilt automatically.
function addNeck(group, mat) {
  const neck = new THREE.Group();
  neck.position.set(0, NECK_CENTER_Y, NECK_CENTER_Z);
  neck.rotation.x = NECK_TILT_X;

  const neckBoneGeo = cachedGeometry('skelHorse.neckBoneGeo', () =>
    new THREE.CylinderGeometry(0.045, 0.07, NECK_LENGTH, 6));
  const neckBone = new THREE.Mesh(neckBoneGeo, mat);
  neck.add(neckBone);

  const vertebraGeo = cachedGeometry('skelHorse.vertebraGeo', () =>
    new THREE.BoxGeometry(0.07, 0.024, 0.05));
  const vertebraCount = 4;
  const vertebraInset = 0.04;
  const vertebraSpan = NECK_LENGTH - vertebraInset * 2;
  for (let i = 0; i < vertebraCount; i++) {
    const t = i / (vertebraCount - 1);
    const vertebra = new THREE.Mesh(vertebraGeo, mat);
    vertebra.position.y = -NECK_LENGTH / 2 + vertebraInset + t * vertebraSpan;
    neck.add(vertebra);
  }

  group.add(neck);
}

// Horse skull. Three things carry the read, all of which the previous
// build was missing:
//
//   1. A LONG TAPERED UPPER SKULL. Six-sided (not a box) so the facets
//      catch light as bone, and tapered wide-at-the-back / narrow-at-
//      the-front so the silhouette is a horse snout rather than a dog
//      muzzle. The whole axis tilts slightly downward along its length —
//      a horse's head hangs, it does not level out.
//   2. A SEPARATE LOWER JAW hanging below the upper skull with a visible
//      gap between them. A live horse's jaws are closed; a skull's are
//      not. The gap is the single strongest "this is a skull" cue at a
//      distance, more than the eye sockets.
//   3. Large, dark eye sockets placed where a horse's eye actually sits —
//      at the transition between cranium and snout, not front-and-center
//      like a human skull.
//
// Same head anchor and tilt as the flesh mount, so the rider-relative
// silhouette is unchanged.
function addSkull(group, boneMat, darkMat) {
  const head = new THREE.Group();
  head.position.set(0, HEAD_CENTER_Y, HEAD_CENTER_Z);
  head.rotation.x = HEAD_TILT_X;

  // Upper skull: one long tapered bone from cranium to nose. The +Y end of
  // the cylinder (radius 0.032) becomes the nose after rotation; the -Y end
  // (radius 0.052) becomes the cranium. rotation.x = PI/2 lays the axis
  // along +Z (forward); the +0.10 adds a slight downward tilt so the nose
  // drops toward the ground the way a horse's head hangs.
  const upperSkullGeo = cachedGeometry('skelHorse.upperSkullGeo', () =>
    new THREE.CylinderGeometry(0.032, 0.052, 0.30, 6));
  const upperSkull = new THREE.Mesh(upperSkullGeo, boneMat);
  upperSkull.rotation.x = Math.PI / 2 + 0.10;
  upperSkull.position.set(0, 0.0, 0.02);
  head.add(upperSkull);

  // Lower jaw (mandible): shorter, thinner, hanging below the upper skull.
  // Tilted on the same 0.10 rad axis as the upper skull so the two run
  // roughly parallel, leaving a thin consistent gap between them for the
  // mouth line. Thin (0.038 tall) so the gap dominates the silhouette
  // rather than reading as a second snout.
  const lowerJawGeo = cachedGeometry('skelHorse.lowerJawGeo', () =>
    new THREE.BoxGeometry(0.062, 0.038, 0.24));
  const lowerJaw = new THREE.Mesh(lowerJawGeo, boneMat);
  lowerJaw.rotation.x = 0.10;
  lowerJaw.position.set(0, -0.070, 0.01);
  head.add(lowerJaw);

  // Eye sockets: large dark recesses on the sides, sitting at the
  // transition between cranium and snout where a horse's eye actually is.
  // Generously sized so they still read as hollows at battle zoom — a
  // realistic-scale socket would be sub-pixel at typical camera distance.
  const socketGeo = cachedGeometry('skelHorse.eyeSocketGeo', () =>
    new THREE.SphereGeometry(0.030, 6, 5));
  for (const sx of [-0.045, 0.045]) {
    const socket = new THREE.Mesh(socketGeo, darkMat);
    socket.position.set(sx, 0.015, -0.05);
    head.add(socket);
  }

  // Nasal opening: a single dark recess at the tip of the upper skull.
  // Replaces the two nostril spheres — a horse skull's nasal aperture is a
  // large single opening, not two separate holes, and one bigger dark
  // shape orients the snout at a glance where two small ones just add
  // noise.
  const nasalGeo = cachedGeometry('skelHorse.nasalGeo', () =>
    new THREE.BoxGeometry(0.04, 0.03, 0.03));
  const nasal = new THREE.Mesh(nasalGeo, darkMat);
  nasal.position.set(0, -0.02, 0.16);
  head.add(nasal);

  group.add(head);
}

// Tail: chain of shrinking bone spheres. Same anchor and droop angle as the
// flesh mount's tail, but built in tail-local space so the spheres follow
// the droop without per-segment rotation math.
function addTail(group, mat) {
  const tail = new THREE.Group();
  tail.position.set(0, 0.48, -0.38);
  tail.rotation.x = -2.6;

  const segmentCount = 4;
  const segmentSpan = 0.22;
  for (let i = 0; i < segmentCount; i++) {
    const t = i / (segmentCount - 1);
    const radius = 0.035 - t * 0.018;
    const segmentGeo = cachedGeometry(`skelHorse.tailSegmentGeo.${i}`, () =>
      new THREE.SphereGeometry(radius, 5, 4));
    const segment = new THREE.Mesh(segmentGeo, mat);
    segment.position.y = t * segmentSpan;
    tail.add(segment);
  }

  group.add(tail);
}
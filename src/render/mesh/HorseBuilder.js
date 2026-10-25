// ===== src/render/mesh/HorseBuilder.js =====
// Horse mount: barrel body, neck, mane, blocky head, ears, tail, four
// pivoted legs. Scaled up 1.4x so the rider sits on something substantial.
//
// Every body-material part (chest, haunch, neck, head) is rigidly attached
// and shares one material, so they merge into a single mesh (see
// MeshMerge.js). Every dark-material part (mane, two ears, tail) merges
// into a second mesh. The four leg pivots stay separate groups — they
// animate. Net: two draw calls for the static body instead of ten, with
// zero visual change.
//
// The leg pivots are exposed on group.userData.horseLegs as an end-first
// keyed map ('fl','fr','bl','br') so SoldierView can drive a diagonal-trot
// walk cycle without re-deriving which pivot is which.
//
// Merged geometries are cached (see MeshCache.js); the two materials are
// cached as well — every horse in the game shares them.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

const HORSE_LEG_TOP_Y = 0.32;
const HORSE_LEG_MID_Y = -0.16;

const MOUNT_SCALE = 1.4;
const RIDER_MOUNT_HEIGHT = 0.50;

// CapsuleGeometry is only present in recent three.js builds. Detecting once
// at module load keeps the cached-geometry key stable across the session.
const HAS_CAPSULE = !!THREE.CapsuleGeometry;

export function createHorseBase() {
  const group = new THREE.Group();

  const bodyMat = cachedMaterial('horse.bodyMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));
  const darkMat = cachedMaterial('horse.darkMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a1a0e }));

  // --- body: chest + haunch + neck + head, merged into one mesh ---------
  //
  // Torso is two capsules, not one uniform barrel. A real horse has a
  // ribcage noticeably wider and taller than its hindquarters — a single
  // uniform capsule reads as a log. The front capsule is the chest and
  // ribcage; the rear capsule is the haunch, thinner and set slightly
  // lower so the topline dips toward the croup the way a horse's does.
  // The two overlap slightly so the join is seamless at battle zoom.
  //
  // Chest's top lands at Y=0.57, the same Y the old uniform barrel's top
  // did, so riderMountHeight (0.50) and every downstream number stays
  // correct by construction. Combined Z span matches the old barrel
  // exactly (−0.36 .. +0.36), so the leg pivots at Z=±0.18 and the neck
  // anchor still land where they already did.
  //
  // Haunch sizing note: the hind-leg pivot sits at (±0.10, 0.32, −0.18).
  // Distance from that pivot to the haunch's long axis is √(0.10² + 0.08²)
  // = 0.128 in the XY plane. The haunch radius MUST exceed 0.128 or the
  // leg top hangs in empty air — that is why the haunch is 0.14, not the
  // flesh cylinder's 0.12. The chest was never affected: pivot distance
  // there is √(0.10² + 0.09²) = 0.1345, comfortably inside its 0.16
  // radius.
  //
  // Chest sizing note: the chest's FRONT extent is what the neck has to
  // sit on top of. Neck base is at Z ≈ 0.11 and the head at Z = 0.42; if
  // the chest reaches past the neck, it bulges forward as a rounded lump
  // in front of the throat. The capsule reaches Z = +0.28, which sits
  // behind the neck base and below the head.
  const bodyGeo = cachedGeometry(
    `horse.bodyGeo.${HAS_CAPSULE ? 'cap' : 'cyl'}`,
    () => {
      const chestGeo = HAS_CAPSULE
        ? new THREE.CapsuleGeometry(0.16, 0.04, 4, 8)
        : new THREE.CylinderGeometry(0.16, 0.16, 0.36, 8);
      const haunchGeo = HAS_CAPSULE
        ? new THREE.CapsuleGeometry(0.14, 0.16, 4, 8)
        : new THREE.CylinderGeometry(0.14, 0.14, 0.44, 8);
      return mergeGeometries([
        { geometry: chestGeo,  matrix: partMatrix(0, 0.41,  0.10, Math.PI / 2, 0, 0) },
        { geometry: haunchGeo, matrix: partMatrix(0, 0.40, -0.16, Math.PI / 2, 0, 0) },
        {
          geometry: new THREE.CylinderGeometry(0.07, 0.11, 0.32, 6),
          matrix: partMatrix(0, 0.55, 0.22, 0.75, 0, 0)
        },
        {
          geometry: new THREE.BoxGeometry(0.12, 0.14, 0.24),
          matrix: partMatrix(0, 0.73, 0.42, 0.35, 0, 0)
        }
      ]);
    }
  );
  group.add(new THREE.Mesh(bodyGeo, bodyMat));

  // --- dark accents: mane + two ears + tail, merged into one mesh ------
  const darkGeo = cachedGeometry('horse.darkGeo', () =>
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
        geometry: new THREE.ConeGeometry(0.045, 0.22, 5),
        matrix: partMatrix(0, 0.48, -0.38, -2.6, 0, 0)
      }
    ])
  );
  group.add(new THREE.Mesh(darkGeo, darkMat));

  // --- four stubby legs, each hanging from a shoulder/hip pivot --------
  // Pivots stay separate meshes: the walk cycle rotates each pivot around
  // local X, so legs cannot be merged with anything else.
  const legGeo = cachedGeometry('horse.legGeo', () =>
    new THREE.CylinderGeometry(0.03, 0.025, 0.32, 5));

  const horseLegs = {};
  for (const lx of [-0.1, 0.1]) {
    for (const lz of [-0.18, 0.18]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, HORSE_LEG_TOP_Y, lz);

      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.y = HORSE_LEG_MID_Y;
      pivot.add(leg);
      group.add(pivot);

      // End-first keying ('fl','fr','bl','br') so the view can read
      // legs.fl / legs.fr / legs.bl / legs.br naturally. Reversing this
      // order silently breaks the walk cycle — _horseLegs is truthy but
      // every read is undefined.
      const end = lz > 0 ? 'f' : 'b';
      const side = lx < 0 ? 'l' : 'r';
      horseLegs[end + side] = pivot;
    }
  }
  group.userData.horseLegs = horseLegs;

  // Mounts read as mounts: scale the whole build up so the rider actually
  // sits on something substantial. 1.4x also sets the mount height below.
  group.scale.setScalar(MOUNT_SCALE);

  // Single source of truth for where a rider should sit on the mount's back.
  // The rider's butt (torso bottom on a blob, pelvis bottom on a skeleton —
  // both at body-local Y 0.25) must sit at or just below the barrel top
  // (barrel centre 0.42 + radius 0.15, scaled 1.4 → 0.798) so the rider reads
  // as straddling the mount rather than standing on it. 0.25 + 0.50 = 0.75,
  // sinking the butt ~0.05 into the barrel — enough to look seated, not so
  // much that the torso clips through.
  group.userData.riderMountHeight = RIDER_MOUNT_HEIGHT;

  return group;
}
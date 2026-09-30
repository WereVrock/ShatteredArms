// Horse mount: barrel body, neck, mane, blocky head, ears, tail, four pivoted
// legs. Scaled up 1.4x so the rider sits on something substantial.
//
// The leg pivots are exposed on group.userData.horseLegs as an end-first
// keyed map ('fl','fr','bl','br') so SoldierView can drive a diagonal-trot
// walk cycle without re-deriving which pivot is which.
//
// Geometries and materials are cached (see MeshCache.js) — every horse shares
// one set of body/dark materials and one instance of each primitive.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

export function createHorseBase() {
  const group = new THREE.Group();

  const bodyMat = cachedMaterial('horse.bodyMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));
  const darkMat = cachedMaterial('horse.darkMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a1a0e }));

  // Torso: two capsules, not one uniform barrel. A real horse has a
  // ribcage noticeably wider and taller than its hindquarters — a single
  // uniform capsule reads as a log. The front capsule is the chest and
  // ribcage; the rear capsule is the haunch, thinner and set slightly
  // lower so the topline dips toward the croup the way a horse's does.
  // The two overlap slightly so the join is seamless at battle zoom.
  //
  // Chest's top lands at Y=0.57, the same Y the old uniform barrel's top
  // did, so riderMountHeight (0.50) and every downstream number stays
  // correct by construction — the rider sinks into the seat by the same
  // ~0.05 it always did. Combined Z span matches the old barrel exactly
  // (−0.36 .. +0.36), so the leg pivots at Z=±0.18 and the neck anchor
  // still land where they already did.
  //
  // Haunch sizing note: the hind-leg pivot sits at (±0.10, 0.32, −0.18).
  // Distance from that pivot to the haunch's long axis is √(0.10² + 0.08²)
  // = 0.128 in the XY plane. The haunch radius MUST exceed 0.128 or the leg
  // top hangs in empty air — which is exactly what happened at the previous
  // radius 0.12 centered at Y 0.42 (pivot distance was 0.141). Current
  // radius 0.14 at Y 0.40 encloses the pivot by ~0.012, so the leg reads as
  // emerging from the haunch. The chest was never affected: pivot distance
  // there is √(0.10² + 0.09²) = 0.1345, comfortably inside its 0.16 radius.
  //
  // Chest sizing note: the chest's FRONT extent is what the neck has to sit
  // on top of. Neck base is at Z ≈ 0.11 and the head at Z = 0.42; if the
  // chest reaches past the neck, it bulges forward as a rounded lump in
  // front of the throat. Old chest (cyl 0.12, radius 0.16, centered at
  // Z=0.14) reached Z = +0.36 — 0.03 past the neck's front. Now: cyl 0.04,
  // centered Z=0.10, reaching Z = +0.28, which sits behind the neck base
  // and below the head. Rear end held at the same Z = −0.08 so overlap
  // with the haunch (which reaches Z = +0.06) is preserved.
  let chest, haunch;
  if (THREE.CapsuleGeometry) {
    chest = new THREE.Mesh(
      cachedGeometry('horse.chestCapsuleGeo', () =>
        new THREE.CapsuleGeometry(0.16, 0.04, 4, 8)),
      bodyMat
    );
    haunch = new THREE.Mesh(
      cachedGeometry('horse.haunchCapsuleGeo', () =>
        new THREE.CapsuleGeometry(0.14, 0.16, 4, 8)),
      bodyMat
    );
  } else {
    // Fallback for three.js builds without CapsuleGeometry. Same layout,
    // just boxy — the shape read is unchanged at battle zoom.
    chest = new THREE.Mesh(
      cachedGeometry('horse.chestCylGeo', () =>
        new THREE.CylinderGeometry(0.16, 0.16, 0.36, 8)),
      bodyMat
    );
    haunch = new THREE.Mesh(
      cachedGeometry('horse.haunchCylGeo', () =>
        new THREE.CylinderGeometry(0.14, 0.14, 0.44, 8)),
      bodyMat
    );
  }
  chest.rotation.x = Math.PI / 2;
  chest.position.set(0, 0.41, 0.10);
  group.add(chest);

  haunch.rotation.x = Math.PI / 2;
  haunch.position.set(0, 0.40, -0.16);
  group.add(haunch);

  // Four stubby legs, each hanging from a shoulder/hip pivot so the view can
  // swing them for a walk cycle. Each leg mesh is offset down inside its
  // pivot, so rotating the pivot around local X swings the leg from the top
  // rather than from the leg's midpoint. Final visual position is unchanged
  // (pivot at Y=0.32, mesh centre at Y=0.16 — the leg still occupies
  // Y 0..0.32).
  const legGeo = cachedGeometry('horse.legGeo', () =>
    new THREE.CylinderGeometry(0.03, 0.025, 0.32, 5));
  const HORSE_LEG_TOP_Y = 0.32;
  const HORSE_LEG_MID_Y = -0.16;

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

  // Neck rising forward out of the front of the barrel.
  const neckGeo = cachedGeometry('horse.neckGeo', () =>
    new THREE.CylinderGeometry(0.07, 0.11, 0.32, 6));
  const neck = new THREE.Mesh(neckGeo, bodyMat);
  neck.position.set(0, 0.55, 0.22);
  neck.rotation.x = 0.75;
  group.add(neck);

  // Dark mane strip running up the back of the neck.
  const maneGeo = cachedGeometry('horse.maneGeo', () =>
    new THREE.BoxGeometry(0.04, 0.05, 0.32));
  const mane = new THREE.Mesh(maneGeo, darkMat);
  mane.position.set(0, 0.62, 0.16);
  mane.rotation.x = 0.75;
  group.add(mane);

  // Head: small blocky muzzle tilted forward off the top of the neck.
  const headGeo = cachedGeometry('horse.headGeo', () =>
    new THREE.BoxGeometry(0.12, 0.14, 0.24));
  const head = new THREE.Mesh(headGeo, bodyMat);
  head.position.set(0, 0.73, 0.42);
  head.rotation.x = 0.35;
  group.add(head);

  // Ears.
  const earGeo = cachedGeometry('horse.earGeo', () =>
    new THREE.ConeGeometry(0.022, 0.07, 4));
  for (const ex of [-0.04, 0.04]) {
    const ear = new THREE.Mesh(earGeo, darkMat);
    ear.position.set(ex, 0.84, 0.37);
    group.add(ear);
  }

  // Tail drooping off the back of the barrel.
  const tailGeo = cachedGeometry('horse.tailGeo', () =>
    new THREE.ConeGeometry(0.045, 0.22, 5));
  const tail = new THREE.Mesh(tailGeo, darkMat);
  tail.position.set(0, 0.48, -0.38);
  tail.rotation.x = -2.6;
  group.add(tail);

  // Mounts read as mounts: scale the whole build up so the rider actually
  // sits on something substantial. 1.4x also sets the mount height below.
  const MOUNT_SCALE = 1.4;
  group.scale.setScalar(MOUNT_SCALE);

  // Single source of truth for where a rider should sit on the mount's back.
  // The rider's butt (torso bottom on a blob, pelvis bottom on a skeleton —
  // both at body-local Y 0.25) must sit at or just below the barrel top
  // (barrel centre 0.42 + radius 0.15, scaled 1.4 → 0.798) so the rider reads
  // as straddling the mount rather than standing on it. 0.25 + 0.50 = 0.75,
  // sinking the butt ~0.05 into the barrel — enough to look seated, not so
  // much that the torso clips through. The rider's legs, straddled by
  // SoldierView._applyWalkCycle, then drape down the barrel sides from here.
  group.userData.riderMountHeight = 0.50;

  return group;
}
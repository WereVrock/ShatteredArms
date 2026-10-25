// ===== BeastMountBuilder.js =====
// ===== src/render/mesh/BeastMountBuilder.js =====
// Reptilian boar hybrid mount for the Goblin Warlord's beast-riders.
// Internally called the "tuskbeast".
//
// LOW, BULKY, MONSTROUS. The mount's back sits at roughly hobgoblin waist
// height (world Y ≈ 0.59), so the rider perches low and almost fights on
// foot — matching the "mounted but NOT cavalry" battlefield role of the
// hobgoblin retinue (see UnitClasses.isMounted).
//
// FOOTPRINT MATCHES THE HORSE. Body length (nose-to-tail) is sized to
// match HorseBuilder's ~0.92 unscaled units, so swapping a horse for a
// tuskbeast is a visual change, not a spatial one — the pick proxy, the
// rider seat, and the shadow bound all keep their tuned values. If the
// body is ever re-lengthed, re-check against HorseBuilder.createHorseBase.
//
// HEAD SCALE. The skull box is small relative to the barrel — a compact
// head on a heavy body, which reads as a squat brutish predator rather
// than a boar with a bus-sized snout. The muzzle box is sized separately
// (SNOUT_*), but stays proportionally narrower than the skull so the
// head still reads as one shape, not a box on a box.
//
// MONSTROUS FACE. The face is deliberately NOT a flat box-snout. The
// pieces that turn it from "cube with a snout" (which reads as a
// Minecraft pig at battle zoom) into something that reads as a predator:
//   - a heavy brow ridge overhanging the eyes, casting a shadow across
//     the sockets below it
//   - WIDE, angular eyes set back under the brow (not small square dots)
//   - a lower jaw hung BELOW the snout with a dark mouth-shadow band
//     filling the gap between them
//   - upward-sweeping tusks from the sides of the jaw
//   - swept-back horns from the top of the skull
//   - short downward fangs at the front of the upper jaw
// Every one of those is a silhouette change that survives to battle zoom.
//
// INTERFACE CONTRACT (must match HorseBuilder.createHorseBase exactly):
//   group.userData.horseLegs     = { fl, fr, bl, br }  — leg pivots
//   group.userData.riderMountHeight = <world Y for the rider's seat>
//   group.scale = 1.4
//
// The key name is `horseLegs` even on a beast mount, because SoldierView
// drives both mounts through the same trot-cycle code path.
//
// Geometries and materials are cached (see MeshCache.js) — every beast in
// the game shares them.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

const MOUNT_SCALE = 1.4;
// Body top at unscaled 0.42 → world 0.588. Rider leg pivot (LEG_HIP_Y 0.30
// in rider-local) lands at rider origin + 0.30. 0.588 − 0.30 = 0.288, minus
// the standard ~0.038 sink → 0.25. Same sink depth the horse uses.
const RIDER_MOUNT_HEIGHT = 0.25;

// HAS_CAPSULE mirrors HorseBuilder's capability probe so the cached
// geometry key stays stable across the session.
const HAS_CAPSULE = !!THREE.CapsuleGeometry;

// --- body layout (unscaled local units) ---------------------------------
//
// Footprint target: nose-to-tail ≈ 0.96, matching the horse's ≈ 0.92.

const BODY_CENTER_Y = 0.24;      // barrel centre; top at 0.24 + 0.18 = 0.42
const BODY_CENTER_Z = 0.06;
const BODY_LENGTH   = 0.50;
const BODY_WIDTH    = 0.36;

const HAUNCH_Y = 0.22;
const HAUNCH_Z = -0.22;
const HAUNCH_W = 0.30;
const HAUNCH_D = 0.34;

// --- head ---------------------------------------------------------------
//
// Small, heavy-boned skull. Box is narrower and shallower than the barrel,
// so the head reads as compact relative to the body. A heavy brow ridge
// overhangs the eyes; the snout is narrower still and protrudes forward;
// the lower jaw hangs below the snout with a visible gap.

const HEAD_Y = 0.34;
const HEAD_Z = 0.34;
const HEAD_W = 0.26;
const HEAD_H = 0.20;
const HEAD_D = 0.17;

const BROW_Y = 0.40;
const BROW_Z = 0.42;
const BROW_H = 0.07;
const BROW_D = 0.10;

const SNOUT_Y = 0.27;
const SNOUT_Z = 0.46;
const SNOUT_W = 0.20;
const SNOUT_H = 0.15;
const SNOUT_D = 0.16;

const JAW_Y = 0.17;
const JAW_Z = 0.46;
const JAW_W = 0.18;
const JAW_H = 0.07;
const JAW_D = 0.16;

// --- horns / tusks / fangs ----------------------------------------------
//
// Horns sweep back from the top of the skull; tusks sweep up-and-out from
// the jaw; fangs point down from the front of the upper jaw.

const HORN_BASE_X = 0.10;
const HORN_BASE_Y = 0.43;
const HORN_BASE_Z = 0.30;
const HORN_LENGTH = 0.24;
const HORN_RADIUS = 0.045;

const TUSK_BASE_X = 0.095;
const TUSK_BASE_Y = 0.20;
const TUSK_BASE_Z = 0.50;
const TUSK_LENGTH = 0.22;
const TUSK_RADIUS = 0.038;

const FANG_RADIUS = 0.012;
const FANG_LENGTH = 0.06;

// --- spinal ridge -------------------------------------------------------

const RIDGE_COUNT   = 5;
const RIDGE_FRONT_Z = 0.20;
const RIDGE_BACK_Z  = -0.26;
// Ridge base Y is derived per-plate at build time from the mount's
// actual surface (see topSurfaceYAtZ below). A single constant here
// would sit correctly only at the barrel's midpoint — past the barrel's
// cylinder the top curves down, and past its back-end the visible
// surface is the lower haunch, so a fixed base leaves the front and
// back plates floating.

// --- tail ---------------------------------------------------------------

const TAIL_Y = 0.22;
const TAIL_Z = -0.38;
const TAIL_W = 0.08;
const TAIL_H = 0.06;
const TAIL_D = 0.18;

// --- legs (short, stubby) -----------------------------------------------
//
// LEG_TOP_Y = LEG_LENGTH means the leg mesh's bottom lands exactly on the
// ground plane when the mount is unscaled. Short legs + low body is what
// produces the "rider almost walks" silhouette the user asked for.

const LEG_TOP_Y      = 0.24;
const LEG_MID_Y      = -0.12;
const LEG_LENGTH     = 0.24;
const LEG_RADIUS_TOP = 0.055;
const LEG_RADIUS_BOT = 0.045;

// --- palette ------------------------------------------------------------

const FLESH_COLOR = 0x4a4a2a;   // dark olive-brown, reptilian/boar
const DARK_COLOR  = 0x0a0a08;   // near-black, deeper than the old 0x1a1a10
const BONE_COLOR  = 0xd8d0b0;   // tusks + horns + ridge + fangs

// ========================================================================

// Top-of-mount Y at a given Z, in the mount's local (unscaled) frame.
// The body is two capsules laid along Z:
//   barrel  — center (0, BODY_CENTER_Y, BODY_CENTER_Z), radius BODY_WIDTH/2,
//             cylindrical section length (BODY_LENGTH - BODY_WIDTH)
//   haunch  — center (0, HAUNCH_Y, HAUNCH_Z), radius HAUNCH_W/2,
//             cylindrical section length (HAUNCH_D - HAUNCH_W)
// A point on the top centerline at Z has Y = centerY + sqrt(r² − d²),
// where d is the distance from Z to the capsule's cylindrical section
// (0 while Z is inside the section, growing once Z passes an end). The
// function returns the higher of the two samples, which is always the
// visible surface at that Z. Used to seat the spinal-ridge plates on
// the mount instead of at a fixed Y.
function topSurfaceYAtZ(z) {
  const sampleCapsule = (centerY, centerZ, radius, cylHalfLen) => {
    const dz = z - centerZ;
    const clamped = Math.max(-cylHalfLen, Math.min(cylHalfLen, dz));
    const d = dz - clamped;
    const sq = radius * radius - d * d;
    return sq > 0 ? centerY + Math.sqrt(sq) : -Infinity;
  };
  const barrel = sampleCapsule(
    BODY_CENTER_Y, BODY_CENTER_Z,
    BODY_WIDTH / 2, (BODY_LENGTH - BODY_WIDTH) / 2
  );
  const haunch = sampleCapsule(
    HAUNCH_Y, HAUNCH_Z,
    HAUNCH_W / 2, (HAUNCH_D - HAUNCH_W) / 2
  );
  return Math.max(barrel, haunch);
}

export function createBeastMount() {
  const group = new THREE.Group();

  const fleshMat = cachedMaterial('beast.fleshMat', () =>
    new THREE.MeshLambertMaterial({ color: FLESH_COLOR }));
  const darkMat = cachedMaterial('beast.darkMat', () =>
    new THREE.MeshLambertMaterial({ color: DARK_COLOR }));
  const boneMat = cachedMaterial('beast.boneMat', () =>
    new THREE.MeshLambertMaterial({ color: BONE_COLOR }));

  // --- flesh body: barrel + haunch + skull + brow + snout + jaw + tail ---
  const bodyGeo = cachedGeometry(
    `beast.bodyGeo.${HAS_CAPSULE ? 'cap' : 'cyl'}`,
    () => {
      const barrelGeo = HAS_CAPSULE
        ? new THREE.CapsuleGeometry(BODY_WIDTH / 2, BODY_LENGTH - BODY_WIDTH, 4, 10)
        : new THREE.CylinderGeometry(BODY_WIDTH / 2, BODY_WIDTH / 2, BODY_LENGTH, 10);
      const haunchGeo = HAS_CAPSULE
        ? new THREE.CapsuleGeometry(HAUNCH_W / 2, HAUNCH_D - HAUNCH_W, 4, 10)
        : new THREE.CylinderGeometry(HAUNCH_W / 2, HAUNCH_W / 2, HAUNCH_D, 10);

      return mergeGeometries([
        // Main barrel: low, bulky, from front shoulder through haunch.
        { geometry: barrelGeo,
          matrix: partMatrix(0, BODY_CENTER_Y, BODY_CENTER_Z, Math.PI / 2, 0, 0) },
        // Haunch: slightly smaller rear volume, meeting the barrel.
        { geometry: haunchGeo,
          matrix: partMatrix(0, HAUNCH_Y, HAUNCH_Z, Math.PI / 2, 0, 0) },
        // Skull: compact broad block, slight forward tilt.
        { geometry: new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D),
          matrix: partMatrix(0, HEAD_Y, HEAD_Z, 0.10, 0, 0) },
        // Brow ridge: a heavy overhang above the eyes. The single strongest
        // "predator, not livestock" read on the skull — it casts a shadow
        // across the deep-set eye sockets and breaks the flat box silhouette.
        { geometry: new THREE.BoxGeometry(HEAD_W + 0.02, BROW_H, BROW_D),
          matrix: partMatrix(0, BROW_Y, BROW_Z, 0.05, 0, 0) },
        // Snout: narrower than the skull, protruding forward and slightly down.
        { geometry: new THREE.BoxGeometry(SNOUT_W, SNOUT_H, SNOUT_D),
          matrix: partMatrix(0, SNOUT_Y, SNOUT_Z, -0.05, 0, 0) },
        // Lower jaw: hangs below the snout with a visible gap. The gap is
        // filled by the dark mouth band (below), so the mouth reads as a
        // closed predator's jaw line, not as a box on a box.
        { geometry: new THREE.BoxGeometry(JAW_W, JAW_H, JAW_D),
          matrix: partMatrix(0, JAW_Y, JAW_Z, 0.05, 0, 0) },
        // Tail: short, drooping, at the rear.
        { geometry: new THREE.BoxGeometry(TAIL_W, TAIL_H, TAIL_D),
          matrix: partMatrix(0, TAIL_Y, TAIL_Z, -0.35, 0, 0) }
      ]);
    }
  );
  group.add(new THREE.Mesh(bodyGeo, fleshMat));

  // --- bone: horns + tusks + fangs + spinal ridge, all merged ----------
  //
  // All four are bone-coloured and rigidly attached, so one mesh covers
  // them all. The three facial pieces (horns, tusks, fangs) are what turn
  // the head from a block with a box-snout into a monstrous silhouette
  // at battle zoom.
  const boneGeo = cachedGeometry('beast.boneGeo', () => {
    const entries = [];

    // Horns: swept back and outward from the top of the skull, behind the
    // brow. Each is a six-sided cone tilted backward (-1.0 rad around X)
    // and outward (side * -0.35 around Z).
    for (const side of [-1, 1]) {
      entries.push({
        geometry: new THREE.ConeGeometry(HORN_RADIUS, HORN_LENGTH, 6),
        matrix: partMatrix(
          side * HORN_BASE_X,
          HORN_BASE_Y,
          HORN_BASE_Z,
          -1.0, 0, side * -0.35
        )
      });
    }

    // Tusks: from the sides of the lower jaw, curving up and outward. A
    // single tilted cone per side — at battle zoom the tilt reads as a
    // curve without needing a curved tube.
    for (const side of [-1, 1]) {
      entries.push({
        geometry: new THREE.ConeGeometry(TUSK_RADIUS, TUSK_LENGTH, 6),
        matrix: partMatrix(
          side * TUSK_BASE_X,
          TUSK_BASE_Y,
          TUSK_BASE_Z,
          0.20, 0, side * -0.55
        )
      });
    }

    // Fangs: two per side, pointing down from the upper jaw at the front
    // of the snout. Small, but they break the mouth line where the eye
    // naturally lands.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        entries.push({
          geometry: new THREE.ConeGeometry(FANG_RADIUS, FANG_LENGTH, 4),
          matrix: partMatrix(
            side * (0.055 + i * 0.020),
            SNOUT_Y - 0.080,
            SNOUT_Z - 0.030 + i * 0.055,
            Math.PI, 0, 0
          )
        });
      }
    }

    // Spinal ridge: bone plates along the back. Taller in the middle,
    // shorter at the ends — a gentle arch. The strongest "this is not a
    // horse" cue at silhouette distance.
    //
    // Each plate's base is seated on the mount's actual top surface at
    // that Z (see topSurfaceYAtZ above), sunk 0.015 below it so the
    // plate's base is buried regardless of which of the two capsules is
    // the surface there. The previous fixed RIDGE_BASE_Y worked at the
    // barrel's midpoint but left the front and back plates visibly
    // floating — past the barrel's cylinder section the surface curves
    // down, and past the barrel's back-end the visible surface is the
    // lower haunch. Sampling per-plate attaches every spike, and the
    // resulting ridge naturally follows the mount's own topline dip
    // toward the croup.
    for (let i = 0; i < RIDGE_COUNT; i++) {
      const t = i / (RIDGE_COUNT - 1);
      const z = RIDGE_FRONT_Z + (RIDGE_BACK_Z - RIDGE_FRONT_Z) * t;
      const falloff = Math.sin((t * 0.8 + 0.1) * Math.PI);
      const h = 0.06 + 0.06 * falloff;
      const baseY = topSurfaceYAtZ(z) - 0.015;
      entries.push({
        geometry: new THREE.ConeGeometry(0.030, h, 3),
        matrix: partMatrix(0, baseY + h / 2, z)
      });
    }

    return mergeGeometries(entries);
  });
  group.add(new THREE.Mesh(boneGeo, boneMat));

  // --- dark: deep eyes + nostril slits + mouth shadow ------------------
  //
  // Four dark features, all merged into one mesh. The eyes are deliberately
  // WIDE and angular (not the old small squares) — under the brow ridge
  // they read as deep-set sockets rather than as painted-on dots. The mouth
  // band sits in the gap between snout and jaw and reads as the shadow
  // line of a closed predator's mouth.
  const darkGeo = cachedGeometry('beast.darkGeo', () =>
    mergeGeometries([
      // Eyes: wide, angular, forward-facing under the brow ridge. Sized to
      // the shrunk skull — the two eyes should not run past the sides of
      // the box, or they read as stickers rather than sockets.
      { geometry: new THREE.BoxGeometry(0.060, 0.038, 0.040),
        matrix: partMatrix(-0.062, HEAD_Y + 0.02, HEAD_Z + HEAD_D / 2 - 0.01) },
      { geometry: new THREE.BoxGeometry(0.060, 0.038, 0.040),
        matrix: partMatrix(0.062, HEAD_Y + 0.02, HEAD_Z + HEAD_D / 2 - 0.01) },
      // Nostril slits at the tip of the snout.
      { geometry: new THREE.BoxGeometry(0.025, 0.020, 0.020),
        matrix: partMatrix(-0.045, SNOUT_Y + 0.020, SNOUT_Z + SNOUT_D / 2 - 0.02) },
      { geometry: new THREE.BoxGeometry(0.025, 0.020, 0.020),
        matrix: partMatrix(0.045, SNOUT_Y + 0.020, SNOUT_Z + SNOUT_D / 2 - 0.02) },
      // Mouth band: the shadow gap between the upper snout and lower jaw.
      { geometry: new THREE.BoxGeometry(JAW_W + 0.01, 0.015, JAW_D + 0.01),
        matrix: partMatrix(0, SNOUT_Y - 0.085, SNOUT_Z + 0.005) }
    ])
  );
  group.add(new THREE.Mesh(darkGeo, darkMat));

  // --- four stubby legs, each on a pivot (trot-cycle contract) ----------
  const legGeo = cachedGeometry('beast.legGeo', () =>
    new THREE.CylinderGeometry(LEG_RADIUS_TOP, LEG_RADIUS_BOT, LEG_LENGTH, 5));

  const horseLegs = {};
  for (const lx of [-0.12, 0.12]) {
    for (const lz of [-0.20, 0.16]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, LEG_TOP_Y, lz);

      const leg = new THREE.Mesh(legGeo, fleshMat);
      leg.position.y = LEG_MID_Y;
      pivot.add(leg);
      group.add(pivot);

      const end = lz > 0 ? 'f' : 'b';
      const side = lx < 0 ? 'l' : 'r';
      horseLegs[end + side] = pivot;
    }
  }
  group.userData.horseLegs = horseLegs;

  // Same scale as the horse — the shared trot cycle, shadow bounds, and
  // pick-proxy sizing are all tuned against it.
  group.scale.setScalar(MOUNT_SCALE);

  group.userData.riderMountHeight = RIDER_MOUNT_HEIGHT;

  // Mounted-leg pose overrides. The beast's body is wider than the
  // horse's barrel (scaled half-width 0.252 vs 0.224) and its rider
  // seat is lower relative to the back, so the horse-tuned splay alone
  // leaves the knee inside the body — the shin emerges from inside the
  // mount and reads as clipping. The rider's leg therefore needs to
  // wrap the mount in four steps, not two:
  //
  //   1. Hip pivot translates outward (X) AND forward (Z), so the knee
  //      sits in front of the mount's widest point rather than beside
  //      it.
  //   2. Thigh splays out (Z) AND pitches forward (X) — the knee ends
  //      up out in front of the barrel, the classic rider's knee.
  //   3. Knee counter-rotates the splay to zero (Z) — the shin does
  //      not inherit the thigh's outward twist.
  //   4. Knee tilts the shin backward past vertical (X) — the ankle
  //      drops below and slightly behind the knee, matching how a real
  //      rider's lower leg hangs.
  //
  // All five values below are read every frame by
  // SoldierView._applyWalkCycle, which composes them with Euler order
  // 'ZYX' so the forward and backward pitches stay in the body frame.
  // These are the single place to retune the beast's mounted stance if
  // the mount is ever re-shaped.
  group.userData.riderThighOutRad     = 1.20;  // thigh splay (Z), rad
  group.userData.riderThighOutX       = 0.06;  // hip outward offset, world units
  group.userData.riderThighForwardZ   = 0.06;  // hip forward offset, world units
  group.userData.riderThighForwardRad = 0.40;  // thigh forward pitch (X), rad
  group.userData.riderShinBackRad     = 0.55;  // shin backward pitch (X), rad

  return group;
}
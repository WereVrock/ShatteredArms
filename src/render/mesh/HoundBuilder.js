// ===== src/render/mesh/HoundBuilder.js =====
// ===== src/render/mesh/HoundBuilder.js =====
// Goblin war hound: a low, gaunt quadruped with a wedge skull, red
// glowing eyes, upper canines, and a row of bone spikes down the spine.
// Used as a riderless mount for the goblinHound unit type.
//
// WHY A "MOUNT" AND NOT A "BODY"
// The goblinHound is a companion creature (see UnitTypes.goblinHound) —
// it is driven by HoundSystem, has no rider, no weapon, and no issued
// gear. The composer already has a "riderless mount" path
// (bodyVariant === 'riderlessBeast') that skips the body mesh and the
// weapon entirely, and hands the whole visual weight to whatever
// `mountType` builder the UnitType declares. Giving hounds their own
// `mountType: 'hound'` therefore costs almost nothing: the hound model
// slots into the existing path, gets the existing leg-pivot trot cycle
// from SoldierView._applyHorseWalkCycle, and needs no changes to the
// composer's body-handling or weapon-handling.
//
// SIZE
// At MOUNT_SCALE 1.4 the hound reads as a war-hound-sized creature:
// roughly 1.5 world units nose-to-tail and ~0.55 world units tall at
// the head. That is bigger than the live soldier's lower leg but
// clearly shorter than a full-sized beast mount, matching the sim's
// collisionRadius 0.35 and mass 0.25 (a heavy dog, not a warhorse).
//
// SILHOUETTE — what makes it "creepy" rather than "cute"
//   - Hunched stance: chest Y is above haunch Y, and the neck arcs
//     forward-and-up into the skull, so the head is carried LOW. Reads
//     as predatory focus, not a relaxed pet.
//   - Wedge skull with a heavy brow overhang. The brow casts a shadow
//     across the eye sockets at any sun angle — the sockets never
//     render flat-on.
//   - Red glowing eyes (MeshBasicMaterial) inside near-black sockets.
//     At battle zoom this is a red dot the camera almost doesn't
//     register — but on close inspection it's a bright crimson eye.
//   - Bone spikes down the spine: five cones of decreasing height from
//     mid-back toward the tail. Same "not a farm animal" language the
//     beast mount's ridge uses, sized for a dog's topline.
//   - Prominent upper canines and lower fangs, mouth band visible
//     between snout and jaw. The teeth sit IN FRONT of the mouth dark
//     band (at the snout front), so even a closed-mouth frame reads
//     as a snarl.
//   - Laid-back pointed ears (a dog's warning cue).
//   - Thin, drooping whip tail. A curled-over-the-back tail would read
//     as a friendly retriever; a drooped tail reads as threat.
//
// INTERFACE CONTRACT (must match HorseBuilder.createHorseBase and
// BeastMountBuilder.createBeastMount):
//   group.userData.horseLegs = { fl, fr, bl, br }  — leg pivots
//   group.userData.riderMountHeight = <world Y for the rider's seat>
//   group.scale = 1.4
//
// `riderMountHeight` is provided even though the hound is riderless —
// the composer sets `rider.position.y = horseBase.userData.riderMountHeight`
// and a null value would leave a standing rider at Y=0, which is wrong
// for any future case where a hound is (unusually) mounted. 0.30 is
// the hound's shoulder height, which is the natural seat for a
// hypothetical tiny rider.
//
// Geometries and materials are cached (see MeshCache.js) — every hound
// in the game shares them.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

const MOUNT_SCALE = 1.4;

// Seat height for a hypothetical rider. Not consumed by the current
// hound units (they are riderless), but declared so the composer's
// `rider.position.y = horseBase.userData.riderMountHeight ?? 0` path
// lands the rider sensibly if a future type ever mounts one.
const RIDER_MOUNT_HEIGHT = 0.30;

// CapsuleGeometry is present in recent three.js builds. Detecting once
// keeps the cached-geometry key stable across the session, same
// convention BeastMountBuilder and HorseBuilder use.
const HAS_CAPSULE = !!THREE.CapsuleGeometry;

// --- body layout (unscaled local units) ---------------------------------
//
// Every dimension below is authored assuming MOUNT_SCALE 1.4 will be
// applied to the whole group at the end. At 1.4 the numbers above give
// the war-hound footprint described in the file header.

const CHEST_Y = 0.26;       // barrel centre; top at 0.36
const CHEST_Z = 0.06;
const CHEST_RADIUS = 0.10;  // half-width of the chest
const CHEST_CYL_LEN = 0.20; // cylindrical section of the chest capsule

const HAUNCH_Y = 0.24;      // slight downturn from chest — subtle hunch
const HAUNCH_Z = -0.16;
const HAUNCH_RADIUS = 0.09;
const HAUNCH_CYL_LEN = 0.14;

// --- neck / head --------------------------------------------------------
//
// The neck is a tapered cylinder arcing forward-and-up from the chest
// front. NECK_TILT is the pitch applied around X: 0.9 rad ≈ 51° tips
// the top of the neck toward +Z (forward) and slightly up, matching a
// hunting dog's forward gaze.

const NECK_Y = 0.34;
const NECK_Z = 0.26;
const NECK_TILT_RAD = 0.9;
const NECK_LEN = 0.20;

const SKULL_Y = 0.40;
const SKULL_Z = 0.40;
const SKULL_W = 0.15;
const SKULL_H = 0.12;
const SKULL_D = 0.16;

// Heavy brow ridge overhanging the eyes. Tilted slightly forward so its
// front edge is LOWER than its back — the defensive-overhang read the
// beast mount's brow uses, scaled down for a dog's skull.
const BROW_Y = SKULL_Y + 0.04;
const BROW_Z = SKULL_Z - 0.02;
const BROW_W = SKULL_W + 0.01;
const BROW_H = 0.04;
const BROW_D = 0.06;

// Snout: narrower and lower than the skull, protruding forward and
// tipped slightly down. The narrowness is what carries the "wedge"
// read — a box of the same width as the skull would read as a pig.
const SNOUT_Y = SKULL_Y - 0.04;
const SNOUT_Z = SKULL_Z + 0.12;
const SNOUT_W = 0.09;
const SNOUT_H = 0.09;
const SNOUT_D = 0.14;

// Lower jaw: hangs BELOW the snout with a visible gap. The gap is
// filled by a dark mouth band (see dark mesh below) so the closed mouth
// reads as a predator's jaw line rather than as two boxes with a
// hole between them.
const JAW_Y = SNOUT_Y - 0.06;
const JAW_Z = SNOUT_Z;
const JAW_W = 0.07;
const JAW_H = 0.04;
const JAW_D = 0.12;

// --- tail ---------------------------------------------------------------
//
// Thin whip tail, drooping back-and-down from the haunch. TAIL_TILT is
// the pitch that maps the cylinder's +Y end to a down-and-back world
// direction: Rx(-2.0) takes (0,1,0) to (0, -0.416, -0.909), which is
// "mostly back, slightly down". The thick end (rBottom) is the part
// that emerges from the haunch; the thin end (rTop) is the tip.

const TAIL_Y = 0.18;
const TAIL_Z = -0.42;
const TAIL_TILT_RAD = -2.0;
const TAIL_LEN = 0.24;
const TAIL_RADIUS_TOP = 0.010;    // tip
const TAIL_RADIUS_BOT = 0.040;    // root

// --- ears ---------------------------------------------------------------
//
// Small pointed cones laid back along the skull — the aggressive/threat
// pose. Ears at the top corners of the skull, swept back and slightly
// outward. A perked-up ear pose would read as "alert pet"; laid back
// reads as "warning" or "attack".

const EAR_RADIUS = 0.025;
const EAR_LENGTH = 0.07;
const EAR_X = 0.055;
const EAR_Y = SKULL_Y + 0.05;
const EAR_Z = SKULL_Z - 0.02;
const EAR_TILT_X = -0.5;   // pitched back
const EAR_TILT_Z = 0.3;    // splayed outward (mirrored on each side)

// --- legs (thin, four-pivot) --------------------------------------------
//
// LEG_TOP_Y = LEG_LENGTH means the leg mesh's bottom lands exactly on
// the ground plane when the mount is unscaled. Thin legs + a low body
// give the hound its lean, predatory proportions. The pivots are
// exposed under the same `horseLegs` key every mount uses, so the
// shared trot-cycle code drives them without any hound-specific
// branch.

const LEG_TOP_Y = 0.24;
const LEG_LENGTH = 0.24;
const LEG_RADIUS_TOP = 0.024;
const LEG_RADIUS_BOT = 0.018;

// --- palette ------------------------------------------------------------
//
// Dark blood red flesh — clearly red at battle zoom without being
// cartoon-bright, and reads as menacing against any biome's ground
// palette. Distinct from the beast mount's olive-brown (0x4a4a2a) and
// from every human/goblin body: a hound on the field reads as its own
// creature, not as a recoloured goblin.
//
// Bone (teeth) is the same near-white as the beast's tusks/horns so
// the two "monstrous creature" models share a material family. Eye is
// a saturated red used only on the tiny eye spheres.

const FLESH_COLOR = 0x4a1010;
const DARK_COLOR  = 0x080606;
const BONE_COLOR  = 0xd8d0b0;
const EYE_COLOR   = 0xff2020;

// ========================================================================

export function createHoundBase() {
  const group = new THREE.Group();

  const fleshMat = cachedMaterial('hound.fleshMat', () =>
    new THREE.MeshLambertMaterial({ color: FLESH_COLOR }));
  const darkMat = cachedMaterial('hound.darkMat', () =>
    new THREE.MeshLambertMaterial({ color: DARK_COLOR }));
  const boneMat = cachedMaterial('hound.boneMat', () =>
    new THREE.MeshLambertMaterial({ color: BONE_COLOR }));
  // Eyes: MeshBasicMaterial so they render at full brightness regardless
  // of sun/hemi contribution — a red dot that reads as a faint glow even
  // in the darkest biome. No transparency, no depthWrite trickery: the
  // eye spheres are small enough that the opaque-pass cost is zero.
  const eyeMat = cachedMaterial('hound.eyeMat', () =>
    new THREE.MeshBasicMaterial({ color: EYE_COLOR }));

  // --- flesh: chest + haunch + neck + skull + brow + snout + jaw + tail + ears
  const bodyGeo = cachedGeometry(
    `hound.bodyGeo.${HAS_CAPSULE ? 'cap' : 'cyl'}`,
    () => {
      const chestGeo = HAS_CAPSULE
        ? new THREE.CapsuleGeometry(CHEST_RADIUS, CHEST_CYL_LEN, 4, 8)
        : new THREE.CylinderGeometry(CHEST_RADIUS, CHEST_RADIUS, CHEST_CYL_LEN + CHEST_RADIUS * 2, 8);
      const haunchGeo = HAS_CAPSULE
        ? new THREE.CapsuleGeometry(HAUNCH_RADIUS, HAUNCH_CYL_LEN, 4, 8)
        : new THREE.CylinderGeometry(HAUNCH_RADIUS, HAUNCH_RADIUS, HAUNCH_CYL_LEN + HAUNCH_RADIUS * 2, 8);

      return mergeGeometries([
        // Chest (barrel front) — laid along Z, so rotate 90° on X.
        { geometry: chestGeo,
          matrix: partMatrix(0, CHEST_Y, CHEST_Z, Math.PI / 2, 0, 0) },
        // Haunch (rear) — same rotation, sits lower and further back.
        { geometry: haunchGeo,
          matrix: partMatrix(0, HAUNCH_Y, HAUNCH_Z, Math.PI / 2, 0, 0) },
        // Neck — tapered cylinder tilted forward-up.
        { geometry: new THREE.CylinderGeometry(0.06, 0.10, NECK_LEN, 6),
          matrix: partMatrix(0, NECK_Y, NECK_Z, NECK_TILT_RAD, 0, 0) },
        // Skull — wedge box.
        { geometry: new THREE.BoxGeometry(SKULL_W, SKULL_H, SKULL_D),
          matrix: partMatrix(0, SKULL_Y, SKULL_Z) },
        // Brow — heavy overhang above the eyes.
        { geometry: new THREE.BoxGeometry(BROW_W, BROW_H, BROW_D),
          matrix: partMatrix(0, BROW_Y, BROW_Z, 0.15, 0, 0) },
        // Snout — narrower than the skull, protruding forward and down.
        { geometry: new THREE.BoxGeometry(SNOUT_W, SNOUT_H, SNOUT_D),
          matrix: partMatrix(0, SNOUT_Y, SNOUT_Z, -0.15, 0, 0) },
        // Lower jaw — hangs below the snout with a visible gap.
        { geometry: new THREE.BoxGeometry(JAW_W, JAW_H, JAW_D),
          matrix: partMatrix(0, JAW_Y, JAW_Z, 0.10, 0, 0) },
        // Tail — thin whip, drooping back-and-down.
        { geometry: new THREE.CylinderGeometry(
            TAIL_RADIUS_TOP, TAIL_RADIUS_BOT, TAIL_LEN, 5),
          matrix: partMatrix(0, TAIL_Y, TAIL_Z, TAIL_TILT_RAD, 0, 0) },
        // Left ear (mirrored on the right below) — laid back, splayed out.
        { geometry: new THREE.ConeGeometry(EAR_RADIUS, EAR_LENGTH, 4),
          matrix: partMatrix(-EAR_X, EAR_Y, EAR_Z, EAR_TILT_X, 0, -EAR_TILT_Z) },
        // Right ear.
        { geometry: new THREE.ConeGeometry(EAR_RADIUS, EAR_LENGTH, 4),
          matrix: partMatrix(EAR_X, EAR_Y, EAR_Z, EAR_TILT_X, 0, EAR_TILT_Z) }
      ]);
    }
  );
  group.add(new THREE.Mesh(bodyGeo, fleshMat));

  // --- bone: spine spikes + teeth -------------------------------------
  //
  // The spine ridge and teeth are the two "menacing" reads that survive
  // to silhouette distance. Both bone-coloured, both rigidly attached,
  // merged into one mesh so they cost one draw call in total.
  const boneGeo = cachedGeometry('hound.boneGeo', () => {
    const entries = [];

    // Note: the previous build carried a row of five bone spikes down
    // the spine. They were removed by request — the red flesh plus the
    // teeth alone now carry the "creepy war hound" read, and the spikes
    // were dominating the topline silhouette.

    // Upper canines: two prominent fangs per side pointing down from
    // the snout, plus a smaller inner pair. The big pair carries the
    // "sabre-tooth hint" read; the small pair keeps the mouth line
    // visually busy so it never resolves as a clean two-fang cartoon.
    for (const side of [-1, 1]) {
      // Big outer canine.
      entries.push({
        geometry: new THREE.ConeGeometry(0.012, 0.05, 4),
        matrix: partMatrix(
          side * 0.030,
          SNOUT_Y - 0.06,
          SNOUT_Z + 0.05,
          Math.PI, 0, 0
        )
      });
      // Small inner canine.
      entries.push({
        geometry: new THREE.ConeGeometry(0.008, 0.03, 4),
        matrix: partMatrix(
          side * 0.015,
          SNOUT_Y - 0.06,
          SNOUT_Z + 0.06,
          Math.PI, 0, 0
        )
      });
    }

    // Lower fangs: one per side, pointing up from the lower jaw so the
    // teeth interlock when the mouth is closed. Same trick real canines
    // use — the teeth cross the mouth gap rather than meeting in a
    // straight line, which reads as a "closed predator mouth" rather
    // than a hinge.
    for (const side of [-1, 1]) {
      entries.push({
        geometry: new THREE.ConeGeometry(0.010, 0.04, 4),
        matrix: partMatrix(
          side * 0.020,
          JAW_Y + 0.04,
          JAW_Z + 0.05,
          0, 0, 0
        )
      });
    }

    return mergeGeometries(entries);
  });
  group.add(new THREE.Mesh(boneGeo, boneMat));

  // --- dark: eye sockets + mouth band + nose tip ----------------------
  //
  // Eye sockets are the deepest-read "this is a monster" surface on the
  // hound. They sit just BEHIND the brow ridge (BROW_Z 0.38 vs socket
  // 0.475), so the brow physically occludes the upper part of each
  // socket from most camera angles — the classic "eyes in shadow"
  // predator read. The red glow spheres (below) sit inside these
  // sockets and poke through the front face, giving the eye itself.
  const darkGeo = cachedGeometry('hound.darkGeo', () =>
    mergeGeometries([
      // Left eye socket.
      { geometry: new THREE.BoxGeometry(0.03, 0.025, 0.02),
        matrix: partMatrix(-0.05, SKULL_Y + 0.02, SKULL_Z + 0.075) },
      // Right eye socket.
      { geometry: new THREE.BoxGeometry(0.03, 0.025, 0.02),
        matrix: partMatrix(0.05, SKULL_Y + 0.02, SKULL_Z + 0.075) },
      // Mouth band: fills the gap between snout underside and jaw top,
      // so the profile reads as a closed predator's mouth rather than
      // two boxes with air between them.
      { geometry: new THREE.BoxGeometry(SNOUT_W - 0.015, 0.015, SNOUT_D - 0.01),
        matrix: partMatrix(0, 0.33, SNOUT_Z) },
      // Nose tip: a small dark block at the front of the snout.
      { geometry: new THREE.BoxGeometry(0.04, 0.03, 0.03),
        matrix: partMatrix(0, SNOUT_Y + 0.005, SNOUT_Z + 0.075) }
    ])
  );
  group.add(new THREE.Mesh(darkGeo, darkMat));

  // --- glowing red eyes -----------------------------------------------
  //
  // Two tiny spheres sitting INSIDE the dark sockets, poking just past
  // the socket's front face. At battle zoom they read as two red dots;
  // at close range they read as eyes. Deliberately small — a larger
  // eye would look cartoonish and lose the "something watching from
  // inside a skull" read.
  const eyeGeo = cachedGeometry('hound.eyeGeo', () =>
    mergeGeometries([
      { geometry: new THREE.SphereGeometry(0.012, 4, 3),
        matrix: partMatrix(-0.05, SKULL_Y + 0.02, SKULL_Z + 0.08) },
      { geometry: new THREE.SphereGeometry(0.012, 4, 3),
        matrix: partMatrix(0.05, SKULL_Y + 0.02, SKULL_Z + 0.08) }
    ])
  );
  group.add(new THREE.Mesh(eyeGeo, eyeMat));

  // --- four legs, each on a pivot (trot-cycle contract) --------------
  //
  // Front pivots under the chest, rear under the haunch. X spread is
  // narrower than the horse's (a hound's gait is a straight-line trot,
  // not a splay); Z positions sit just inside the barrel ends so the
  // legs emerge from the body rather than from thin air.
  //
  // Same `horseLegs` key the beast and horse use — SoldierView's
  // _applyHorseWalkCycle drives all three without a per-mount branch.
  const legGeo = cachedGeometry('hound.legGeo', () =>
    new THREE.CylinderGeometry(LEG_RADIUS_TOP, LEG_RADIUS_BOT, LEG_LENGTH, 5));

  const horseLegs = {};
  for (const lx of [-0.075, 0.075]) {
    for (const lz of [-0.16, 0.12]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, LEG_TOP_Y, lz);

      const leg = new THREE.Mesh(legGeo, fleshMat);
      leg.position.y = -LEG_LENGTH / 2;
      pivot.add(leg);
      group.add(pivot);

      // End-first keying ('fl','fr','bl','br') so the view reads
      // legs.fl / legs.fr / legs.bl / legs.br naturally. Reversing this
      // order silently breaks the trot cycle — _horseLegs stays truthy
      // but every read is undefined.
      const end = lz > 0 ? 'f' : 'b';
      const side = lx < 0 ? 'l' : 'r';
      horseLegs[end + side] = pivot;
    }
  }
  group.userData.horseLegs = horseLegs;

  // Scale up so a hound next to a soldier reads as a proper war dog,
  // not a stray puppy.
  group.scale.setScalar(MOUNT_SCALE);

  group.userData.riderMountHeight = RIDER_MOUNT_HEIGHT;

  return group;
}
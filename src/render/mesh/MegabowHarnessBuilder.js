// ===== src/render/mesh/MegabowHarnessBuilder.js =====
// Carrier's megabow carrying rig: a leather vest, two rods rising from the
// shoulders, and a hinge bracket above and behind the head. The bow hangs
// from the hinge.
//
// HIERARCHY (everything hangs off the body group)
//   group            vest (in a slouch-matched pivot) + rods + hinge cheeks
//     hinge          Group at the bracket. SoldierView rotates it:
//                    x = tilt (0 = bow upright on the back, ~PI/2 = aimed),
//                    y = yaw toward the target.
//       barrel       the hinge barrel (turns with the hinge)
//       mount        Group rotated -PI/2 on X, so its local +Z is the
//                    hinge's +Y. The bow (MegabowBuilder) is added here and
//                    slid along its own axis (layoutMegabowDeploy).
//
// ASSUMPTION: the torso is the common goblin torso (waist pivot at 0.40,
// slouch 0.40 rad, head top at ~0.83). Carriers use the slave body, which
// was not checked; tune the constants below if the vest does not hug it.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix, poseMatrix } from './MeshMerge.js';

// --- torso frame (must match GoblinBodyBuilder) ----------------------------
const WAIST_Y = 0.40;
const SLOUCH_RAD = 0.40;

// --- hinge bracket (body space) -------------------------------------------
export const HARNESS_HINGE_Y = 0.93;
export const HARNESS_HINGE_Z = -0.12;
const HINGE_HALF_WIDTH = 0.058;

// --- vest ------------------------------------------------------------------
const VEST_LEATHER = 0x4a3320;
const VEST_TEAM_BLEND = 0.35;
// [radius, y] in the slouch pivot's local frame; slightly larger than the
// goblin upper torso profile so the vest sits on top of the skin.
const VEST_PROFILE = [
  [0.108, -0.04],
  [0.113, 0.00],
  [0.105, 0.065],
  [0.093, 0.143],
  [0.080, 0.205]
];
const SHOULDER_PAD_X = 0.075;
const SHOULDER_PAD_Y = 0.178;
const SHOULDER_PAD_Z = -0.025;

// Slouch-pivot-local point -> body space.
function slouchToBody(x, ly, lz) {
  const c = Math.cos(SLOUCH_RAD);
  const s = Math.sin(SLOUCH_RAD);
  return new THREE.Vector3(x, WAIST_Y + ly * c - lz * s, ly * s + lz * c);
}

function buildVestGeometry() {
  const profile = VEST_PROFILE.map(([r, y]) => new THREE.Vector2(r, y));
  const entries = [{ geometry: new THREE.LatheGeometry(profile, 10) }];

  for (const side of [-1, 1]) {
    entries.push({
      geometry: new THREE.BoxGeometry(0.05, 0.022, 0.065),
      matrix: partMatrix(side * SHOULDER_PAD_X, SHOULDER_PAD_Y, SHOULDER_PAD_Z)
    });
  }
  // Back plate the rods are anchored to.
  entries.push({
    geometry: new THREE.BoxGeometry(0.11, 0.12, 0.02),
    matrix: partMatrix(0, 0.10, -0.092)
  });
  return mergeGeometries(entries);
}

function buildMetalGeometry() {
  const up = new THREE.Vector3(0, 1, 0);
  const entries = [];

  for (const side of [-1, 1]) {
    const p0 = slouchToBody(side * SHOULDER_PAD_X, SHOULDER_PAD_Y + 0.012, SHOULDER_PAD_Z);
    const p1 = new THREE.Vector3(side * HINGE_HALF_WIDTH, HARNESS_HINGE_Y, HARNESS_HINGE_Z);
    const dir = p1.clone().sub(p0);
    const len = dir.length();
    dir.normalize();

    entries.push({
      geometry: new THREE.CylinderGeometry(0.009, 0.009, len, 5),
      matrix: poseMatrix(
        p0.clone().add(p1).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(up, dir),
        new THREE.Vector3(1, 1, 1))
    });

    // Bracket cheek the rod ends in.
    entries.push({
      geometry: new THREE.BoxGeometry(0.012, 0.05, 0.045),
      matrix: partMatrix(side * (HINGE_HALF_WIDTH + 0.004), HARNESS_HINGE_Y, HARNESS_HINGE_Z)
    });
  }

  // Axle between the cheeks.
  entries.push({
    geometry: new THREE.CylinderGeometry(0.008, 0.008, 0.13, 6),
    matrix: partMatrix(0, HARNESS_HINGE_Y, HARNESS_HINGE_Z, 0, 0, Math.PI / 2)
  });
  return mergeGeometries(entries);
}

// color: team display colour (same value SoldierModelComposer passes to shields).
// Returns { group, hinge, mount }.
export function createMegabowHarness(color) {
  const group = new THREE.Group();

  const teamColor = new THREE.Color(color);
  const vestMat = cachedMaterial(
    `megabowHarness.vest.${teamColor.getHexString()}`,
    () => new THREE.MeshLambertMaterial({
      color: new THREE.Color(VEST_LEATHER).lerp(teamColor, VEST_TEAM_BLEND),
      side: THREE.DoubleSide
    }));
  const metalMat = cachedMaterial('megabowHarness.metal', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a5a5a }));
  const darkMat = cachedMaterial('megabowHarness.dark', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a2a2a }));

  // Vest lives in a pivot that mirrors the goblin's slouched upper torso.
  const vestPivot = new THREE.Group();
  vestPivot.position.set(0, WAIST_Y, 0);
  vestPivot.rotation.x = SLOUCH_RAD;
  vestPivot.add(new THREE.Mesh(
    cachedGeometry('megabowHarness.vestGeo', buildVestGeometry), vestMat));
  group.add(vestPivot);

  // Rods, bracket cheeks and axle: one merged metal mesh in body space.
  group.add(new THREE.Mesh(
    cachedGeometry('megabowHarness.metalGeo', buildMetalGeometry), metalMat));

  // Hinge pivot, animated by SoldierView.
  const hinge = new THREE.Group();
  hinge.position.set(0, HARNESS_HINGE_Y, HARNESS_HINGE_Z);
  hinge.rotation.order = 'YXZ';
  group.add(hinge);

  const barrelGeo = cachedGeometry('megabowHarness.barrelGeo', () => {
    const g = new THREE.CylinderGeometry(0.016, 0.016, 0.10, 8);
    g.rotateZ(Math.PI / 2);
    return g;
  });
  hinge.add(new THREE.Mesh(barrelGeo, darkMat));

  // The bow's own axis (+Z) points along the hinge's +Y at rest.
  const mount = new THREE.Group();
  mount.rotation.x = -Math.PI / 2;
  hinge.add(mount);

  // Carriage the bow slides through, fixed to the mount.
  const carriageGeo = cachedGeometry('megabowHarness.carriageGeo', () =>
    new THREE.BoxGeometry(0.055, 0.065, 0.07));
  mount.add(new THREE.Mesh(carriageGeo, darkMat));

  return { group, hinge, mount };
}
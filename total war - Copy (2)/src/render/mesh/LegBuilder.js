// Shared leg build for every body style. Two-piece: a hip pivot holding the
// thigh, with a nested knee pivot holding the shin. Both pivots are exposed
// on userData so SoldierView can drive them.
//
// Unmounted, the knee stays straight and the leg reads as a single piece —
// the walk cycle drives only the hip, so nothing changes visually from the
// earlier one-piece leg. Mounted, SoldierView angles the thigh outward and
// counter-rotates the knee so the shin drops vertically: the classic
// L-shaped rider's leg over a horse barrel.
//
// Splitting the leg at the midpoint rather than anywhere else keeps the knee
// visually centred when the leg is straight, and gives the mounted pose a
// symmetric L (thigh and shin are equal length, so a 90° bend reads clearly).
//
// Geometries are cached (see MeshCache.js) — all soldiers of all body styles
// share one thigh geometry and one shin geometry.
import * as THREE from 'three';
import { cachedGeometry } from './MeshCache.js';

// Single source of truth for leg proportions. Every body style shares these,
// so blob legs and skeleton legs are identical in height, thickness, and
// pivot placement by construction rather than by two sets of numbers that
// happen to match.
export const LEG_LENGTH = 0.30;
export const LEG_RADIUS = 0.035;
export const LEG_HIP_Y = 0.30;
export const LEG_HIP_SPACING = 0.08;

// Knee split. THIGH_LENGTH + SHIN_LENGTH = LEG_LENGTH by construction.
export const THIGH_LENGTH = 0.15;
export const SHIN_LENGTH = 0.15;

export function addLegs(group, mat) {
  const thighGeo = cachedGeometry('leg.thighGeo', () =>
    new THREE.CylinderGeometry(LEG_RADIUS, LEG_RADIUS, THIGH_LENGTH, 5));
  const shinGeo = cachedGeometry('leg.shinGeo', () =>
    new THREE.CylinderGeometry(LEG_RADIUS, LEG_RADIUS, SHIN_LENGTH, 5));

  const left = buildLeg(mat, thighGeo, shinGeo, -LEG_HIP_SPACING);
  group.add(left.hip);

  const right = buildLeg(mat, thighGeo, shinGeo, LEG_HIP_SPACING);
  group.add(right.hip);

  group.userData.legLeftPivot = left.hip;
  group.userData.legRightPivot = right.hip;
  group.userData.legLeftKnee = left.knee;
  group.userData.legRightKnee = right.knee;
}

// One leg: a hip pivot holding the thigh mesh and a nested knee pivot
// holding the shin mesh. The thigh mesh is offset down by half its length so
// its top sits at the hip; the knee pivot sits at the thigh's bottom; the
// shin mesh is offset down by half its length so its top sits at the knee.
// Net: the straight leg spans Y 0..-(THIGH+SHIN) below the hip.
function buildLeg(mat, thighGeo, shinGeo, x) {
  const hip = new THREE.Group();
  hip.position.set(x, LEG_HIP_Y, 0);

  const thigh = new THREE.Mesh(thighGeo, mat);
  thigh.position.y = -THIGH_LENGTH / 2;
  hip.add(thigh);

  const knee = new THREE.Group();
  knee.position.y = -THIGH_LENGTH;
  hip.add(knee);

  const shin = new THREE.Mesh(shinGeo, mat);
  shin.position.y = -SHIN_LENGTH / 2;
  knee.add(shin);

  return { hip, knee };
}
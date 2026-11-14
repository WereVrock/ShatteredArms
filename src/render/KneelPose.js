// ===== src/render/KneelPose.js =====
// Kneel / crouch leg poses for the crew-served megabow CARRIER.
//
// Same baking scheme as the walk poses in SoldierModelComposer: each stage
// is a list of { geometry, matrix } parts that get merged into one leg
// geometry (composer) or expanded into thigh / shin instances (instancer).
//
// The LEFT leg kneels (thigh nearly vertical, shin lying back along the
// ground); the RIGHT leg is the planted front leg (thigh horizontal, shin
// vertical). SoldierView lowers the rider by the matching hip drop (see
// KNEEL_REAR_HIP_RAD) so the rear knee touches the ground.
//
// Rotation sign: positive X rotation swings a leg BACKWARD (-Z). So the
// front thigh uses a negative hip angle and a positive knee angle.
import * as THREE from 'three';

export const KNEEL_STAGE_CROUCH = 0;
export const KNEEL_STAGE_KNEEL = 1;
export const KNEEL_POSE_COUNT = 2;

// Rear (kneeling) thigh angle at full kneel. SoldierView derives the body
// drop from it: drop = hipY - thighLength * cos(KNEEL_REAR_HIP_RAD).
export const KNEEL_REAR_HIP_RAD = 0.35;

const STAGES = [
  // Crouch: transition pose while the carrier is going down.
  { frontHip: -0.9, frontKnee: 0.9, rearHip: 0.5, rearKnee: 0.8 },
  // Kneel: front thigh horizontal / shin vertical, rear knee on the ground.
  { frontHip: -1.5, frontKnee: 1.5, rearHip: KNEEL_REAR_HIP_RAD, rearKnee: 1.10 }
];

function bakeSide(parts, side, hipRot, kneeRot) {
  const hipMat = new THREE.Matrix4()
    .makeTranslation(side.hip.position.x, side.hip.position.y, side.hip.position.z)
    .multiply(new THREE.Matrix4().makeRotationX(hipRot));

  const meshMat = hipMat.clone().multiply(
    new THREE.Matrix4().makeTranslation(
      side.mesh.position.x, side.mesh.position.y, side.mesh.position.z));
  parts.push({ geometry: side.mesh.geometry, matrix: meshMat });

  if (side.knee && side.shin) {
    const kneeMat = hipMat.clone()
      .multiply(new THREE.Matrix4().makeTranslation(
        side.knee.position.x, side.knee.position.y, side.knee.position.z))
      .multiply(new THREE.Matrix4().makeRotationX(kneeRot));
    const shinMat = kneeMat.clone().multiply(
      new THREE.Matrix4().makeTranslation(
        side.shin.position.x, side.shin.position.y, side.shin.position.z));
    parts.push({ geometry: side.shin.geometry, matrix: shinMat });
  }
}

// leftSide / rightSide: leg descriptions as produced by extractLegSide in
// SoldierModelComposer (or the plain-number rig snapshot the instancer holds).
// stage: KNEEL_STAGE_CROUCH or KNEEL_STAGE_KNEEL.
export function computeKneelPoseParts(leftSide, rightSide, stage) {
  const st = STAGES[stage] || STAGES[KNEEL_STAGE_KNEEL];
  const parts = [];
  bakeSide(parts, leftSide, st.rearHip, st.rearKnee);
  bakeSide(parts, rightSide, st.frontHip, st.frontKnee);
  return parts;
}
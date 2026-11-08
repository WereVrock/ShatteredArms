// ===== ViewRange.js =====
// Pure helpers that scale camera range, fog, zoom step and pan speed with
// the camera's zoom distance, so zooming out far enough to see the whole
// field neither clips (far plane), fogs out (fog far) nor crawls (pan speed).
//
// No scene, no THREE, no settings import. SceneSetup and CameraController
// call these; the numbers live here so the two cannot drift apart.

export const ZOOM_MIN = 4;
// Large enough to frame the whole 400x400 field (CombatConfig.mapBounds)
// from the usual pitch range on a widescreen display.
export const ZOOM_MAX = 800;

// The default battle camera distance. Pan speed and zoom step are authored
// for this distance and only grow beyond it.
const REFERENCE_DISTANCE = 34;

export function clampZoom(distance) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, distance));
}

// Wheel step multiplier. 1 near the camera (unchanged feel), growing
// linearly with distance so crossing the field takes a few notches.
export function zoomStepScale(distance) {
  return Math.max(1, distance / 30);
}

// Pan speed multiplier for keyboard and mouse-drag panning.
export function panScale(distance) {
  return Math.max(1, distance / REFERENCE_DISTANCE);
}

// Camera near/far planes and fog range for a given zoom distance.
// At the default distance the fog values are essentially the old
// constants (near 40, far ~200).
export function viewRangeFor(cameraDistance) {
  const d = cameraDistance;
  return {
    near: Math.max(0.1, d * 0.01),
    far: Math.max(300, d * 2 + 900),
    fogNear: Math.max(40, d * 0.9),
    fogFar: Math.max(200, d * 2.5 + 120)
  };
}
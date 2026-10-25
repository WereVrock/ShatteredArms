// ===== src/render/LodConfig.js =====
// Level-of-detail tier definitions and distance thresholds.
//
// Four tiers, ordered by detail level. Tier 1 is fully detailed, tier 4 is
// an abstracted silhouette. SoldierMeshFactory picks the actual mesh
// builder by tier; SoldierView decides which tier a soldier should be in
// based on its distance from the camera and the user's settings.
//
// Consumed by:
//   - SoldierView._maybeUpdateLod  (per-frame tier decision)
//   - SoldierMeshFactory.pick      (builder routing)
//   - GraphicsMode.tierForDistance (the resolver)
//   - SettingsPanel                (tier names in the dropdowns)
//
// Pure data + two pure resolvers. No scene, no THREE, no sim import.

export const LodTier = Object.freeze({
  DETAILED: 1,
  MEDIUM:   2,
  SIMPLE:   3,
  ULTRA:    4
});

// Display names for the settings panel. Keyed by tier number so a
// <select> can render them in order. Must stay in sync with LodTier.
export const LOD_TIER_NAMES = Object.freeze({
  1: 'Detailed',
  2: 'Reduced Details',
  3: 'Simplified',
  4: 'Abstracted'
});

// Distance thresholds, in world units, measured on the XZ plane.
//
// XZ-plane distance, NOT 3D, is the metric on purpose: the camera sits at
// a pitch above the field, so a 3D measurement varies with the camera's
// pitch and the same battlefield would change tier when the player tilted
// the view. XZ distance tracks "how far away on the ground".
export const LOD_DISTANCE = Object.freeze({
  1: 25,
  2: 55,
  3: 100
});

// Width of the hysteresis band, in world units, applied to each threshold
// when deciding whether to LEAVE a tier. Entering a more detailed tier
// still uses the raw threshold; leaving it uses threshold + margin (for
// the coarse side) or threshold - margin (for the fine side).
//
// This is what stops a soldier marching along a threshold from
// oscillating between two tiers every few frames. Without it, a soldier
// straddling the tier-1 line would rebuild its whole model repeatedly
// as its distance jittered by fractions of a unit.
const HYSTERESIS_MARGIN = 4;

// Chooses the LOD tier for a soldier at the given XZ distance from the
// camera, given the user's chosen tier range.
//
//   maxDetail (lower number): most detailed tier allowed.
//   minDetail (higher number): most simplified tier allowed.
//
// When the distance-derived tier is more detailed than maxDetail, the
// return is maxDetail; when more simplified than minDetail, the return is
// minDetail. This is what lets the player say "never show me tier 1"
// (maxDetail = 2) or "never drop to tier 4" (minDetail = 3) without
// disallowing the intermediate tiers.
export function tierForDistance(rawDistanceXZ, maxDetail, minDetail, distanceScale = 1) {
  // distanceScale < 1 shrinks every detail zone (less detail, faster);
  // 1 is the authored thresholds.
  const distanceXZ = rawDistanceXZ / distanceScale;
  let tier;
  if (distanceXZ <= LOD_DISTANCE[1]) tier = 1;
  else if (distanceXZ <= LOD_DISTANCE[2]) tier = 2;
  else if (distanceXZ <= LOD_DISTANCE[3]) tier = 3;
  else tier = 4;

  if (tier < maxDetail) tier = maxDetail;
  if (tier > minDetail) tier = minDetail;
  return tier;
}

// Same as tierForDistance, but with hysteresis against a KNOWN current
// tier. This is the resolver SoldierView uses per frame: it needs a
// different answer for "just entered 25 units" than for "already at tier
// 1 and now at 26 units" or the model would rebuild every frame a soldier
// straddled the boundary.
//
// Entering a more detailed tier requires crossing the raw threshold;
// leaving a tier requires crossing the threshold plus HYSTERESIS_MARGIN
// in the coarse direction. The result is a dead band of width
// 2 * HYSTERESIS_MARGIN centred on each threshold.
export function tierForDistanceWithHysteresis(
  rawDistanceXZ, currentTier, maxDetail, minDetail, distanceScale = 1
) {
  const distanceXZ = rawDistanceXZ / distanceScale;
  const M = HYSTERESIS_MARGIN;
  let tier;

  // Per-tier decision: only the two transitions touching this tier's own
  // band are evaluated; everything else keeps the current tier.
  if (currentTier === 1) {
    tier = distanceXZ > LOD_DISTANCE[1] + M ? 2 : 1;
  } else if (currentTier === 2) {
    if (distanceXZ < LOD_DISTANCE[1] - M) tier = 1;
    else if (distanceXZ > LOD_DISTANCE[2] + M) tier = 3;
    else tier = 2;
  } else if (currentTier === 3) {
    if (distanceXZ < LOD_DISTANCE[2] - M) tier = 2;
    else if (distanceXZ > LOD_DISTANCE[3] + M) tier = 4;
    else tier = 3;
  } else if (currentTier === 4) {
    tier = distanceXZ < LOD_DISTANCE[3] - M ? 3 : 4;
  } else {
    // Defensive: unknown current tier falls back to the stateless
    // resolver so a corrupted save or a new tier added later still lands
    // somewhere sane.
    return tierForDistance(rawDistanceXZ, maxDetail, minDetail, distanceScale);
  }

  if (tier < maxDetail) tier = maxDetail;
  if (tier > minDetail) tier = minDetail;
  return tier;
}
// Terrain-aware positioning for units whose goal is "stand at distance D from
// the enemy" rather than "stand on a formation slot" (archers today).
//
// The caller computes its normal geometric goal first. This class then looks
// for better ground NEAR that goal (better walking surface, more open space, a
// little height) and, for archers, a spot with a clear arrow lane to the enemy,
// without letting the unit drift out of its firing band. The band is supplied
// by the caller as [minDist, maxDist] measured to the same enemy anchor the
// caller used for its goal, so a chosen spot can never take the unit out of its
// own range.
//
// Two reasons to leave the geometric goal:
//   - the ground there is poor (mud, forest floor, clutter, low ground), or
//   - the arrow lane from there to the enemy is blocked (ridge, wall, rocks,
//     trunks). A blocked lane outranks ground quality: an archer that cannot
//     shoot is worth nothing on good ground.
//
// Stability: the goal is re-derived every decision cycle from a moving enemy,
// so a naive re-search would pick a different spot each cycle and the unit
// would shuffle. A chosen spot is remembered per unit and reused while it is
// still inside the band, still near the current goal, still has a clear lane,
// and the goal itself is still a worse place to stand. It is forgotten as soon
// as the goal becomes good ground with a clear lane.
//
// Stateless apart from that per-unit memory (WeakMap, so no leak). Everything
// takes `terrain` as a parameter; null terrain means "flat", returns null.
import { AIConfig } from '../config/AIConfig.js';
import { TerrainSense } from './TerrainSense.js';
import { ArrowLanes } from './ArrowLanes.js';

const TWO_PI = 6.283185307179586;
const _spots = new WeakMap();

function distance(x, z, ax, az) {
  const dx = x - ax;
  const dz = z - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export const TerrainPositioning = {
  // goal:        { x, z } the caller's geometric goal.
  // enemyAnchor: { x, z } the point the standoff distance is measured from.
  // minDist/maxDist: allowed distance from enemyAnchor for a replacement spot.
  // Returns { x, z } to use instead of the goal, or null to keep the goal.
  archerSpot(terrain, unit, goal, enemyAnchor, minDist, maxDist) {
    if (!terrain || !goal || !enemyAnchor) return null;

    const goodEnough = AIConfig.archerTerrainGoodEnough ?? 1.0;
    const margin = AIConfig.archerTerrainMargin ?? 0.15;
    const maxDrift = AIConfig.archerTerrainMaxGoalDrift ?? 8.0;

    const goalLane = ArrowLanes.clear(terrain, goal.x, goal.z, enemyAnchor.x, enemyAnchor.z);
    const goalQuality = TerrainSense.groundQuality(terrain, goal.x, goal.z, false);

    if (goalLane && goalQuality >= goodEnough) {
      _spots.delete(unit);
      return null;
    }

    // A blocked lane means any standable spot with a clear lane beats the goal.
    const threshold = goalLane ? goalQuality + margin : 0;

    const kept = _spots.get(unit);
    if (kept) {
      const dEnemy = distance(kept.x, kept.z, enemyAnchor.x, enemyAnchor.z);
      const dGoal = distance(kept.x, kept.z, goal.x, goal.z);
      if (dEnemy >= minDist && dEnemy <= maxDist && dGoal <= maxDrift) {
        const q = TerrainSense.groundQuality(terrain, kept.x, kept.z, false);
        const stillBetter = goalLane ? q >= goalQuality + margin * 0.5 : q > 0;
        if (stillBetter &&
            ArrowLanes.clear(terrain, kept.x, kept.z, enemyAnchor.x, enemyAnchor.z)) {
          return kept;
        }
      }
      _spots.delete(unit);
    }

    const radii = AIConfig.archerTerrainRadii || [2, 4, 6];
    const angles = AIConfig.archerTerrainAngles || 12;

    let best = null;
    let bestQuality = threshold;
    for (let r = 0; r < radii.length; r++) {
      const rad = radii[r];
      for (let k = 0; k < angles; k++) {
        const a = (k / angles) * TWO_PI;
        const x = goal.x + Math.cos(a) * rad;
        const z = goal.z + Math.sin(a) * rad;

        const d = distance(x, z, enemyAnchor.x, enemyAnchor.z);
        if (d < minDist || d > maxDist) continue;

        const q = TerrainSense.groundQuality(terrain, x, z, false);
        if (q <= bestQuality) continue;

        // Lane check last: it is the expensive one, and only improvements
        // reach it.
        if (!ArrowLanes.clear(terrain, x, z, enemyAnchor.x, enemyAnchor.z)) continue;

        bestQuality = q;
        best = { x, z };
      }
    }

    if (best) {
      _spots.set(unit, best);
      return best;
    }
    return null;
  }
};
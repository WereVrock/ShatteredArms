// Can an arrow fired from one point reach another, or does terrain stop it?
//
// Follows the flight model in ArrowArc / Projectile (linear height from the bow
// hand to the target body, plus a parabola, anchored to the local ground height
// at both ends) and tests it against the terrain.
//
// By default only GROUND blocks a lane, which is exactly what ProjectileSystem
// does today: it stops arrows on terrain height and soldiers, and does not stop
// them on trees, rocks or walls. Set AIConfig.arrowLanesBlockObstacles = true
// only if ProjectileSystem is changed to use TerrainRayQuery.segmentHit; then
// ridges AND trunks, rocks and walls block lanes.
//
// This is an AI estimate on unit centers (real arrows are per soldier and
// scatter), so callers treat "blocked" as "probably not worth standing here".
//
// Null terrain means flat ground: always clear.
import { ArrowArc } from '../sim/ArrowArc.js';
import { AIConfig } from '../config/AIConfig.js';

const MIN_DIST = 2.0;
const SEGMENT_LENGTH = 2.0;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 16;

const _hit = { x: 0, y: 0, z: 0, kind: null, obstacle: null };

export const ArrowLanes = {
  clear(terrain, fromX, fromZ, toX, toZ) {
    if (!terrain) return true;
    const useObstacles = AIConfig.arrowLanesBlockObstacles === true &&
      terrain.obstacles.length > 0;
    if (!terrain.hasElevation && !useObstacles) return true;

    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < MIN_DIST) return true;

    const startY = terrain.heightAt(fromX, fromZ) + ArrowArc.BOW_HAND_Y;
    const endY = terrain.heightAt(toX, toZ) + ArrowArc.END_Y;
    const arc = ArrowArc.arcHeight(dist);
    const n = Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.ceil(dist / SEGMENT_LENGTH)));

    const rays = useObstacles ? terrain.rays : null;
    let px = fromX;
    let py = startY;
    let pz = fromZ;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = fromX + dx * t;
      const z = fromZ + dz * t;
      const y = startY + (endY - startY) * t + arc * 4 * t * (1 - t);
      if (rays) {
        if (rays.segmentHit(px, py, pz, x, y, z, _hit)) return false;
      } else if (y < terrain.heightAt(x, z)) {
        return false;
      }
      px = x;
      py = y;
      pz = z;
    }
    return true;
  }
};
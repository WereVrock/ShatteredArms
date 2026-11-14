// ===== src/render/BannerOcclusion.js =====
// Computes how much a unit's banner must rise above its default anchored
// Y so terrain or obstacles (trees, palms) between the camera and the
// banner do not hide it. Used by UnitOverlayView to lift banners in
// jungles and over hills, then draw a visible chain from the unit's
// ground anchor up to the lifted banner.
//
// APPROACH
// For each tree/palm near the camera→banner ray, project it onto that
// ray and compute what banner Y would make the camera→banner line clear
// that occluder's top. Take the max over all occluders. Everything is
// done in 2D projections plus a single divided-by-t formula — no
// raycaster, no terrain-mesh traversal.
//
// PERFORMANCE — SPATIAL GRID
// Iterating every obstacle for every unit every frame is O(units ×
// obstacles). A 50-unit battle over 500 obstacles was 25,000 iterations
// per frame. Instead, a spatial hash grid is built ONCE per terrain
// (keyed on the terrain reference — obstacles do not change mid-battle),
// with pre-computed per-obstacle occluder top Y so the inner loop never
// re-enters heightAt. Each query then touches only the ~4-6 cells the
// camera→banner ray crosses, which is 20-80 obstacles instead of 500.
//
// Callers should also cache the result per (unit, camera pose) —
// UnitOverlayView does this on 0.25-unit rounding, so a stationary
// camera over a stationary unit performs ZERO work per frame.
//
// COST (after grid + cache)
// ~20-80 inner iterations on cache-miss frames only. Cache-miss rate is
// roughly 1 frame in 4 for a drifting camera and 1 in 20 for a settled
// one — well under 0.1ms per frame in any realistic battle.
//
// Pure data + one pure resolver. No THREE import. No scene reads except
// what the caller passes in.
import { ObstacleKind } from '../config/TerrainConfig.js';

// Ignore occluders whose perpendicular distance from the camera→banner
// ray exceeds this. Prevents a tree standing to the side from lifting a
// banner that does not overlap it in screen space.
const PERP_RADIUS = 3.0;

// Banner's bottom edge must clear the highest occluder by at least this
// much, so the banner is not flush with the treetop.
const CLEARANCE_MARGIN = 0.4;

// Hard cap on lift. A unit pinned at the foot of a cliff could otherwise
// demand a 50-unit lift and turn its banner into a distant floating dot.
const MAX_LIFT = 18;

// Skip processing entirely when the banner is nearer than MIN_DIST
// (nothing can occlude at that range) or farther than MAX_DIST (banners
// are sub-pixel at that distance; occlusion is invisible).
const MIN_DIST = 3;
const MAX_DIST = 180;

// Rough top-of-occluder height above ground, per unit of obstacle scale.
// Trees and palms alike top out around 4 world units at scale 1 (a tree's
// trunk ~2.5 + crown ~1.5). Good enough for occlusion math — the exact
// value only affects lift margin, not whether the banner is visible.
const OCCLUDER_TOP_SCALE = 4.0;

// Cell edge length, world units. Larger than PERP_RADIUS + CLEARANCE so a
// query box that fits within one cell also catches obstacles in the
// neighbouring cells whose canopy could still cross the ray. 20 is a
// compromise: too small fragments the grid into many tiny cells; too
// large and each cell holds so many obstacles that the query loses its
// advantage.
const CELL_SIZE = 20;

// Per-terrain cached grids. WeakMap so a battle's grid is released the
// moment the terrain is; the next battle's terrain gets a fresh grid.
const _gridCache = new WeakMap();

// Builds the spatial grid for a terrain. Called once per terrain, cached
// in _gridCache, and never invalidated while that terrain is alive —
// obstacles do not change mid-battle.
function buildGrid(terrain) {
  const cells = new Map();

  const obstacles = terrain.obstacles;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (o.kind !== ObstacleKind.TREE && o.kind !== ObstacleKind.PALM) {
      continue;
    }

    // Pre-compute the occluder's TOP Y (base + scaled canopy height) at
    // build time so the per-frame inner loop never re-enters heightAt.
    const topY = terrain.heightAt(o.x, o.z)
      + OCCLUDER_TOP_SCALE * (o.scale || 1);

    const cx = Math.floor(o.x / CELL_SIZE);
    const cz = Math.floor(o.z / CELL_SIZE);
    const key = cx + ',' + cz;

    let list = cells.get(key);
    if (!list) {
      list = [];
      cells.set(key, list);
    }
    list.push({ x: o.x, z: o.z, topY });
  }

  // Reusable output buffer — every query clears and refills it. Callers
  // consume it synchronously before the next query, so no aliasing
  // hazard exists (JS is single-threaded).
  const _buf = [];

  return {
    cells,
    queryAABB(minX, minZ, maxX, maxZ) {
      _buf.length = 0;
      const cMinX = Math.floor(minX / CELL_SIZE);
      const cMinZ = Math.floor(minZ / CELL_SIZE);
      const cMaxX = Math.floor(maxX / CELL_SIZE);
      const cMaxZ = Math.floor(maxZ / CELL_SIZE);
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        for (let cz = cMinZ; cz <= cMaxZ; cz++) {
          const list = cells.get(cx + ',' + cz);
          if (!list) continue;
          for (let i = 0; i < list.length; i++) _buf.push(list[i]);
        }
      }
      return _buf;
    }
  };
}

function getGrid(terrain) {
  let g = _gridCache.get(terrain);
  if (g) return g;
  g = buildGrid(terrain);
  _gridCache.set(terrain, g);
  return g;
}

// Returns the lift (>= 0) by which the banner's local Y must be raised so
// it is not occluded by trees/palms between the camera and the banner.
// 0 means no occlusion, no lift, no chain.
//
//   anchorX, anchorZ — unit's ground anchor, world XZ
//   cameraPos         — THREE.Vector3-compatible { x, y, z }
//   terrain           — object with { obstacles, heightAt(x, z) }
//   localBottomY      — banner's bottom-edge local Y at zero lift
//                       (typically UnitOverlayView.SHIELD_BOTTOM_Y)
export function computeBannerLift(
  anchorX, anchorZ, cameraPos, terrain, localBottomY
) {
  if (!terrain || !terrain.obstacles || terrain.obstacles.length === 0) {
    return 0;
  }

  const dx = anchorX - cameraPos.x;
  const dz = anchorZ - cameraPos.z;
  const dist2D = Math.sqrt(dx * dx + dz * dz);
  if (dist2D < MIN_DIST || dist2D > MAX_DIST) return 0;

  const lineLen2 = dx * dx + dz * dz;

  // AABB with PERP_RADIUS margin so a tree that stands exactly at the
  // perpendicular boundary is not missed by an axis-aligned cut.
  const MARGIN = PERP_RADIUS + CLEARANCE_MARGIN;
  const qMinX = Math.min(cameraPos.x, anchorX) - MARGIN;
  const qMinZ = Math.min(cameraPos.z, anchorZ) - MARGIN;
  const qMaxX = Math.max(cameraPos.x, anchorX) + MARGIN;
  const qMaxZ = Math.max(cameraPos.z, anchorZ) + MARGIN;

  const grid = getGrid(terrain);
  const candidates = grid.queryAABB(qMinX, qMinZ, qMaxX, qMaxZ);
  if (candidates.length === 0) return 0;

  const groundY = terrain.heightAt(anchorX, anchorZ);
  const baselineWorldY = groundY + localBottomY;
  let maxYb = baselineWorldY;

  const perpRadius2 = PERP_RADIUS * PERP_RADIUS;

  for (let i = 0; i < candidates.length; i++) {
    const o = candidates[i];
    const ox = o.x - cameraPos.x;
    const oz = o.z - cameraPos.z;
    const t = (ox * dx + oz * dz) / lineLen2;
    if (t <= 0.02 || t >= 0.98) continue;

    const perpX = ox - dx * t;
    const perpZ = oz - dz * t;
    if (perpX * perpX + perpZ * perpZ > perpRadius2) continue;

    // lineY(t) = cameraPos.y * (1 - t) + Yb * t
    // Need lineY(t) >= occluderTopY + CLEARANCE_MARGIN, so:
    //   Yb >= (occluderTopY + CLEARANCE_MARGIN - cameraPos.y * (1 - t)) / t
    const ybNeeded = (o.topY + CLEARANCE_MARGIN
      - cameraPos.y * (1 - t)) / t;
    if (ybNeeded > maxYb) maxYb = ybNeeded;
  }

  const lift = maxYb - baselineWorldY;
  if (lift <= 0) return 0;
  return Math.min(lift, MAX_LIFT);
}
import { CombatConfig } from '../config/CombatConfig.js';
import {
  TerrainConfig, TerrainTypes, TerrainType, GAIT_EXPONENT, ObstacleKind
} from '../config/TerrainConfig.js';
import { Pathfinder } from './Pathfinder.js';
import { HeightField } from './HeightField.js';
import { TerrainRayQuery } from './TerrainRayQuery.js';

// Speed lookup tables: luts[gait][mounted ? 1 : 0][terrainType]
function buildSpeedLuts() {
  const luts = {};
  for (const gait of Object.keys(GAIT_EXPONENT)) {
    const e = GAIT_EXPONENT[gait];
    const foot = new Float32Array(TerrainTypes.length);
    const mounted = new Float32Array(TerrainTypes.length);
    TerrainTypes.forEach((t, i) => {
      foot[i] = Math.pow(t.foot, e);
      mounted[i] = Math.pow(t.mounted, e);
    });
    luts[gait] = [foot, mounted];
  }
  return luts;
}

// Grid of terrain types + obstacle list. Pure data; the sim and the AI
// query it, nothing here knows about soldiers.
//
// Cell index = iz * cols + ix, ix from bounds.minX, iz from bounds.minZ.
// Call touch() after any bulk edit so nav data rebuilds.
export class TerrainMap {
  constructor(bounds = CombatConfig.mapBounds, cellSize = TerrainConfig.cellSize) {
    this.bounds = bounds;
    this.cellSize = cellSize;
    this._inv = 1 / cellSize;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) * this._inv);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) * this._inv);
    this.types = new Uint8Array(this.cols * this.rows); // 0 = GRASS

    this.obstacles = [];
    this.version = 0;
    this.hasBlockedCells = false;

    this._blockedType = new Uint8Array(TerrainTypes.length);
    TerrainTypes.forEach((t, i) => { this._blockedType[i] = t.blocked ? 1 : 0; });
    this._luts = buildSpeedLuts();

    const bs = TerrainConfig.obstacleBucketSize;
    this._bucketSize = bs;
    this._bCols = Math.ceil((bounds.maxX - bounds.minX) / bs);
    this._bRows = Math.ceil((bounds.maxZ - bounds.minZ) / bs);
    this._buckets = new Array(this._bCols * this._bRows).fill(null);
    this._queryStamp = 0;

    this._pathfinder = null;
    this._rays = null;
    // Heightmap at cell corners. hasElevation is refreshed by touch().
    this.height = new HeightField(bounds, cellSize);
    this.hasElevation = false;
    // Area the generator filled; the terrain mesh only covers this.
    this.region = null;
    // Height of the water surface (set by the generator when it carves
    // lakes). Read by TerrainWaterView. 0 on flat terrain.
    this.waterLevel = 0;
  }

  // ---- indexing / sampling ------------------------------------------------

  cellIndexAt(x, z) {
    const ix = Math.floor((x - this.bounds.minX) * this._inv);
    const iz = Math.floor((z - this.bounds.minZ) * this._inv);
    if (ix < 0 || iz < 0 || ix >= this.cols || iz >= this.rows) return -1;
    return iz * this.cols + ix;
  }

  cellCenterX(ix) { return this.bounds.minX + (ix + 0.5) * this.cellSize; }
  cellCenterZ(iz) { return this.bounds.minZ + (iz + 0.5) * this.cellSize; }

  // ---- elevation ----------------------------------------------------------

  // Ground height at a point. 0 on flat terrain.
  heightAt(x, z) {
    return this.hasElevation ? this.height.heightAt(x, z) : 0;
  }

  // Rise over run along the unit direction (dx, dz). Positive = uphill.
  slopeAlong(x, z, dx, dz) {
    return this.hasElevation ? this.height.slopeAlong(x, z, dx, dz) : 0;
  }

  // ---- nav queries (O(1) after the grid is built) -------------------------

  _nav() {
    if (!this._pathfinder) this._pathfinder = new Pathfinder(this);
    return this._pathfinder;
  }

  // Builds the nav grid now instead of on the first order.
  warmNav() { this._nav().ensureBuilt(); }

  // Distance to the nearest obstacle / blocked cell; -1 inside blocked terrain.
  navClearanceAt(x, z) { return this._nav().clearanceAt(x, z); }

  // True when a straight walk keeps at least `clearance` from every obstacle.
  lineClear(ax, az, bx, bz, clearance, mounted) {
    return this._nav().lineClear(ax, az, bx, bz, clearance, mounted);
  }

  // 3D queries: ground picking for input, projectile hits, line of sight.
  get rays() {
    if (!this._rays) this._rays = new TerrainRayQuery(this);
    return this._rays;
  }

  typeAt(x, z) {
    const i = this.cellIndexAt(x, z);
    return i < 0 ? TerrainType.GRASS : this.types[i];
  }

  isBlocked(x, z) {
    const i = this.cellIndexAt(x, z);
    return i >= 0 && this._blockedType[this.types[i]] === 1;
  }

  // Terrain speed multiplier at a point. THE hot path: no allocation.
  // gait: 'walk' | 'run' | any key of GAIT_EXPONENT. Unknown gaits fall back to walk.
  speedMultAt(x, z, mounted = false, gait = 'walk') {
    const ix = Math.floor((x - this.bounds.minX) * this._inv);
    const iz = Math.floor((z - this.bounds.minZ) * this._inv);
    if (ix < 0 || iz < 0 || ix >= this.cols || iz >= this.rows) return 1;
    const lut = this._luts[gait] || this._luts.walk;
    return lut[mounted ? 1 : 0][this.types[iz * this.cols + ix]];
  }

  // ---- editing ------------------------------------------------------------

  fillCircle(x, z, r, type) {
    const cs = this.cellSize;
    const ix0 = Math.max(0, Math.floor((x - r - this.bounds.minX) / cs));
    const ix1 = Math.min(this.cols - 1, Math.floor((x + r - this.bounds.minX) / cs));
    const iz0 = Math.max(0, Math.floor((z - r - this.bounds.minZ) / cs));
    const iz1 = Math.min(this.rows - 1, Math.floor((z + r - this.bounds.minZ) / cs));
    const r2 = r * r;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = this.cellCenterX(ix) - x;
        const dz = this.cellCenterZ(iz) - z;
        if (dx * dx + dz * dz <= r2) this.types[iz * this.cols + ix] = type;
      }
    }
  }

  // variant: 'standard' | 'pine' | 'round' | 'dead'. Chosen per-cell by
  // BiomeTreeMix (see src/config/BiomeTreeMix.js). Collision, LOS, and
  // pathfinding all treat every variant identically — the variant only
  // selects the renderer (TerrainObstacleView._buildTrees dispatches on
  // it). Old saved terrain has no variant field; the renderer falls back
  // to BiomeVisuals.treeStyle for backward compat.
  addTree(x, z, scale = 1, variant = 'standard') {
    return this._addObstacle({
      kind: ObstacleKind.TREE, x, z, scale, variant,
      r: TerrainConfig.tree.collisionRadius * scale, rot: 0
    });
  }

  addRock(x, z, r, rot = 0) {
    return this._addObstacle({ kind: ObstacleKind.ROCK, x, z, r, scale: 1, rot });
  }

  addWall(x1, z1, x2, z2, height = TerrainConfig.wall.height) {
    return this._addObstacle({
      kind: ObstacleKind.WALL, x1, z1, x2, z2,
      x: (x1 + x2) / 2, z: (z1 + z2) / 2,
      r: Math.hypot(x2 - x1, z2 - z1) / 2,
      thickness: TerrainConfig.wall.thickness, height
    });
  }

  addColumn(x, z, height = TerrainConfig.column.height) {
    return this._addObstacle({
      kind: ObstacleKind.COLUMN, x, z,
      r: TerrainConfig.column.radius, height, scale: 1, rot: 0
    });
  }

  addBush(x, z, scale = 1) {
    return this._addObstacle({
      kind: ObstacleKind.BUSH, x, z,
      r: TerrainConfig.bush.radius * scale, scale, rot: 0
    });
  }

  addCactus(x, z, scale = 1) {
    return this._addObstacle({
      kind: ObstacleKind.CACTUS, x, z,
      r: TerrainConfig.cactus.radius * scale, scale, rot: 0
    });
  }

  addPalm(x, z, scale = 1) {
    return this._addObstacle({
      kind: ObstacleKind.PALM, x, z,
      r: TerrainConfig.palm.trunkRadius * scale, scale, rot: 0
    });
  }

  // A ruin model: circular collision like a rock, but rendered as a small
  // composite structure keyed by modelId (see RuinConfig.js). height is
  // used only by the ray query for arrow / line-of-sight blocking.
  addRuin(x, z, modelId, collision, height, rot = 0) {
    return this._addObstacle({
      kind: ObstacleKind.RUIN, x, z,
      modelId, r: collision, height, scale: 1, rot
    });
  }

  // A biome scenery prop (tent, crypt, tower, etc.). Circular collision
  // like RUIN; modelId keys the CampPropKit builder used by the renderer
  // (see BiomeSceneryConfig.js / BiomeSceneryBuilder.js).
  addScenery(x, z, modelId, collision, height, rot = 0) {
    return this._addObstacle({
      kind: ObstacleKind.SCENERY, x, z,
      modelId, r: collision, height, scale: 1, rot
    });
  }

  // Fallen log: reuses WALL for its segment collision, but carries a
  // `logStyle` flag so the renderer draws a horizontal cylinder instead
  // of a stone block. Thickness is a log's diameter, height is how high
  // above ground the trunk rests (0.35 ~ a human-shin-high fallen tree).
  addFallenLog(x1, z1, x2, z2) {
    return this._addObstacle({
      kind: ObstacleKind.WALL,
      x1, z1, x2, z2,
      x: (x1 + x2) / 2, z: (z1 + z2) / 2,
      r: Math.hypot(x2 - x1, z2 - z1) / 2,
      thickness: 0.5,
      height: 0.35,
      logStyle: true
    });
  }

  _addObstacle(o) {
    o._stamp = 0;
    this.obstacles.push(o);
    this._insertObstacle(o);
    return o;
  }

  _insertObstacle(o) {
    let minX, maxX, minZ, maxZ;
    if (o.kind === ObstacleKind.WALL) {
      const pad = o.thickness;
      minX = Math.min(o.x1, o.x2) - pad; maxX = Math.max(o.x1, o.x2) + pad;
      minZ = Math.min(o.z1, o.z2) - pad; maxZ = Math.max(o.z1, o.z2) + pad;
    } else {
      minX = o.x - o.r; maxX = o.x + o.r;
      minZ = o.z - o.r; maxZ = o.z + o.r;
    }
    const bs = this._bucketSize;
    const b = this.bounds;
    const x0 = Math.max(0, Math.floor((minX - b.minX) / bs));
    const x1 = Math.min(this._bCols - 1, Math.floor((maxX - b.minX) / bs));
    const z0 = Math.max(0, Math.floor((minZ - b.minZ) / bs));
    const z1 = Math.min(this._bRows - 1, Math.floor((maxZ - b.minZ) / bs));
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        const idx = bz * this._bCols + bx;
        (this._buckets[idx] || (this._buckets[idx] = [])).push(o);
      }
    }
  }

  _rebuildBuckets() {
    this._buckets.fill(null);
    for (const o of this.obstacles) this._insertObstacle(o);
  }

  removeObstaclesWhere(pred) {
    this.obstacles = this.obstacles.filter(o => !pred(o));
    this._rebuildBuckets();
  }

  // Fills `out` with obstacles whose bucket overlaps the square around
  // (x, z). Unfiltered by exact distance; callers do the precise test.
  queryObstacles(x, z, radius, out) {
    out.length = 0;
    if (this.obstacles.length === 0) return out;
    const bs = this._bucketSize;
    const b = this.bounds;
    const bx0 = Math.floor((x - radius - b.minX) / bs);
    const bx1 = Math.floor((x + radius - b.minX) / bs);
    const bz0 = Math.floor((z - radius - b.minZ) / bs);
    const bz1 = Math.floor((z + radius - b.minZ) / bs);
    if (bx1 < 0 || bz1 < 0 || bx0 >= this._bCols || bz0 >= this._bRows) return out;
    const stamp = ++this._queryStamp;
    for (let bz = Math.max(0, bz0); bz <= Math.min(this._bRows - 1, bz1); bz++) {
      for (let bx = Math.max(0, bx0); bx <= Math.min(this._bCols - 1, bx1); bx++) {
        const list = this._buckets[bz * this._bCols + bx];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          if (o._stamp === stamp) continue;
          o._stamp = stamp;
          out.push(o);
        }
      }
    }
    return out;
  }

  // Call after any bulk edit. Invalidates nav data.
  touch() {
    this.version++;
    this.height.refreshFlatFlag();
    this.hasElevation = this.height.nonFlat;
    let blocked = false;
    for (let i = 0; i < this.types.length; i++) {
      if (this._blockedType[this.types[i]] === 1) { blocked = true; break; }
    }
    this.hasBlockedCells = blocked;
  }

  // ---- clearing (deployment areas, spawn points) -------------------------

  // rects: [{minX,maxX,minZ,maxZ}]. Resets terrain to grass and removes
  // obstacles that touch any rect.
  clearRects(rects) {
    if (!rects.length) return;
    const inRects = (x, z) => {
      for (const r of rects) {
        if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
      }
      return false;
    };
    this.clearWhere(inRects, rects);
  }

  // pred(x, z) -> true for points to clear (e.g. (x,z) => zone.contains(x,z)).
  // The optional rects are only used to catch large obstacles whose centre is outside.
  clearWhere(pred, rects = null) {
    for (let iz = 0; iz < this.rows; iz++) {
      for (let ix = 0; ix < this.cols; ix++) {
        if (pred(this.cellCenterX(ix), this.cellCenterZ(iz))) {
          this.types[iz * this.cols + ix] = TerrainType.GRASS;
        }
      }
    }
    this.removeObstaclesWhere(o => {
      if (o.kind === ObstacleKind.WALL) {
        for (let k = 0; k <= 8; k++) {
          const f = k / 8;
          if (pred(o.x1 + (o.x2 - o.x1) * f, o.z1 + (o.z2 - o.z1) * f)) return true;
        }
        return false;
      }
      if (pred(o.x, o.z)) return true;
      if (rects) {
        for (const r of rects) {
          if (o.x >= r.minX - o.r && o.x <= r.maxX + o.r &&
              o.z >= r.minZ - o.r && o.z <= r.maxZ + o.r) return true;
        }
      }
      return false;
    });
    this.touch();
  }

  // Clears a padded bounding box around every unit's living soldiers.
  clearAroundUnits(units, margin = 6) {
    const rects = [];
    for (const u of units) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const s of u.soldiers) {
        if (!s.isAlive()) continue;
        if (s.pos.x < minX) minX = s.pos.x;
        if (s.pos.x > maxX) maxX = s.pos.x;
        if (s.pos.z < minZ) minZ = s.pos.z;
        if (s.pos.z > maxZ) maxZ = s.pos.z;
      }
      if (minX === Infinity) continue;
      rects.push({ minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin });
    }
    this.clearRects(rects);
  }

  // ---- pathfinding --------------------------------------------------------

  // Returns { points: [{x,z}...], reached: bool }. points excludes the start.
  // opts: { clearance (half-width the path must keep from obstacles), mounted }
  findPath(sx, sz, gx, gz, opts = {}) {
    if (!this._pathfinder) this._pathfinder = new Pathfinder(this);
    return this._pathfinder.findPath(sx, sz, gx, gz, opts);
  }
}
import { TerrainConfig, TerrainTypes } from '../config/TerrainConfig.js';
import { obstacleSignedDistance, closestOnSegment } from './TerrainGeometry.js';
import { slopeSpeedFactor, MAX_SLOPE_FACTOR } from './TerrainLocomotion.js';
import { isMajorObstacle } from './MajorObstacles.js';

const NAV = TerrainConfig.nav;
const SQRT2 = Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

// Tunables. Defaults live here so the file works before the config patch.
// Largest clearance a search asks for, however wide the formation. Wide units
// squeeze their column count instead (see FormationSqueeze).
const MAX_REQUIRED_CLEARANCE = Math.min(NAV.maxClearance, NAV.squeezeClearance ?? 2.0);
// Weighted A*: heuristic scaled by this. Fewer expansions, path at most this
// much costlier than optimal; smoothing removes most of the difference.
const HEURISTIC_WEIGHT = NAV.heuristicWeight ?? 1.3;
// Extra cost per world unit a cell falls short of the requested clearance.
const NARROW_PENALTY = NAV.narrowPenalty ?? 0.8;
// Below this clearance a soldier barely fits, so the cost climbs steeply.
const TIGHT_CLEARANCE = NAV.tightClearance ?? 0.6;
const TIGHT_PENALTY = NAV.tightPenalty ?? 6;
// A goal inside blocked ground snaps to the nearest open cell within this many cells.
const GOAL_SNAP_CELLS = NAV.goalSnapCells ?? 8;
// Wall rasterisation: extra half-thickness and how much of the cell's extent counts.
const WALL_MARGIN = 0.1;
const WALL_SQUARE_FACTOR = 0.9;
const SMOOTH_SLACK = 1.03;

const _cp = { x: 0, z: 0 };

// Cost multiplier for a cell with clearance `cl` when `req` is wanted.
// Soft: narrow cells are expensive but passable, so a path always exists when
// the map is connected, instead of failing and leaving the unit standing.
function narrowFactor(cl, req) {
  let f = 1;
  if (cl < req) f += (req - cl) * NARROW_PENALTY;
  if (cl < TIGHT_CLEARANCE) f += (TIGHT_CLEARANCE - cl) * TIGHT_PENALTY;
  return f;
}

// Grid A* over the terrain's cell grid.
//
//  - clearance[c]: distance from the cell centre to the nearest obstacle or
//    blocked cell (-1 = blocked terrain). Used as a COST (narrowFactor), not a
//    wall.
//  - hard[c]: cells paths may never enter: blocked terrain, walls (rasterised
//    over every cell they touch, because a wall is thinner than a cell and
//    would otherwise slip between cell centres) and cells whose centre is
//    inside an obstacle.
//  - cost[m][c]: per-world-unit travel cost = 1 / terrain speed, plus a
//    penalty for hugging obstacles. m = 0 foot, 1 mounted.
//  - Smoothing only shortcuts a stretch when the straight line is no more
//    expensive than the A* route, so detours around mud/forest survive.
export class Pathfinder {
  constructor(terrain) {
    this.terrain = terrain;
    this.builtVersion = -1;
    const N = terrain.cols * terrain.rows;
    this.clearance = new Float32Array(N);
    // Like clearance, but only walls, big rocks and blocked terrain count.
    // Path costs and soldier line-of-sight use this one, so trees never force
    // detours. `clearance` itself stays complete for RouterSteering.
    this.pathClear = new Float32Array(N);
    this.hard = new Uint8Array(N);
    this.cost = [new Float32Array(N), new Float32Array(N)];
    this._minCost = [1, 1];
    this._dist = new Float32Array(N);
    // Ground height at each cell centre, filled by rebuild() on hilly maps.
    this.cellH = new Float32Array(N);
    this.hasElevation = false;

    this._g = new Float32Array(N);
    this._parent = new Int32Array(N);
    this._seen = new Uint32Array(N);
    this._closed = new Uint32Array(N);
    this._gen = 0;
    this._heapIdx = [];
    this._heapF = [];
  }

  // ---- grid build ---------------------------------------------------------

  rebuild() {
    const t = this.terrain;
    this._buildClearance(t);
    this._stampObstacles(t);
    this._buildCosts(t);
    this._buildHeights(t);
    this.builtVersion = t.version;
  }

  _buildClearance(t) {
    const { cols, rows, cellSize: cs, types } = t;
    const N = cols * rows;
    const MAXC = NAV.maxClearance;
    const clearance = this.clearance;
    const hard = this.hard;
    clearance.fill(MAXC);
    hard.fill(0);

    // Distance to blocked terrain cells (two-pass chamfer, in cells).
    const dist = this._dist;
    dist.fill(1e9);
    let anyBlocked = false;
    for (let i = 0; i < N; i++) {
      if (TerrainTypes[types[i]].blocked) {
        dist[i] = 0;
        hard[i] = 1;
        anyBlocked = true;
      }
    }
    if (!anyBlocked) return;

    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        const i = z * cols + x;
        let d = dist[i];
        if (x > 0) d = Math.min(d, dist[i - 1] + 1);
        if (z > 0) {
          d = Math.min(d, dist[i - cols] + 1);
          if (x > 0) d = Math.min(d, dist[i - cols - 1] + SQRT2);
          if (x < cols - 1) d = Math.min(d, dist[i - cols + 1] + SQRT2);
        }
        dist[i] = d;
      }
    }
    for (let z = rows - 1; z >= 0; z--) {
      for (let x = cols - 1; x >= 0; x--) {
        const i = z * cols + x;
        let d = dist[i];
        if (x < cols - 1) d = Math.min(d, dist[i + 1] + 1);
        if (z < rows - 1) {
          d = Math.min(d, dist[i + cols] + 1);
          if (x < cols - 1) d = Math.min(d, dist[i + cols + 1] + SQRT2);
          if (x > 0) d = Math.min(d, dist[i + cols - 1] + SQRT2);
        }
        dist[i] = d;
      }
    }
    for (let i = 0; i < N; i++) {
      if (TerrainTypes[types[i]].blocked) clearance[i] = -1;
      else clearance[i] = Math.min(MAXC, Math.max(0, dist[i] * cs - cs * 0.5));
    }
  }

  _stampObstacles(t) {
    const { cols, rows, cellSize: cs } = t;
    const MAXC = NAV.maxClearance;
    const clearance = this.clearance;
    const hard = this.hard;
    const half = cs * 0.5;
    this.pathClear.set(clearance);

    for (const o of t.obstacles) {
      const isWall = o.x1 !== undefined;
      const major = isMajorObstacle(o);
      const pathClear = this.pathClear;
      const ext = MAXC + (o.thickness || 0);
      let minX, maxX, minZ, maxZ;
      if (isWall) {
        minX = Math.min(o.x1, o.x2) - ext; maxX = Math.max(o.x1, o.x2) + ext;
        minZ = Math.min(o.z1, o.z2) - ext; maxZ = Math.max(o.z1, o.z2) + ext;
      } else {
        minX = o.x - o.r - ext; maxX = o.x + o.r + ext;
        minZ = o.z - o.r - ext; maxZ = o.z + o.r + ext;
      }
      const ix0 = Math.max(0, Math.floor((minX - t.bounds.minX) / cs));
      const ix1 = Math.min(cols - 1, Math.floor((maxX - t.bounds.minX) / cs));
      const iz0 = Math.max(0, Math.floor((minZ - t.bounds.minZ) / cs));
      const iz1 = Math.min(rows - 1, Math.floor((maxZ - t.bounds.minZ) / cs));
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const i = iz * cols + ix;
          if (clearance[i] < 0) continue;
          const cx = t.cellCenterX(ix);
          const cz = t.cellCenterZ(iz);
          const sd = obstacleSignedDistance(o, cx, cz);
          const c = sd < 0 ? 0 : sd;
          if (c < clearance[i]) clearance[i] = c;
          if (major && c < pathClear[i]) pathClear[i] = c;
          if (hard[i] === 0 && major) {
            const blocks = isWall ? this._wallTouchesCell(o, cx, cz, half) : sd < 0;
            if (blocks) hard[i] = 1;
          }
        }
      }
    }
  }

  // True when the (slightly thickened) wall overlaps the cell's square.
  _wallTouchesCell(o, cx, cz, half) {
    closestOnSegment(cx, cz, o.x1, o.z1, o.x2, o.z2, _cp);
    const vx = cx - _cp.x;
    const vz = cz - _cp.z;
    const d = Math.sqrt(vx * vx + vz * vz);
    if (d < 1e-6) return true;
    const reach = o.thickness * 0.5 + WALL_MARGIN;
    const support = half * (Math.abs(vx) + Math.abs(vz)) / d * WALL_SQUARE_FACTOR;
    return d <= reach + support;
  }

  _buildCosts(t) {
    const N = t.cols * t.rows;
    const types = t.types;
    const clearance = this.clearance;
    for (let m = 0; m < 2; m++) {
      const cost = this.cost[m];
      let minCost = Infinity;
      for (let i = 0; i < N; i++) {
        const def = TerrainTypes[types[i]];
        const speed = Math.max(0.05, m === 1 ? def.mounted : def.foot);
        let c = 1 / speed;
        const cl = this.pathClear[i];
        if (cl >= 0 && cl < NAV.proximityDist) {
          c *= 1 + (NAV.proximityDist - cl) * NAV.proximityPenalty;
        }
        cost[i] = c;
        if (def.blocked === false && 1 / speed < minCost) minCost = 1 / speed;
      }
      this._minCost[m] = minCost;
    }
  }

  _buildHeights(t) {
    const { cols, rows } = t;
    this.hasElevation = t.hasElevation;
    if (!t.hasElevation) return;
    for (let iz = 0; iz < rows; iz++) {
      for (let ix = 0; ix < cols; ix++) {
        this.cellH[iz * cols + ix] = t.heightAt(t.cellCenterX(ix), t.cellCenterZ(iz));
      }
    }
  }

  ensureBuilt() {
    if (this.builtVersion !== this.terrain.version) this.rebuild();
  }

  _cellAt(x, z) {
    const t = this.terrain;
    let ix = Math.floor((x - t.bounds.minX) / t.cellSize);
    let iz = Math.floor((z - t.bounds.minZ) / t.cellSize);
    if (ix < 0) ix = 0; else if (ix >= t.cols) ix = t.cols - 1;
    if (iz < 0) iz = 0; else if (iz >= t.rows) iz = t.rows - 1;
    return iz * t.cols + ix;
  }

  // ---- queries ------------------------------------------------------------

  // Returns { points: [{x,z}...], reached }. points excludes the start.
  // opts: { clearance, mounted }. A goal inside blocked ground snaps to the
  // nearest open cell and reports reached = false (the goal itself cannot be
  // stood on).
  findPath(sx, sz, gx, gz, opts = {}) {
    this.ensureBuilt();

    const m = opts.mounted ? 1 : 0;
    const req = Math.min(MAX_REQUIRED_CLEARANCE, Math.max(0.3, opts.clearance ?? 0.6));
    const startCell = this._cellAt(sx, sz);
    let goalCell = this._cellAt(gx, gz);
    let snapped = false;

    if (this.hard[goalCell] === 1) {
      const alt = this._nearestOpenCell(goalCell, gx, gz);
      if (alt >= 0) {
        goalCell = alt;
        snapped = true;
      }
    }

    // Open ground shortcut: no search needed.
    if (!snapped) {
      const direct = this._lineCost(sx, sz, gx, gz, req, m, startCell);
      const straight = Math.hypot(gx - sx, gz - sz);
      if (direct >= 0 && direct <= straight * NAV.directPathSlack + 0.01) {
        return { points: [{ x: gx, z: gz }], reached: true };
      }
    }

    return this._astar(sx, sz, gx, gz, req, m, startCell, goalCell, snapped);
  }

  // Distance to the nearest obstacle / blocked cell; -1 inside blocked terrain.
  clearanceAt(x, z) {
    this.ensureBuilt();
    return this.clearance[this._cellAt(x, z)];
  }

  // True when the straight segment keeps `req` clearance at every sampled cell.
  // Strict yes/no (unlike findPath's soft cost): used for soldier line-of-sight.
lineClear(ax, az, bx, bz, req, mounted) {
    this.ensureBuilt();
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) return true;
    const clearance = this.clearance;
    const hard = this.hard;
    const startCell = this._cellAt(ax, az);
    const n = Math.max(1, Math.ceil(len / (this.terrain.cellSize * 0.5)));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const c = this._cellAt(ax + (bx - ax) * f, az + (bz - az) * f);
      if (c === startCell) continue;
      // hard cells include every cell a wall touches, so a thin wall between
      // two cell centres cannot be walked through by a "clear" line.
      if (hard[c] === 1 || this.pathClear[c] < req) return false;
    }
    return true;
  }

  // Nearest non-hard cell around a blocked goal (Chebyshev rings, best by
  // Euclidean distance to the goal point; one extra ring is checked).
  _nearestOpenCell(goalCell, gx, gz) {
    const t = this.terrain;
    const { cols, rows } = t;
    const hard = this.hard;
    const gcx = goalCell % cols;
    const gcz = (goalCell / cols) | 0;
    let best = -1;
    let bestD = Infinity;
    let foundRing = -1;

    for (let k = 1; k <= GOAL_SNAP_CELLS; k++) {
      if (foundRing >= 0 && k > foundRing + 1) break;
      for (let dz = -k; dz <= k; dz++) {
        for (let dx = -k; dx <= k; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== k) continue;
          const nx = gcx + dx;
          const nz = gcz + dz;
          if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
          const c = nz * cols + nx;
          if (hard[c] === 1) continue;
          const ex = t.cellCenterX(nx) - gx;
          const ez = t.cellCenterZ(nz) - gz;
          const d = ex * ex + ez * ez;
          if (d < bestD) {
            bestD = d;
            best = c;
            if (foundRing < 0) foundRing = k;
          }
        }
      }
    }
    return best;
  }

  // ---- search -------------------------------------------------------------

  _astar(sx, sz, gx, gz, req, m, startCell, goalCell, snapped) {
    const t = this.terrain;
    const { cols, rows, cellSize: cs } = t;
    const clearance = this.clearance;
    const hard = this.hard;
    const cost = this.cost[m];
    const g = this._g, parent = this._parent, seen = this._seen, closed = this._closed;
    const gen = ++this._gen;
    this._heapIdx.length = 0;
    this._heapF.length = 0;
    const maxExpansions = NAV.maxExpansions;

    const goalCx = goalCell % cols;
    const goalCz = (goalCell / cols) | 0;
    const hScale = cs * this._minCost[m] * HEURISTIC_WEIGHT /
      (this.hasElevation ? MAX_SLOPE_FACTOR : 1);
    const heur = (c) => {
      const dx = Math.abs((c % cols) - goalCx);
      const dz = Math.abs(((c / cols) | 0) - goalCz);
      return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * hScale;
    };
    const pass = (c) => hard[c] === 0 || c === startCell;

    g[startCell] = 0;
    seen[startCell] = gen;
    parent[startCell] = -1;
    this._push(startCell, heur(startCell));

    let best = startCell;
    let bestH = heur(startCell);
    let reached = false;
    let expansions = 0;

    while (this._heapIdx.length > 0) {
      const c = this._pop();
      if (closed[c] === gen) continue;
      closed[c] = gen;

      if (c === goalCell) { best = c; reached = true; break; }
      if (++expansions > maxExpansions) break;

      const hc = heur(c);
      if (hc < bestH) { bestH = hc; best = c; }

      const cx = c % cols;
      const cz = (c / cols) | 0;
      const cc = this.pathClear[c] < 0 ? 0 : this.pathClear[c];
      const fromCost = cost[c] * narrowFactor(cc, req);

      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], nz = cz + DZ[k];
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const n = nz * cols + nx;
        if (closed[n] === gen || !pass(n)) continue;
        let len = cs;
        if (k >= 4) {
          // No corner cutting through blocked diagonals.
          if (!pass(cz * cols + nx) || !pass(nz * cols + cx)) continue;
          len = cs * SQRT2;
        }
        const nc = this.pathClear[n] < 0 ? 0 : this.pathClear[n];
        let edge = len * (fromCost + cost[n] * narrowFactor(nc, req)) * 0.5;
        if (this.hasElevation) {
          edge /= slopeSpeedFactor((this.cellH[n] - this.cellH[c]) / len, m === 1);
        }
        const ng = g[c] + edge;
        if (seen[n] !== gen || ng < g[n]) {
          seen[n] = gen;
          g[n] = ng;
          parent[n] = c;
          this._push(n, ng + heur(n));
        }
      }
    }

    return this._finishPath(sx, sz, gx, gz, req, m, startCell, best, reached && !snapped);
  }

  // Reconstructs the cell chain, then smooths it.
  _finishPath(sx, sz, gx, gz, req, m, startCell, best, exact) {
    const t = this.terrain;
    const { cols } = t;
    const g = this._g, parent = this._parent;

    const cells = [];
    for (let c = best; c !== -1; c = parent[c]) cells.push(c);
    cells.reverse();
    const n = cells.length;
    if (n <= 1) {
      return { points: [exact ? { x: gx, z: gz } : { x: sx, z: sz }], reached: exact };
    }

    const xs = new Array(n), zs = new Array(n), gs = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      xs[i] = t.cellCenterX(c % cols);
      zs[i] = t.cellCenterZ((c / cols) | 0);
      gs[i] = g[c];
    }
    xs[0] = sx; zs[0] = sz;
    if (exact) { xs[n - 1] = gx; zs[n - 1] = gz; }

    // Smooth: take the farthest straight line that is not costlier than the A* route.
    const outIdx = [];
    const last = n - 1;
    let i = 0;
    while (i < last) {
      let j = Math.min(last, i + NAV.smoothLookahead);
      for (; j > i + 1; j--) {
        const lc = this._lineCost(xs[i], zs[i], xs[j], zs[j], req, m, startCell);
        if (lc >= 0 && lc <= (gs[j] - gs[i]) * SMOOTH_SLACK + 0.05) break;
      }
      outIdx.push(j);
      i = j;
    }
    return { points: outIdx.map(k => ({ x: xs[k], z: zs[k] })), reached: exact };
  }

  // Sampled cost along a segment, or -1 if it enters a hard cell. Same cost
  // model as the A* edges (terrain, proximity, narrow penalty, slope).
  _lineCost(ax, az, bx, bz, req, m, startCell) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) return 0;
    const clearance = this.clearance;
    const hard = this.hard;
    const cost = this.cost[m];
    const n = Math.max(1, Math.ceil(len / (this.terrain.cellSize * 0.5)));
    const sl = len / n;
    const elev = this.hasElevation;
    let prevH = elev ? this.cellH[this._cellAt(ax, az)] : 0;
    let total = 0;
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const c = this._cellAt(ax + (bx - ax) * f, az + (bz - az) * f);
      if (hard[c] === 1 && c !== startCell) return -1;
      const cl = this.pathClear[c] < 0 ? 0 : this.pathClear[c];
      let step = cost[c] * narrowFactor(cl, req) * sl;
      if (elev) {
        const h = this.cellH[c];
        step /= slopeSpeedFactor((h - prevH) / sl, m === 1);
        prevH = h;
      }
      total += step;
    }
    return total;
  }

  _push(c, f) {
    const hi = this._heapIdx, hf = this._heapF;
    let i = hi.length;
    hi.push(c); hf.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hi[i] = hi[p]; hf[i] = hf[p];
      i = p;
    }
    hi[i] = c; hf[i] = f;
  }

  _pop() {
    const hi = this._heapIdx, hf = this._heapF;
    const top = hi[0];
    const lc = hi.pop(), lf = hf.pop();
    const n = hi.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const mIdx = (r < n && hf[r] < hf[l]) ? r : l;
        if (hf[mIdx] >= lf) break;
        hi[i] = hi[mIdx]; hf[i] = hf[mIdx];
        i = mIdx;
      }
      hi[i] = lc; hf[i] = lf;
    }
    return top;
  }
}
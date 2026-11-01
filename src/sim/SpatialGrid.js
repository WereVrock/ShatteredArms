// Uniform grid for fast neighbour queries. Avoids O(n^2) distance checks.
//
// Storage is a dense integer grid rebuilt once per tick (counting sort):
//   - every alive soldier is assigned a cell index, no string keys;
//   - soldiers are laid out cell by cell in one flat array, in the order
//     they were given to rebuild(), so a cell's contents are contiguous;
//   - cells in the same x-column are adjacent, so a query reads ONE
//     contiguous slice per column instead of one lookup per cell.
//
// Query results are identical to the old Map-of-arrays grid, including
// ORDER: columns ascending in x, cells ascending in z, soldiers in
// insertion order inside a cell. Systems that mutate positions while they
// iterate (collision) therefore resolve in exactly the same sequence.
//
// The dense window covers the map box plus WINDOW_MARGIN_UNITS. A cell
// outside the window (a soldier fleeing far past the edge, or a NaN
// position) lives in a small string-keyed overflow map, consulted only
// when a query reaches outside the window.
//
// There is one layer for "everybody" and one per team. A soldier appears
// in exactly one team layer (its own).
import { CombatConfig } from '../config/CombatConfig.js';

const WINDOW_MARGIN_UNITS = 40;

class GridLayer {
  constructor(cellCount) {
    // start[c] .. start[c + 1] is the slice of `items` holding cell c.
    this.start = new Int32Array(cellCount + 1);
    this.items = [];
    this.present = false;
  }
}

export class SpatialGrid {
  constructor(cellSize, bounds = CombatConfig.mapBounds) {
    this.cellSize = cellSize;

    this._minCx = Math.floor((bounds.minX - WINDOW_MARGIN_UNITS) / cellSize);
    this._minCz = Math.floor((bounds.minZ - WINDOW_MARGIN_UNITS) / cellSize);
    this._maxCx = Math.floor((bounds.maxX + WINDOW_MARGIN_UNITS) / cellSize);
    this._maxCz = Math.floor((bounds.maxZ + WINDOW_MARGIN_UNITS) / cellSize);
    this._cols = this._maxCx - this._minCx + 1;
    this._rows = this._maxCz - this._minCz + 1;
    this._cellCount = this._cols * this._rows;

    this._all = new GridLayer(this._cellCount);

    // Persistent per-team layers. _teamOrder lists the team indices that
    // have at least one soldier in the CURRENT build, in first-seen order
    // (the same order the old per-team Map iterated in).
    this._teamLayers = [];
    this._teamIndexById = new Map();
    this._teamIds = [];
    this._teamOrder = [];

    // Alive soldiers of the current build, in input order, plus their
    // cell index (-1 = overflow) and team index.
    this._soldiers = [];
    this._cellOf = new Int32Array(1024);
    this._teamOf = new Int32Array(1024);

    // Out-of-window cells (rare). Keys are "cx,cz" strings.
    this._overflowAll = new Map();
    this._overflowByTeam = new Map();

    // insert()/clear() compatibility: inserted soldiers are collected and
    // the grid is built lazily by the next query.
    this._pending = [];
    this._dirty = false;
  }

  // The previous implementation exposed its Maps. Anything still reading
  // them must fail loudly instead of silently seeing an empty grid.
  get cells() {
    throw new Error('SpatialGrid.cells was removed (integer grid). Use queryNearbyInto().');
  }

  get cellsByTeam() {
    throw new Error('SpatialGrid.cellsByTeam was removed (integer grid). Use queryNearbyIntoExcludingTeam().');
  }

  clear() {
    this._pending.length = 0;
    this._dirty = true;
  }

  insert(soldier) {
    this._pending.push(soldier);
    this._dirty = true;
  }

  rebuild(soldiers) {
    this._pending.length = 0;
    this._build(soldiers, true);
    this._dirty = false;
  }

  // Allocating convenience wrapper for one-off callers. Anything on the
  // per-tick hot path should use queryNearbyInto with a reusable buffer.
  queryNearby(x, z, radiusInCells = 1) {
    const out = [];
    this.queryNearbyInto(out, x, z, radiusInCells);
    return out;
  }

  // Fills `out` with the soldiers in the (2r+1)^2 cells around (x, z),
  // unfiltered by exact distance. Clears `out` first.
  queryNearbyInto(out, x, z, radiusInCells = 1) {
    if (this._dirty) this._rebuildFromPending();
    out.length = 0;
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    this._collect(this._all, this._overflowAll, out, cx, cz, radiusInCells);
    return out;
  }

  // Same, but only soldiers whose teamId !== excludeTeamId. Allied
  // soldiers are never touched.
  queryNearbyIntoExcludingTeam(out, x, z, radiusInCells, excludeTeamId) {
    if (this._dirty) this._rebuildFromPending();
    out.length = 0;
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);

    const order = this._teamOrder;
    for (let k = 0; k < order.length; k++) {
      const ti = order[k];
      if (this._teamIds[ti] === excludeTeamId) continue;
      this._collect(
        this._teamLayers[ti],
        this._overflowByTeam.get(ti) || null,
        out, cx, cz, radiusInCells
      );
    }
    return out;
  }

  // --- internals ---------------------------------------------------------

  _rebuildFromPending() {
    this._build(this._pending, false);
    this._dirty = false;
  }

  _teamIndexFor(teamId) {
    let ti = this._teamIndexById.get(teamId);
    if (ti === undefined) {
      ti = this._teamLayers.length;
      this._teamIndexById.set(teamId, ti);
      this._teamIds.push(teamId);
      this._teamLayers.push(new GridLayer(this._cellCount));
    }
    return ti;
  }

  _build(list, aliveOnly) {
    const cs = this.cellSize;
    const minCx = this._minCx;
    const minCz = this._minCz;
    const cols = this._cols;
    const rows = this._rows;

    const soldiers = this._soldiers;
    soldiers.length = 0;
    this._teamOrder.length = 0;
    this._overflowAll.clear();
    this._overflowByTeam.clear();

    const layers = this._teamLayers;
    for (let t = 0; t < layers.length; t++) layers[t].present = false;

    const total = list.length;
    if (this._cellOf.length < total) {
      const cap = Math.max(total, this._cellOf.length * 2);
      this._cellOf = new Int32Array(cap);
      this._teamOf = new Int32Array(cap);
    }
    const cellOf = this._cellOf;
    const teamOf = this._teamOf;

    let n = 0;
    let lastTeamId;
    let lastTeamIdx = -1;

    for (let i = 0; i < total; i++) {
      const s = list[i];
      if (aliveOnly && !s.isAlive()) continue;

      let ti;
      if (lastTeamIdx >= 0 && s.teamId === lastTeamId) {
        ti = lastTeamIdx;
      } else {
        ti = this._teamIndexFor(s.teamId);
        lastTeamId = s.teamId;
        lastTeamIdx = ti;
      }
      const layer = layers[ti];
      if (!layer.present) {
        layer.present = true;
        this._teamOrder.push(ti);
      }

      const cx = Math.floor(s.pos.x / cs);
      const cz = Math.floor(s.pos.z / cs);
      const ix = cx - minCx;
      const iz = cz - minCz;

      let idx;
      if (ix >= 0 && ix < cols && iz >= 0 && iz < rows) {
        idx = ix * rows + iz;
      } else {
        idx = -1;
        this._addOverflow(s, ti, cx, cz);
      }

      soldiers[n] = s;
      cellOf[n] = idx;
      teamOf[n] = ti;
      n++;
    }

    this._fillLayer(this._all, n, -1);
    const order = this._teamOrder;
    for (let k = 0; k < order.length; k++) {
      this._fillLayer(layers[order[k]], n, order[k]);
    }
  }

  // Counting sort of the build's in-window soldiers into one layer.
  // teamFilter < 0 takes everybody, otherwise only that team index.
  _fillLayer(layer, n, teamFilter) {
    const start = layer.start;
    const cellOf = this._cellOf;
    const teamOf = this._teamOf;
    const soldiers = this._soldiers;
    const cellCount = this._cellCount;

    start.fill(0);

    let count = 0;
    for (let i = 0; i < n; i++) {
      if (teamFilter >= 0 && teamOf[i] !== teamFilter) continue;
      const idx = cellOf[i];
      if (idx < 0) continue;
      start[idx]++;
      count++;
    }

    // Inclusive prefix sum: start[c] becomes the exclusive END of cell c.
    let sum = 0;
    for (let c = 0; c < cellCount; c++) {
      sum += start[c];
      start[c] = sum;
    }
    start[cellCount] = sum;

    const items = layer.items;
    while (items.length < count) items.push(null);

    // Placing in reverse with a pre-decrement keeps insertion order inside
    // each cell and leaves start[c] at the BEGINNING of cell c.
    for (let i = n - 1; i >= 0; i--) {
      if (teamFilter >= 0 && teamOf[i] !== teamFilter) continue;
      const idx = cellOf[i];
      if (idx < 0) continue;
      items[--start[idx]] = soldiers[i];
    }
  }

  _addOverflow(s, ti, cx, cz) {
    const key = cx + ',' + cz;

    let bucket = this._overflowAll.get(key);
    if (!bucket) {
      bucket = [];
      this._overflowAll.set(key, bucket);
    }
    bucket.push(s);

    let teamMap = this._overflowByTeam.get(ti);
    if (!teamMap) {
      teamMap = new Map();
      this._overflowByTeam.set(ti, teamMap);
    }
    let teamBucket = teamMap.get(key);
    if (!teamBucket) {
      teamBucket = [];
      teamMap.set(key, teamBucket);
    }
    teamBucket.push(s);
  }

  // Appends the soldiers of one layer found around cell (cx, cz) to `out`.
  _collect(layer, overflow, out, cx, cz, r) {
    const minCx = this._minCx;
    const minCz = this._minCz;
    const rows = this._rows;
    const start = layer.start;
    const items = layer.items;

    const loX = cx - r;
    const hiX = cx + r;
    const loZ = cz - r;
    const hiZ = cz + r;

    let n = out.length;

    // Fast path: the whole neighbourhood is inside the dense window. The
    // cells of one x-column are adjacent, so each column is one slice.
    if (loX >= minCx && hiX <= this._maxCx && loZ >= minCz && hiZ <= this._maxCz) {
      for (let ix = loX - minCx; ix <= hiX - minCx; ix++) {
        const base = ix * rows - minCz;
        const end = start[base + hiZ + 1];
        for (let k = start[base + loZ]; k < end; k++) out[n++] = items[k];
      }
      return;
    }

    // Slow path: window edge, overflow cells or a NaN position.
    const cols = this._cols;
    const hasOverflow = overflow !== null && overflow.size > 0;

    for (let dx = -r; dx <= r; dx++) {
      const px = cx + dx;
      const ix = px - minCx;
      const columnInWindow = ix >= 0 && ix < cols;

      for (let dz = -r; dz <= r; dz++) {
        const pz = cz + dz;
        const iz = pz - minCz;

        if (columnInWindow && iz >= 0 && iz < rows) {
          const idx = ix * rows + iz;
          const end = start[idx + 1];
          for (let k = start[idx]; k < end; k++) out[n++] = items[k];
        } else if (hasOverflow) {
          const bucket = overflow.get(px + ',' + pz);
          if (bucket) {
            for (let i = 0; i < bucket.length; i++) out[n++] = bucket[i];
          }
        }
      }
    }
  }
}
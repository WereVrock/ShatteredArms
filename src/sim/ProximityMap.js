import { CombatConfig } from '../config/CombatConfig.js';

// Master switch for every "skip the scan" gate built on the per-tick
// presence maps (ProximityMap, MakeWayGate). Set to false to get the exact
// pre-gate behaviour and cost back for A/B profiling: every query then
// answers "maybe" and callers run their full scan.
export const PROXIMITY_GATES_ENABLED = true;

const DEFAULT_CELL_SIZE = 4.0;

// Coarse per-tick presence maps over the battlefield.
//
// rebuild() counts alive soldiers per coarse cell, once per team and once
// for "isRouting", then turns each count grid into a summed-area table, so
// "is any enemy inside this square?" is four array reads.
//
// The answers are CONSERVATIVE: a "no" is always true (callers may skip a
// scan that could only have found nothing), a "yes" only means "maybe, run
// the real scan". Cells are clamped at the map edge, and clamping is
// monotone, so a soldier inside a query square always lands in a cell
// covered by that square's cell range.
//
// Not a replacement for SpatialGrid: it stores counts, not soldiers.
export class ProximityMap {
  constructor(bounds = CombatConfig.mapBounds, cellSize = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
    this.routingCount = 0;

    this._inv = 1 / cellSize;
    this._minX = bounds.minX;
    this._minZ = bounds.minZ;
    this._cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) * this._inv));
    this._rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) * this._inv));
    this._stride = this._cols + 1;
    this._satLength = this._stride * (this._rows + 1);

    this._teamIndexById = new Map();
    this._teamSats = [];
    this._routingSat = new Int32Array(this._satLength);
  }

  // Recount from the soldiers' CURRENT positions, alive flags and routing
  // flags. Call it right before the consumers that need that moment.
  rebuild(allSoldiers) {
    const teamSats = this._teamSats;
    for (let t = 0; t < teamSats.length; t++) teamSats[t].fill(0);
    const routingSat = this._routingSat;
    routingSat.fill(0);

    const stride = this._stride;
    let routing = 0;
    let lastTeamId = null;
    let lastSat = null;

    for (let i = 0; i < allSoldiers.length; i++) {
      const s = allSoldiers[i];
      if (!s.isAlive()) continue;

      if (lastSat === null || s.teamId !== lastTeamId) {
        lastTeamId = s.teamId;
        lastSat = this._satForTeam(s.teamId);
      }

      const cell = (this._rowOf(s.pos.z) + 1) * stride + this._colOf(s.pos.x) + 1;
      lastSat[cell]++;
      if (s.isRouting) {
        routingSat[cell]++;
        routing++;
      }
    }

    for (let t = 0; t < teamSats.length; t++) this._integrate(teamSats[t]);
    this.routingCount = routing;
    if (routing > 0) this._integrate(routingSat);
  }

  // True if any alive soldier NOT on `teamId` may stand inside the square
  // centred on (x, z) with the given half extent (world units).
  hasEnemyWithin(teamId, x, z, halfExtent) {
    if (!PROXIMITY_GATES_ENABLED) return true;
    const own = this._teamIndexById.get(teamId);
    const sats = this._teamSats;
    for (let t = 0; t < sats.length; t++) {
      if (t === own) continue;
      if (this._rectSum(sats[t], x - halfExtent, z - halfExtent,
                        x + halfExtent, z + halfExtent) > 0) {
        return true;
      }
    }
    return false;
  }

  // True if any alive routing soldier (any team) may stand inside the square.
  hasRoutingWithin(x, z, halfExtent) {
    if (!PROXIMITY_GATES_ENABLED) return true;
    if (this.routingCount === 0) return false;
    return this._rectSum(this._routingSat, x - halfExtent, z - halfExtent,
                         x + halfExtent, z + halfExtent) > 0;
  }

  _satForTeam(teamId) {
    let idx = this._teamIndexById.get(teamId);
    if (idx === undefined) {
      idx = this._teamSats.length;
      this._teamIndexById.set(teamId, idx);
      this._teamSats.push(new Int32Array(this._satLength));
    }
    return this._teamSats[idx];
  }

  // In-place 2D prefix sum. Row 0 and column 0 stay zero.
  _integrate(sat) {
    const stride = this._stride;
    for (let r = 1; r <= this._rows; r++) {
      const row = r * stride;
      const prev = row - stride;
      for (let c = 1; c <= this._cols; c++) {
        const i = row + c;
        sat[i] += sat[prev + c] + sat[i - 1] - sat[prev + c - 1];
      }
    }
  }

  // Sum of counts over the inclusive cell range covering the world square.
  _rectSum(sat, x0, z0, x1, z1) {
    const c0 = this._colOf(x0);
    const c1 = this._colOf(x1);
    const r0 = this._rowOf(z0);
    const r1 = this._rowOf(z1);
    const stride = this._stride;
    return sat[(r1 + 1) * stride + c1 + 1]
         - sat[r0 * stride + c1 + 1]
         - sat[(r1 + 1) * stride + c0]
         + sat[r0 * stride + c0];
  }

  _colOf(x) {
    const v = (x - this._minX) * this._inv;
    if (!(v > 0)) return 0;
    if (v >= this._cols) return this._cols - 1;
    return v | 0;
  }

  _rowOf(z) {
    const v = (z - this._minZ) * this._inv;
    if (!(v > 0)) return 0;
    if (v >= this._rows) return this._rows - 1;
    return v | 0;
  }
}
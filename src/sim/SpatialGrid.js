// Uniform grid for fast nearest-neighbor queries. Avoids O(n^2) distance checks.

export class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    // Combined grid — every soldier in every cell. Kept for callers that
    // genuinely need both teams (morale strength sums, collision push,
    // anything that reasons across team boundaries).
    this.cells = new Map();
    // Per-team grids, keyed by teamId. A soldier appears in exactly one
    // team bucket (its own). This is what lets a melee soldier scan ONLY
    // enemy candidates instead of iterating its own packed formation
    // every tick. At 2000 soldiers in a formed line, the combined grid
    // near a soldier contains ~200 ALLIED soldiers, all discarded by the
    // teamId filter — ~200 wasted comparisons per soldier per tick, and
    // ~40ms of the sim tick during the approach phase. The per-team grid
    // collapses that to ~0 iterations when no enemy is nearby.
    this.cellsByTeam = new Map();
  }

  _key(x, z) {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    return `${cx},${cz}`;
  }

  clear() {
    this.cells.clear();
    this.cellsByTeam.clear();
  }

  insert(soldier) {
    const key = this._key(soldier.pos.x, soldier.pos.z);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(soldier);

    // Mirror into the per-team grid. One extra Map.get + array push per
    // soldier per tick — trivial next to the ~200 per-soldier iterations
    // it removes from every melee soldier's targeting search.
    let teamCells = this.cellsByTeam.get(soldier.teamId);
    if (!teamCells) {
      teamCells = new Map();
      this.cellsByTeam.set(soldier.teamId, teamCells);
    }
    let teamBucket = teamCells.get(key);
    if (!teamBucket) {
      teamBucket = [];
      teamCells.set(key, teamBucket);
    }
    teamBucket.push(soldier);
  }

  rebuild(soldiers) {
    this.clear();
    for (const s of soldiers) {
      if (s.isAlive()) this.insert(s);
    }
  }

  // Returns soldiers within `radius` cells of (x,z), unfiltered by exact distance.
  //
  // Kept for one-off callers (tests, tooling, anything outside the tick).
  // Anything on the hot path (once per soldier per tick) should prefer
  // queryNearbyInto to avoid allocating a fresh array every call.
  queryNearby(x, z, radiusInCells = 1) {
    const out = [];
    this.queryNearbyInto(out, x, z, radiusInCells);
    return out;
  }

  // Fill `out` with the nearby soldiers and return it. Clears `out` first.
  // Used by every per-soldier-per-tick caller (targeting, morale, collision,
  // facing, threat facing) so the hot loop allocates nothing: the caller
  // owns one reusable scratch array and passes it in every tick.
  //
  // This is the biggest single CPU win in the sim at 2000 soldiers. The
  // previous version did `result.push(...bucket)` per cell — that is an
  // array allocation per query, plus a spread iterator per non-empty cell,
  // which at ~50 cells per query and 2000 queries per tick is ~100k
  // allocations and ~100k spread calls every 66 ms of sim time. Removing
  // it cuts the tick from the ~35ms targeting floor toward ~25ms, and also
  // kills the ~60-90ms GC pauses (raf= spikes in the frame diagnostic).
  // Fill `out` with nearby soldiers whose teamId !== excludeTeamId. Used
  // by targeting, which only ever wants enemies. Iterates ONLY the
  // per-team grids of other teams — allied soldiers are never touched.
  //
  // During march: ~0 iterations, because no enemy soldiers are anywhere
  // near the soldier's cells. That is the phase that costs 40ms today.
  // During melee: ~80 iterations instead of ~400, because the allied
  // half of the combined scan is skipped.
  queryNearbyIntoExcludingTeam(out, x, z, radiusInCells, excludeTeamId) {
    out.length = 0;
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);

    for (const [teamId, teamCells] of this.cellsByTeam) {
      if (teamId === excludeTeamId) continue;
      for (let dx = -radiusInCells; dx <= radiusInCells; dx++) {
        for (let dz = -radiusInCells; dz <= radiusInCells; dz++) {
          const key = (cx + dx) + ',' + (cz + dz);
          const bucket = teamCells.get(key);
          if (bucket) {
            for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
          }
        }
      }
    }

    return out;
  }

  // Zero-alloc combined-team query. Unchanged from before — used by
  // morale (needs both teams for outnumbering), collision (any soldier
  // can collide with any other), and anything else that reasons about
  // friend AND foe together.
  queryNearbyInto(out, x, z, radiusInCells = 1) {
    out.length = 0;
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);

    for (let dx = -radiusInCells; dx <= radiusInCells; dx++) {
      for (let dz = -radiusInCells; dz <= radiusInCells; dz++) {
        const key = (cx + dx) + ',' + (cz + dz);
        const bucket = this.cells.get(key);
        if (bucket) {
          // for-loop rather than spread — spread is an iterator call per
          // call site in V8 and costlier than the indexed loop for
          // buckets of any size.
          for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
        }
      }
    }

    return out;
  }
}
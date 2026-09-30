// Uniform grid for fast nearest-neighbor queries. Avoids O(n^2) distance checks.

export class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  _key(x, z) {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    return `${cx},${cz}`;
  }

  clear() {
    this.cells.clear();
  }

  insert(soldier) {
    const key = this._key(soldier.pos.x, soldier.pos.z);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(soldier);
  }

  rebuild(soldiers) {
    this.clear();
    for (const s of soldiers) {
      if (s.isAlive()) this.insert(s);
    }
  }

  // Returns soldiers within `radius` cells of (x,z), unfiltered by exact distance.
  queryNearby(x, z, radiusInCells = 1) {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    const result = [];

    for (let dx = -radiusInCells; dx <= radiusInCells; dx++) {
      for (let dz = -radiusInCells; dz <= radiusInCells; dz++) {
        const key = `${cx + dx},${cz + dz}`;
        const bucket = this.cells.get(key);
        if (bucket) result.push(...bucket);
      }
    }

    return result;
  }
}
import { TerrainType } from '../config/TerrainConfig.js';

// Per-vertex water data for TerrainWaterView, computed from the terrain's
// cell types. Pure data, no THREE.
//
// Output `data` holds 2 floats per region vertex:
//   wet    0..1  share of the 4 surrounding cells that are water. The water
//                surface is cut where this interpolates to about 0.45, which
//                gives a smooth shoreline instead of blocky cells.
//   depth  0..1  0 at the shore, 1 in the deep. Grows with the distance to
//                the nearest land cell, and deep-water cells start deep.

const SQRT2 = Math.SQRT2;
const SHORE_CELLS = 4;
const DEEP_FLOOR = 0.8;

function isWater(t) {
  return t === TerrainType.SHALLOW_WATER || t === TerrainType.DEEP_WATER;
}

// Chamfer distance (in cells) from every water cell to the nearest land cell.
function distanceToLand(types, cols, rows) {
  const N = cols * rows;
  const dist = new Float32Array(N);
  let any = false;
  for (let i = 0; i < N; i++) {
    if (isWater(types[i])) { dist[i] = 1e9; any = true; }
  }
  if (!any) return null;

  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      let d = dist[i];
      if (d === 0) continue;
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
      if (d === 0) continue;
      if (x < cols - 1) d = Math.min(d, dist[i + 1] + 1);
      if (z < rows - 1) {
        d = Math.min(d, dist[i + cols] + 1);
        if (x < cols - 1) d = Math.min(d, dist[i + cols + 1] + SQRT2);
        if (x > 0) d = Math.min(d, dist[i + cols - 1] + SQRT2);
      }
      dist[i] = d;
    }
  }
  return dist;
}

// Returns { hasWater, ix0, iz0, cx, cz, data }. The region is the same one
// TerrainSurfaceView covers, so the two meshes line up.
export function buildWaterField(terrain) {
  const { cols, rows, types } = terrain;
  const dist = distanceToLand(types, cols, rows);
  if (!dist) return { hasWater: false };

  const b = terrain.bounds;
  const cs = terrain.cellSize;
  const r = terrain.region || b;
  const ix0 = Math.max(0, Math.floor((r.minX - b.minX) / cs));
  const iz0 = Math.max(0, Math.floor((r.minZ - b.minZ) / cs));
  const ix1 = Math.min(cols, Math.ceil((r.maxX - b.minX) / cs));
  const iz1 = Math.min(rows, Math.ceil((r.maxZ - b.minZ) / cs));
  const cx = ix1 - ix0;
  const cz = iz1 - iz0;

  const cellDepth = new Float32Array(cols * rows);
  for (let i = 0; i < cellDepth.length; i++) {
    if (!isWater(types[i])) continue;
    const base = Math.min(1, Math.max(0, (dist[i] - 1) / SHORE_CELLS));
    cellDepth[i] = types[i] === TerrainType.DEEP_WATER ? Math.max(base, DEEP_FLOOR) : base;
  }

  const vx = cx + 1;
  const vz = cz + 1;
  const data = new Float32Array(vx * vz * 2);
  for (let j = 0; j < vz; j++) {
    for (let i = 0; i < vx; i++) {
      const gi = ix0 + i;
      const gj = iz0 + j;
      let count = 0;
      let depthSum = 0;
      for (let dz = -1; dz <= 0; dz++) {
        for (let dx = -1; dx <= 0; dx++) {
          const ci = gi + dx;
          const cj = gj + dz;
          if (ci < 0 || cj < 0 || ci >= cols || cj >= rows) continue;
          const c = cj * cols + ci;
          if (!isWater(types[c])) continue;
          count++;
          depthSum += cellDepth[c];
        }
      }
      const k = (j * vx + i) * 2;
      data[k] = count / 4;
      data[k + 1] = count > 0 ? depthSum / count : 0;
    }
  }
  return { hasWater: true, ix0, iz0, cx, cz, data };
}
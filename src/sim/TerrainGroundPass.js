import { TerrainType } from '../config/TerrainConfig.js';
import { BiomeList, BiomeSelection } from '../config/BiomeConfig.js';
import { fbm, hash2 } from './TerrainNoise.js';
import { TerrainHeightGenerator } from './TerrainHeightGenerator.js';

// First terrain pass: paints the ground type of every cell in the region
// from the noise fields and the biome that owns the cell. Returns a
// Uint8Array (one entry per terrain cell) with each cell's biome index.
//
// Three sub-passes:
//   1. biomeAt for every cell -> raw biome grid.
//   2. smooth the grid N times (BiomeSelection.transitionPasses) so biome
//      borders turn into soft bands instead of hard lines.
//   3. per-cell f (wet/forest/rocky/dry) + classify into a terrain type.
// The classification is done AFTER smoothing, so the ground rules follow
// the smoothed biome layout.

function classify(biome, f, shift) {
  const rules = biome.ground;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (f[r.field] > r.min + shift) return r.type;
  }
  // Biomes that want a non-grass fallback (oasis = pure sand) declare it
  // explicitly. Older biomes fall through to grass as before.
  return biome.defaultGround !== undefined ? biome.defaultGround : TerrainType.GRASS;
}

export const TerrainGroundPass = {
  paint(terrain, { seed, shift, region, biomeField, elevationOn }) {
    const cs = terrain.cellSize;
    const b = terrain.bounds;
    const cols = terrain.cols;
    const rows = terrain.rows;
    const ix0 = Math.max(0, Math.floor((region.minX - b.minX) / cs));
    const ix1 = Math.min(cols - 1, Math.floor((region.maxX - b.minX) / cs));
    const iz0 = Math.max(0, Math.floor((region.minZ - b.minZ) / cs));
    const iz1 = Math.min(rows - 1, Math.floor((region.maxZ - b.minZ) / cs));

    // --- Pass 1: raw biome grid (cheap, no field noise) ------------------
    const biomeGrid = new Uint8Array(cols * rows);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = terrain.cellCenterX(ix);
        const z = terrain.cellCenterZ(iz);
        biomeGrid[iz * cols + ix] = biomeField.biomeAt(x, z).index;
      }
    }

    // --- Pass 2: smooth (transition band) --------------------------------
    // Each pass moves the border one cell, so N passes create a band of
    // about N * cellSize world units on either side of the raw border.
    const passes = BiomeSelection.transitionPasses | 0;
    for (let p = 0; p < passes; p++) {
      this._smoothGrid(biomeGrid, cols, rows, ix0, ix1, iz0, iz1, seed + p * 17);
    }

    // --- Pass 3: field noise + classify ----------------------------------
    const f = { wet: 0, forest: 0, rocky: 0, dry: 0 };
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = terrain.cellCenterX(ix);
        const z = terrain.cellCenterZ(iz);

        // Domain-warp the noise lookup so octave peaks do not line up along
        // a diagonal and read as one long stripe of terrain.
        const wx = (fbm(x * 0.028 + 5.7, z * 0.028, seed * 7 + 47) - 0.5) * 24;
        const wz = (fbm(x * 0.028, z * 0.028 + 11.3, seed * 7 + 53) - 0.5) * 24;
        const px = x + wx, pz = z + wz;

        const valley = elevationOn
          ? (0.5 - TerrainHeightGenerator.rawHill(x, z, seed)) * 0.22
          : 0;
        f.wet = fbm(px * 0.048, pz * 0.048, seed * 3 + 137) + valley;
        f.forest = fbm(px * 0.072, pz * 0.072, seed * 3 + 587);
        f.rocky = fbm(px * 0.092, pz * 0.092, seed * 3 + 1291);
        f.dry = fbm(px * 0.062, pz * 0.062, seed * 3 + 2711);

        const idx = iz * cols + ix;
        const biome = BiomeList[biomeGrid[idx]];
        terrain.types[idx] = classify(biome, f, shift);
      }
    }

    return biomeGrid;
  },

  // One smoothing pass over the biome grid. A cell that is a minority in
  // its 3x3 neighbourhood flips to the local majority with 50% chance
  // (deterministic hash). Cells that already match the majority, or that
  // belong to a larger contiguous block, are left alone — only the
  // ragged single-cell fringes of a border move.
  _smoothGrid(grid, cols, rows, ix0, ix1, iz0, iz1, seed) {
    const copy = new Uint8Array(grid);
    const counts = new Uint8Array(16);

    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const idx = iz * cols + ix;
        const own = copy[idx];
        counts.fill(0);
        let maxCount = 0;
        let maxBiome = own;

        for (let dz = -1; dz <= 1; dz++) {
          const z2 = iz + dz;
          if (z2 < 0 || z2 >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x2 = ix + dx;
            if (x2 < 0 || x2 >= cols) continue;
            const nb = copy[z2 * cols + x2];
            counts[nb]++;
            if (counts[nb] > maxCount) {
              maxCount = counts[nb];
              maxBiome = nb;
            }
          }
        }

        // Minority (fewer than 4 of 9) and the majority is a different
        // biome: flip half the time, deterministic per (ix, iz, seed).
        if (maxBiome !== own && counts[own] < 4) {
          if (hash2(ix, iz, seed) < 0.5) grid[idx] = maxBiome;
        }
      }
    }
  }
};
// ===== TerrainHeightGenerator.js =====
import { TerrainType } from '../config/TerrainConfig.js';
import { fbm } from './TerrainNoise.js';

// Total relief (valley floor to hilltop) per preset, in world units. The
// biome field scales it locally (see BiomeField.reliefMultAt).
const RELIEF = { open: 4, normal: 8, rough: 14 };
// Hills fade to flat over this distance at the generated region's border.
const EDGE_FADE = 40;
// Lake level as a fraction of the preset relief.
const WATER_LEVEL_FRACTION = 0.18;
// Blur passes that turn the carved lake edge into a slope.
const SHORE_SMOOTH_PASSES = 2;

// Reject water cells whose every corner sits more than this far above the
// lake level. Without this guard, a stray wet cell on a hillside carves a
// pit down to lake level and leaves water surrounded by cliffs — the
// "floating water" bug seen in highland and any steep biome. 0.5 keeps
// genuine shore cells (one corner naturally low) while rejecting anything
// that would require a deep carve into high ground.
const FLOAT_MARGIN = 0.5;

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export const TerrainHeightGenerator = {
  reliefFor(preset) {
    return RELIEF[preset] ?? RELIEF.normal;
  },

  // 0..1 hill value without edge fade. The ground generator also uses it to
  // bias wetness so water collects in valleys.
  rawHill(x, z, seed) {
    // 0.010 produced one giant ridge across the whole map.
    // 0.030 gives several hills of playable size.
    const n = fbm(x * 0.030, z * 0.030, seed * 5 + 11);
    const v = (n - 0.3) / 0.4;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  },

  // reliefMultAt(x, z) -> number scales the hill height locally (biomes).
  generate(terrain, { seed, preset, region, reliefMultAt = null }) {
    const relief = this.reliefFor(preset);
    const cs = terrain.cellSize;
    const b = terrain.bounds;
    const H = terrain.height;
    const ix0 = Math.max(0, Math.floor((region.minX - b.minX) / cs));
    const ix1 = Math.min(terrain.cols, Math.ceil((region.maxX - b.minX) / cs));
    const iz0 = Math.max(0, Math.floor((region.minZ - b.minZ) / cs));
    const iz1 = Math.min(terrain.rows, Math.ceil((region.maxZ - b.minZ) / cs));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = b.minX + ix * cs;
        const z = b.minZ + iz * cs;
        const edge = Math.min(x - region.minX, region.maxX - x, z - region.minZ, region.maxZ - z);
        const f = smoothstep(0, EDGE_FADE, edge);
        if (f <= 0) { H.setVertex(ix, iz, 0); continue; }
        const mult = reliefMultAt ? reliefMultAt(x, z) : 1;
        H.setVertex(ix, iz, this.rawHill(x, z, seed) * relief * f * mult);
      }
    }
  },

  // Carve the terrain under water. Two passes so no water ever floats:
  //
  //   Pass 1 (reject): walk every water CELL. If its four corner vertices
  //   all sit more than FLOAT_MARGIN above `level`, that cell is not a
  //   real basin — it is a stray wet cell on a hillside. Replace it with
  //   GRASS. This kills the highland / jungle "pond on a hilltop" bug
  //   without any biome-specific config tweaks.
  //
  //   Pass 2 (carve): walk every VERTEX that touches at least one
  //   surviving water cell. Set its height to `level - depth` (or exactly
  //   `level` for a single-corner shore), which both lowers a hillside
  //   shore and raises a valley bed up to the lake level. The old
  //   one-directional version (only lower) left lowland wet cells
  //   floating above the ground below them.
  //
  // Call after ground types exist. Returns the lake level.
  carveWater(terrain, region, relief) {
    const level = relief * WATER_LEVEL_FRACTION;
    const { cols, rows, types } = terrain;
    const cs = terrain.cellSize;
    const b = terrain.bounds;
    const H = terrain.height;

    const cellIx0 = Math.max(0, Math.floor((region.minX - b.minX) / cs));
    const cellIx1 = Math.min(cols - 1, Math.ceil((region.maxX - b.minX) / cs));
    const cellIz0 = Math.max(0, Math.floor((region.minZ - b.minZ) / cs));
    const cellIz1 = Math.min(rows - 1, Math.ceil((region.maxZ - b.minZ) / cs));
    const vertIx1 = Math.min(cols, cellIx1);
    const vertIz1 = Math.min(rows, cellIz1);

    // ----- Pass 1: reject ISOLATED floating water cells ----------------
    // Water features (lakes, rivers, streams) are CONNECTED bodies —
    // every cell in them has at least one water neighbour. A stray wet
    // cell on a hillside, by contrast, has no water neighbour at all.
    // So: only reject water whose 8-neighbourhood contains NO other
    // water cell. That kills accidental water on high ground while
    // letting rivers and streams carve through hills unbroken.
    let rejected = 0;
    for (let iz = cellIz0; iz <= cellIz1; iz++) {
      for (let ix = cellIx0; ix <= cellIx1; ix++) {
        const idx = iz * cols + ix;
        const t = types[idx];
        if (t !== TerrainType.SHALLOW_WATER && t !== TerrainType.DEEP_WATER) continue;

        const vx1 = Math.min(ix + 1, cols);
        const vz1 = Math.min(iz + 1, rows);
        const hMin = Math.min(
          H.getVertex(ix, iz),
          H.getVertex(vx1, iz),
          H.getVertex(ix, vz1),
          H.getVertex(vx1, vz1)
        );
        if (hMin <= level + FLOAT_MARGIN) continue;

        // High-ground water: reject only if it has NO water neighbours.
        let waterNeighbors = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = ix + dx, nz = iz + dz;
            if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
            const nt = types[nz * cols + nx];
            if (nt === TerrainType.SHALLOW_WATER ||
                nt === TerrainType.DEEP_WATER) {
              waterNeighbors++;
            }
          }
        }
        if (waterNeighbors === 0) {
          types[idx] = TerrainType.GRASS;
          rejected++;
        }
      }
    }

    // ----- Pass 2: carve surviving water cells -------------------------
    // Interior depth targets, both well below the water surface.
    const SHALLOW_DEPTH = 0.30;
    const DEEP_DEPTH = 1.50;

    for (let iz = cellIz0; iz <= vertIz1; iz++) {
      for (let ix = cellIx0; ix <= vertIx1; ix++) {
        // Cell-level and vertex-level bounds differ by one, hence the
        // explicit cell count filter inside the neighbour scan.
        let shallow = 0, deep = 0;
        for (let dz = -1; dz <= 0; dz++) {
          for (let dx = -1; dx <= 0; dx++) {
            const cx = ix + dx, cz = iz + dz;
            if (cx < 0 || cz < 0 || cx >= cols || cz >= rows) continue;
            const t = types[cz * cols + cx];
            if (t === TerrainType.DEEP_WATER) deep++;
            else if (t === TerrainType.SHALLOW_WATER) shallow++;
          }
        }
        const total = shallow + deep;
        if (total === 0) continue;

        let target;
        if (deep > 0) {
          target = total === 1 ? level : level - DEEP_DEPTH;
        } else {
          target = total === 1 ? level : level - SHALLOW_DEPTH;
        }
        H.setVertex(ix, iz, target);
      }
    }

    // Soften the carved edge. Runs after both passes, so the shore
    // transitions are smooth and no vertex touching the water is left
    // above the water surface.
    H.smooth(cellIx0, vertIx1, cellIz0, vertIz1, SHORE_SMOOTH_PASSES);

    if (rejected > 0) {
      // Debug breadcrumb; visible in the console during tuning. Harmless
      // in production.
      // eslint-disable-next-line no-console
      console.log(`%c[terrain] rejected ${rejected} floating water cell(s)`,
        'color:#c88');
    }

    return level;
  }
};
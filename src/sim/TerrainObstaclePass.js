import { TerrainType, TerrainConfig } from '../config/TerrainConfig.js';
import { BiomeList } from '../config/BiomeConfig.js';
import { obstacleSignedDistance } from './TerrainGeometry.js';
import { fbm, hash2 } from './TerrainNoise.js';
import {
  RuinModels, RuinPatterns, RuinModelsByType,
  resolveRuinType, pickRandomRuinType
} from '../config/RuinConfig.js';
import {
  BiomeSceneryModels, BiomeSceneryPatterns,
  pickSceneryType, sceneryDensityFor
} from '../config/BiomeSceneryConfig.js';
import { pickTreeVariant } from '../config/BiomeTreeMix.js';
import { CombatConfig } from '../config/CombatConfig.js';

// Last terrain pass: wall runs, ruin patterns, then trees / rocks /
// columns / bushes / cacti / palms. Ruins go down before the scatter
// pass so trees and rocks fill in around the ruins, not through them.

const REFERENCE_AREA = 260 * 260;

// Obstacle density falloff past CombatConfig.mapBounds. The terrain
// buffer (TerrainConfig.region.minHalfExtent) extends 600 world units
// past the playable field so the player never sees the terrain edge.
// Obstacles in that buffer are decorative only — no gameplay reaches
// them — but placing them at full density there tripled the obstacle
// count for no visible benefit (fog and distance hide the difference
// beyond ~150 units past the boundary). This fade keeps the transition
// natural (density decays smoothly to zero over FADE_WIDTH units past
// the playable edge) while cutting buffer obstacle count by ~4x, which
// is the second-biggest per-frame cost after the terrain mesh itself.
const OBSTACLE_FADE_WIDTH = 200;

// 1.0 inside CombatConfig.mapBounds, linear falloff to 0 over the next
// OBSTACLE_FADE_WIDTH units, 0 beyond. Uses Chebyshev distance (max of
// X and Z overhang) so corners fade like edges.
function obstacleFalloff(x, z) {
  const mb = CombatConfig.mapBounds;
  const dx = x > mb.maxX ? x - mb.maxX : (x < mb.minX ? mb.minX - x : 0);
  const dz = z > mb.maxZ ? z - mb.maxZ : (z < mb.minZ ? mb.minZ - z : 0);
  const d = dx > dz ? dx : dz;
  if (d <= 0) return 1;
  if (d >= OBSTACLE_FADE_WIDTH) return 0;
  return 1 - d / OBSTACLE_FADE_WIDTH;
}

function placeWalls(terrain, { rng, preset, region, biomeField }) {
  const area = (region.maxX - region.minX) * (region.maxZ - region.minZ);
  const candidates = Math.max(0, Math.round(preset.walls * (area / REFERENCE_AREA) * 2));
  const isPlainGrass = (x, z) => terrain.typeAt(x, z) === TerrainType.GRASS;

  for (let k = 0; k < candidates; k++) {
    const sx = region.minX + 30 + rng() * (region.maxX - region.minX - 60);
    const sz = region.minZ + 30 + rng() * (region.maxZ - region.minZ - 60);
    const ang = rng() * Math.PI;
    const length = 24 + rng() * 36;
    const accept = rng();
    const fall = obstacleFalloff(sx, sz);
    if (fall <= 0) continue;
    if (accept >= biomeField.biomeAt(sx, sz).wallChance * fall) continue;

    const dx = Math.cos(ang), dz = Math.sin(ang);
    let pos = 0;
    while (pos < length) {
      const end = Math.min(length, pos + 8 + rng() * 10);
      const x1 = sx + dx * pos, z1 = sz + dz * pos;
      const x2 = sx + dx * end, z2 = sz + dz * end;
      if (isPlainGrass(x1, z1) && isPlainGrass(x2, z2) &&
          isPlainGrass((x1 + x2) / 2, (z1 + z2) / 2)) {
        terrain.addWall(x1, z1, x2, z2);
      }
      pos = end + 3.5 + rng() * 2; // gap wide enough for a narrow column
    }
  }
}

// Density of ruin patterns for a given biome + cell type, in SITES PER
// 10,000 CELLS. Returns 0 when no archetype is active, when the biome
// has no ruins block, or the cell type is not declared.
function ruinSiteDensity(biome, cellType) {
  if (!biome.ruins) return 0;
  switch (cellType) {
    case TerrainType.GRASS:        return biome.ruins.onGrass        || 0;
    case TerrainType.ROCKY:        return biome.ruins.onRocky        || 0;
    case TerrainType.SAND:         return biome.ruins.onSand         || 0;
    case TerrainType.MUD:          return biome.ruins.onMud          || 0;
    case TerrainType.FOREST_FLOOR: return biome.ruins.onForestFloor  || 0;
    default:                       return 0;
  }
}

// Lay a single ruin pattern down at (ax, az), rotated by `rot`. Each
// part is one ruin obstacle; parts that would collide with an existing
// obstacle are skipped so a pattern gracefully degrades inside a dense
// forest instead of overwriting trees with ruins.
function placePattern(terrain, ax, az, rot, typeId, rng) {
  const pattern = RuinPatterns[typeId];
  if (!pattern) return;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);

  const nearBuf = [];
  const tooClose = (x, z, r) => {
    terrain.queryObstacles(x, z, r + 1, nearBuf);
    for (const o of nearBuf) if (obstacleSignedDistance(o, x, z) < r) return true;
    return false;
  };

  for (const part of pattern.parts) {
    const model = RuinModels[part.model];
    if (!model) continue;

    // Rotate the part offset around the anchor.
    const x = ax + part.dx * cosR - part.dz * sinR;
    const z = az + part.dx * sinR + part.dz * cosR;

    // Skip parts that would land inside an existing obstacle. These
    // are usually trees placed by a previous pass, but the check is
    // generic so the pattern respects any prior obstacle.
    if (tooClose(x, z, model.collision * 0.9)) continue;

    const scale = 0.9 + rng() * 0.2;
    terrain.addRuin(
      x, z, part.model,
      model.collision * scale,
      model.height * scale,
      rot + rng() * 0.15
    );
  }
}

// Second pass: pick ruin pattern anchors, then open a pattern at each.
//
// A candidate anchor is a terrain cell whose biome declares a ruins
// density for its ground type. Whether the anchor actually becomes a
// site is a per-cell roll against `density / 10000` — small enough that
// patterns are sparse, large enough that a City Ruins biome still reads
// as a ruined city.
function placeRuins(terrain, { rng, preset, region, biomeGrid, seed, ruinType }) {
  // 'none' disables ruin placement everywhere, including City Ruins.
  // (The UI hides this combination — City Ruins forces 'mixed' — but a
  // scenario or a stale save can still pass 'none' through.)
  if (ruinType === 'none') return;

  const cs = terrain.cellSize;
  const b = terrain.bounds;
  const mult = preset.obstacleMult;
  const ix0 = Math.max(0, Math.floor((region.minX - b.minX) / cs));
  const ix1 = Math.min(terrain.cols - 1, Math.floor((region.maxX - b.minX) / cs));
  const iz0 = Math.max(0, Math.floor((region.minZ - b.minZ) / cs));
  const iz1 = Math.min(terrain.rows - 1, Math.floor((region.maxZ - b.minZ) / cs));

  // Fallback for biomes that do not carry their own ruinType: resolve
  // the battle-wide choice once from the seed.
  const fallbackType = resolveRuinType(ruinType, seed);

  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const idx = iz * terrain.cols + ix;
      const t = terrain.types[idx];
      const biome = BiomeList[biomeGrid[idx]];
      const density = ruinSiteDensity(biome, t);
      if (density <= 0) continue;

      // Per-cell probability of a site = density / 10000 × preset scale.
      // rng() call happens on every cell that COULD host a site, so the
      // random stream stays deterministic per (seed, ix, iz) even when
      // the previous cell placement changed the tree RNG stream.
      const cxc = terrain.cellCenterX(ix);
      const czc = terrain.cellCenterZ(iz);
      const fall = obstacleFalloff(cxc, czc);
      if (fall <= 0) continue;
      const p = (density / 10000) * mult * fall;
      if (rng() >= p) continue;

      // Pick the archetype for this site. City Ruins (ruinType:
      // 'mixed') picks a different type per anchor; every other biome
      // uses its own ruinType if set, else the battle-wide choice.
      let siteType;
      if (biome.ruinType === 'mixed') {
        siteType = pickRandomRuinType(seed, ix, iz);
      } else if (biome.ruinType) {
        siteType = biome.ruinType;
      } else {
        siteType = fallbackType;
      }
      if (!siteType || siteType === 'none' || !RuinPatterns[siteType]) continue;

      // Anchor point: cell centre with a small jitter so patterns do
      // not sit in an obvious grid. Rotation is uniform.
      const ax = terrain.cellCenterX(ix) + (rng() - 0.5) * cs * 0.4;
      const az = terrain.cellCenterZ(iz) + (rng() - 0.5) * cs * 0.4;
      const rot = rng() * Math.PI * 2;

      placePattern(terrain, ax, az, rot, siteType, rng);
    }
  }
}

// Fourth pass: camp-style scenery sites (tents, graveyards, towers, etc.)
// built from the camp prop library. Per-biome density in
// BiomeSceneryConfig.BiomeSceneryByBiome; per-site layout in
// BiomeSceneryPatterns. Runs AFTER placeRuins so pattern parts avoid
// ruin obstacles, and BEFORE placeScatter so trees / rocks avoid the
// scenery parts. Each part becomes its own circular obstacle — units can
// path between tents, not around the whole camp footprint.
function placeBiomeScenery(terrain, { rng, preset, region, biomeGrid, seed }) {
  const T = TerrainType;
  const cs = terrain.cellSize;
  const b = terrain.bounds;
  const mult = preset.obstacleMult;
  const ix0 = Math.max(0, Math.floor((region.minX - b.minX) / cs));
  const ix1 = Math.min(terrain.cols - 1, Math.floor((region.maxX - b.minX) / cs));
  const iz0 = Math.max(0, Math.floor((region.minZ - b.minZ) / cs));
  const iz1 = Math.min(terrain.rows - 1, Math.floor((region.maxZ - b.minZ) / cs));

  const typeToKey = {
    [T.GRASS]:        'onGrass',
    [T.SAND]:         'onSand',
    [T.FOREST_FLOOR]: 'onForestFloor',
    [T.MUD]:          'onMud',
    [T.ROCKY]:        'onRocky'
  };

  // Site registry to reject overlapping patterns. Site radius is the max
  // distance from anchor to any part; two patterns whose radii overlap
  // could visually clash.
  const placedSites = [];
  const nearBuf = [];

  const tooClose = (x, z, r) => {
    for (let i = 0; i < placedSites.length; i++) {
      const s = placedSites[i];
      const dx = s.x - x;
      const dz = s.z - z;
      const sum = s.radius + r;
      if (dx * dx + dz * dz < sum * sum) return true;
    }
    terrain.queryObstacles(x, z, r + 1, nearBuf);
    for (let i = 0; i < nearBuf.length; i++) {
      if (obstacleSignedDistance(nearBuf[i], x, z) < r) return true;
    }
    return false;
  };

  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const idx = iz * terrain.cols + ix;
      const t = terrain.types[idx];
      const biome = BiomeList[biomeGrid[idx]];
      const key = typeToKey[t];
      if (!key) continue;
      const density = sceneryDensityFor(biome.id, key);
      if (density <= 0) continue;

      const cxc = terrain.cellCenterX(ix);
      const czc = terrain.cellCenterZ(iz);
      const fall = obstacleFalloff(cxc, czc);
      if (fall <= 0) continue;
      const p = (density / 10000) * mult * fall;
      if (rng() >= p) continue;

      const siteType = pickSceneryType(biome, ix, iz, seed);
      if (!siteType) continue;
      const pattern = BiomeSceneryPatterns[siteType];
      if (!pattern) continue;

      const ax = terrain.cellCenterX(ix) + (rng() - 0.5) * cs * 0.4;
      const az = terrain.cellCenterZ(iz) + (rng() - 0.5) * cs * 0.4;
      const rot = rng() * Math.PI * 2;

      // Reject if the anchor overlaps any existing site / obstacle.
      if (tooClose(ax, az, pattern.radius * 0.5)) continue;

      placeSceneryPattern(terrain, ax, az, rot, pattern, rng, tooClose);
      placedSites.push({ x: ax, z: az, radius: pattern.radius });
    }
  }
}

function placeSceneryPattern(terrain, ax, az, rot, pattern, rng, tooClose) {
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);

  for (let i = 0; i < pattern.parts.length; i++) {
    const part = pattern.parts[i];
    const model = BiomeSceneryModels[part.model];
    if (!model) continue;

    const x = ax + part.dx * cosR - part.dz * sinR;
    const z = az + part.dx * sinR + part.dz * cosR;

    // Part-level rejection: skip a single part that lands inside an
    // existing obstacle rather than dropping the whole site.
    if (tooClose(x, z, model.collision * 0.9)) continue;

    terrain.addScenery(
      x, z, part.model,
      model.collision,
      model.height,
      rot + rng() * 0.15
    );
  }
}

function placeScatter(terrain, { rng, preset, region, biomeGrid, seed }) {
  const cs = terrain.cellSize;
  const b = terrain.bounds;
  const baseMult = preset.obstacleMult;
  const ix0 = Math.max(0, Math.floor((region.minX - b.minX) / cs));
  const ix1 = Math.min(terrain.cols - 1, Math.floor((region.maxX - b.minX) / cs));
  const iz0 = Math.max(0, Math.floor((region.minZ - b.minZ) / cs));
  const iz1 = Math.min(terrain.rows - 1, Math.floor((region.maxZ - b.minZ) / cs));

  const nearBuf = [];
  const nearAnything = (x, z, r) => {
    terrain.queryObstacles(x, z, r + 2, nearBuf);
    for (const o of nearBuf) if (obstacleSignedDistance(o, x, z) < r) return true;
    return false;
  };

  const has = (biome, cat, key) => biome[cat] && biome[cat][key] > 0;

  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const idx = iz * terrain.cols + ix;
      const t = terrain.types[idx];
      const biome = BiomeList[biomeGrid[idx]];
      const x = terrain.cellCenterX(ix) + (rng() - 0.5) * cs * 0.9;
      const z = terrain.cellCenterZ(iz) + (rng() - 0.5) * cs * 0.9;

      // Buffer density falloff. Cells with zero falloff skip everything
      // below (including the per-cell RNG draws), so the buffer past
      // OBSTACLE_FADE_WIDTH contributes no obstacles at all. `mult` is
      // re-declared here to shadow the function-scope baseMult — every
      // placement threshold below picks up the falloff automatically.
      const fall = obstacleFalloff(x, z);
      if (fall <= 0) continue;
      const mult = baseMult * fall;

      // Organic clumping: local density multiplier so some patches are
      // dense and others clearings. Only modulates trees / rocks - bushes
      // and cacti are small and read better uniformly scattered.
      const clump = fbm(x * 0.045, z * 0.045, seed * 5 + 911);
      const clumpMul = 0.35 + clump * 1.0; // 0.35 .. 1.35

      const roll = rng();
      const roll2 = rng();
      const rotRoll = rng();
      const sizeRoll = rng();
      const extraRoll = rng();

      const treeP = (base) => base * mult * clumpMul;
      // Biome-level tree size multiplier (jungle uses 2.2 for oversized
      // canopy trees). Defaults to 1.
      const treeScale = biome.treeScale || 1;

      if (t === TerrainType.FOREST_FLOOR) {
        if (has(biome, 'palms', 'onForestFloor') && roll < biome.palms.onForestFloor * mult) {
          if (!nearAnything(x, z, 1.4)) terrain.addPalm(x, z, 0.9 + sizeRoll * 0.4);
        } else if (roll < treeP(biome.trees.onForestFloor) && !nearAnything(x, z, 1.2 * treeScale)) {
          terrain.addTree(
            x, z,
            (0.8 + sizeRoll * 0.6) * treeScale,
            pickTreeVariant(biome.id, hash2(ix, iz, seed + 777))
          );
        } else if (has(biome, 'bushes', 'onForestFloor') && extraRoll < biome.bushes.onForestFloor * mult) {
          if (!nearAnything(x, z, 0.8)) terrain.addBush(x, z, 0.8 + sizeRoll * 0.5);
        }
      } else if (t === TerrainType.GRASS) {
        if (has(biome, 'palms', 'onGrass') && roll < biome.palms.onGrass * mult) {
          if (!nearAnything(x, z, 1.4)) terrain.addPalm(x, z, 0.9 + sizeRoll * 0.4);
        } else if (roll < treeP(biome.trees.onGrass) && !nearAnything(x, z, 1.5 * treeScale)) {
          terrain.addTree(
            x, z,
            (0.9 + sizeRoll * 0.5) * treeScale,
            pickTreeVariant(biome.id, hash2(ix, iz, seed + 777))
          );
        } else if (has(biome, 'cacti', 'onGrass') && roll2 < biome.cacti.onGrass * mult) {
          if (!nearAnything(x, z, 0.8)) terrain.addCactus(x, z, 0.8 + sizeRoll * 0.5);
        } else if (has(biome, 'bushes', 'onGrass') && extraRoll < biome.bushes.onGrass * mult) {
          if (!nearAnything(x, z, 0.8)) terrain.addBush(x, z, 0.8 + sizeRoll * 0.5);
        } else if (roll2 < biome.rocks.onGrass * mult * clumpMul && !nearAnything(x, z, 1.5)) {
          terrain.addRock(x, z, 0.6 + sizeRoll * 0.6, rotRoll * 6.28);
        }
      } else if (t === TerrainType.MUD) {
        if (roll < treeP(biome.trees.onMud) && !nearAnything(x, z, 1.2 * treeScale)) {
          terrain.addTree(
            x, z,
            (0.7 + sizeRoll * 0.5) * treeScale,
            pickTreeVariant(biome.id, hash2(ix, iz, seed + 777))
          );
        }
      } else if (t === TerrainType.SAND) {
        if (has(biome, 'cacti', 'onSand') && roll < biome.cacti.onSand * mult) {
          if (!nearAnything(x, z, 0.8)) terrain.addCactus(x, z, 0.8 + sizeRoll * 0.5);
        } else if (has(biome, 'bushes', 'onSand') && extraRoll < biome.bushes.onSand * mult) {
          if (!nearAnything(x, z, 0.8)) terrain.addBush(x, z, 0.7 + sizeRoll * 0.4);
        } else if (roll2 < biome.rocks.onSand * mult && !nearAnything(x, z, 1.5)) {
          terrain.addRock(x, z, 0.6 + sizeRoll * 0.6, rotRoll * 6.28);
        }
      } else if (t === TerrainType.ROCKY) {
        if (roll < biome.rocks.onRocky * mult * clumpMul && !nearAnything(x, z, 1.5)) {
          const rc = TerrainConfig.rock;
          const r = rc.minRadius + sizeRoll * sizeRoll * (rc.maxRadius - rc.minRadius);
          terrain.addRock(x, z, r, rotRoll * 6.28);
        }
      }
    }
  }
}

export const TerrainObstaclePass = {
  place(terrain, ctx) {
    placeWalls(terrain, ctx);
    // Ruins first, then trees / rocks, so the scatter pass can check
    // against the ruin obstacles and avoid placing a tree inside a
    // pattern part. (placeScatter's nearAnything already covers this;
    // ordering just makes the intent explicit.)
    placeRuins(terrain, ctx);
    // Biome scenery runs between ruins and scatter: it avoids ruin
    // obstacles (placed above), and trees / rocks (below) avoid it.
    placeBiomeScenery(terrain, ctx);
    placeScatter(terrain, ctx);
  }
};
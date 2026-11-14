// ===== TerrainFeaturePass.js =====
// Structural feature placement. Runs BETWEEN the ground pass (biome cell
// types) and the water carve (which lowers terrain under water).
//
// Features modify CELL TYPES so the obstacle pass can then respond
// naturally: a painted SHALLOW_WATER cell will not get trees; a painted
// FOREST_FLOOR cell will get dense trees; a painted GRASS patch cut out
// of a forest reads as a clearing.
//
// Features may also place landmark obstacles directly (fallen logs,
// large trees at a cluster's centre, rocks along a ridge). These run
// before the obstacle pass, so the obstacle pass's `nearAnything` check
// avoids stacking a regular tree on top of a landmark.
//
// Two special anchoring mechanisms:
//   - placePond records terrain._pondPositions, which placePalmRing
//     reads to ring palms around an actual pond.
//   - paintRiver records terrain._riverPath, which placeBankMarsh,
//     placeOxbow and placeRiverbank read to hug the river bank.
//
// placeHeight runs AFTER carveWater for features that raise the terrain
// (dune ridges). Cell-type features run BEFORE carveWater so any water
// they paint gets its terrain bed lowered the same way biome-lakes do.

import { TerrainType } from '../config/TerrainConfig.js';
import { BiomeList } from '../config/BiomeConfig.js';
import { BiomeFeatures, BiomeHeightFeatures } from '../config/BiomeFeatures.js';

const CELLS_PER_FEATURE_CAP = 1500;

const DRY_GROUND = new Set([
  TerrainType.GRASS, TerrainType.FOREST_FLOOR, TerrainType.ROCKY,
  TerrainType.SAND, TerrainType.MUD
]);
const GRASS_LIKE = new Set([TerrainType.GRASS, TerrainType.FOREST_FLOOR]);
const FOREST_ONLY = new Set([TerrainType.FOREST_FLOOR]);
const WET_LIKE = new Set([TerrainType.SHALLOW_WATER, TerrainType.MUD]);

function paintConditional(terrain, cx, cz, r, newType, allowed) {
  const cs = terrain.cellSize;
  const b = terrain.bounds;
  const ix0 = Math.max(0, Math.floor((cx - r - b.minX) / cs));
  const ix1 = Math.min(terrain.cols - 1, Math.floor((cx + r - b.minX) / cs));
  const iz0 = Math.max(0, Math.floor((cz - r - b.minZ) / cs));
  const iz1 = Math.min(terrain.rows - 1, Math.floor((cz + r - b.minZ) / cs));
  const r2 = r * r;
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const dx = terrain.cellCenterX(ix) - cx;
      const dz = terrain.cellCenterZ(iz) - cz;
      if (dx * dx + dz * dz > r2) continue;
      const idx = iz * terrain.cols + ix;
      if (allowed.has(terrain.types[idx])) terrain.types[idx] = newType;
    }
  }
}

function pickRange([min, max], rng) {
  return min + rng() * (max - min);
}

function rollCount([min, max], rng) {
  return min + Math.floor(rng() * (max - min + 1));
}

function effectiveCount(countSpec, cellCount, rng) {
  const rolled = rollCount(countSpec, rng);
  const cap = Math.max(1, Math.floor(cellCount / CELLS_PER_FEATURE_CAP));
  return Math.min(rolled, cap);
}

function pickAnchor(cells, terrain, rng) {
  const cell = cells[Math.floor(rng() * cells.length)];
  return {
    x: terrain.cellCenterX(cell.ix),
    z: terrain.cellCenterZ(cell.iz)
  };
}

function biomeRadius(cells, cellSize) {
  return Math.sqrt(cells.length / Math.PI) * cellSize;
}

function randomOffset(radius, rng) {
  const angle = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * radius;
  return { x: Math.cos(angle) * r, z: Math.sin(angle) * r };
}

// Given a river path and a sample index, return the unit normal and the
// point, so placers can step off the path perpendicular to its flow.
function riverSample(path, rng) {
  const idx = Math.floor(rng() * path.length);
  const pt = path[idx];
  const next = path[Math.min(idx + 8, path.length - 1)] || pt;
  const ddx = next.x - pt.x;
  const ddz = next.z - pt.z;
  const len = Math.hypot(ddx, ddz) || 1;
  return { pt, nx: -ddz / len, nz: ddx / len };
}

// --- Placer functions -------------------------------------------------

function placeStream(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const biomeR = biomeRadius(cells, terrain.cellSize);
  const length = Math.min(pickRange(spec.length, rng), biomeR * 2.5);
  const width = pickRange(spec.width, rng);

  const halfWidth = width * 0.5;
  const bankWidth = halfWidth + 1.2;
  const mudWidth = bankWidth + 1.0;

  const angle = (rng() - 0.5) * 0.9;
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);

  const meanderAmp = 3 + rng() * 6;
  const meanderFreq = 0.06 + rng() * 0.04;
  const meanderPhase = rng() * Math.PI * 2;

  const step = 1.5;
  const steps = Math.ceil(length / step);
  for (let i = 0; i <= steps; i++) {
    const t = i * step - length * 0.5;
    const perp = Math.sin(t * meanderFreq + meanderPhase) * meanderAmp;
    const x = start.x + dx * t - dz * perp;
    const z = start.z + dz * t + dx * perp;
    if (x < region.minX || x > region.maxX ||
        z < region.minZ || z > region.maxZ) continue;

    paintConditional(terrain, x, z, mudWidth, TerrainType.MUD, DRY_GROUND);
    paintConditional(terrain, x, z, bankWidth, TerrainType.SHALLOW_WATER, DRY_GROUND);
    paintConditional(terrain, x, z, halfWidth, TerrainType.DEEP_WATER, DRY_GROUND);
  }
}

function placePond(terrain, rng, region, cells, spec) {
  // Filter to edge-safe anchors once when the spec sets a margin. Oasis
  // uses this so a 50-unit-wide oasis never spills off the map edge.
  // Falls back to the full cell list if the filter empties (a biome that
  // fills only an edge region would otherwise place nothing).
  let anchors = cells;
  if (spec.minEdgeDistance) {
    const md = spec.minEdgeDistance;
    const filtered = [];
    for (const c of cells) {
      const x = terrain.cellCenterX(c.ix);
      const z = terrain.cellCenterZ(c.iz);
      if (x - region.minX >= md && region.maxX - x >= md &&
          z - region.minZ >= md && region.maxZ - z >= md) {
        filtered.push(c);
      }
    }
    if (filtered.length > 0) anchors = filtered;
  }

  const radius = pickRange(spec.radius, rng);

  // Try a handful of anchors so multiple ponds do not overlap. If every
  // attempt collides with an existing pond, skip this placement — the
  // pond count in BiomeFeatures is a maximum, not a minimum.
  let start = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const cell = anchors[Math.floor(rng() * anchors.length)];
    const candidate = {
      x: terrain.cellCenterX(cell.ix),
      z: terrain.cellCenterZ(cell.iz)
    };
    let overlaps = false;
    if (terrain._pondPositions) {
      for (const p of terrain._pondPositions) {
        if (Math.hypot(candidate.x - p.x, candidate.z - p.z) <
            (p.radius + radius) * 2.2) {
          overlaps = true;
          break;
        }
      }
    }
    if (!overlaps) { start = candidate; break; }
  }
  if (!start) return;

  // Optional grass ring, applied BEFORE the water layers so the water
  // overwrites the centre. Used by Oasis where the surrounding ground
  // is pure sand and the ring gives the pond a lush green halo.
  if (spec.grassRing) {
    paintConditional(terrain, start.x, start.z, radius * 1.9, TerrainType.GRASS, DRY_GROUND);
  }

  paintConditional(terrain, start.x, start.z, radius * 1.3, TerrainType.MUD, DRY_GROUND);
  paintConditional(terrain, start.x, start.z, radius, TerrainType.SHALLOW_WATER, DRY_GROUND);
  paintConditional(terrain, start.x, start.z, radius * 0.6, TerrainType.DEEP_WATER, DRY_GROUND);

  // Record for palmRing (and any future placer that wants to sit around
  // a pond). Each entry: { x, z, radius }.
  if (!terrain._pondPositions) terrain._pondPositions = [];
  terrain._pondPositions.push({ x: start.x, z: start.z, radius });
}

function placeClearing(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const radius = pickRange(spec.radius, rng);
  paintConditional(terrain, start.x, start.z, radius, TerrainType.GRASS, FOREST_ONLY);
}

function placeTreeCluster(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const radius = pickRange(spec.radius, rng);

  paintConditional(terrain, start.x, start.z, radius, TerrainType.FOREST_FLOOR, GRASS_LIKE);

  const count = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < count; i++) {
    const off = randomOffset(radius * 0.65, rng);
    terrain.addTree(start.x + off.x, start.z + off.z, 1.0 + rng() * 0.3);
  }
}

function placeRockOutcrop(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const radius = pickRange(spec.radius, rng);

  paintConditional(terrain, start.x, start.z, radius, TerrainType.ROCKY, GRASS_LIKE);

  const count = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    const off = randomOffset(radius * 0.6, rng);
    const r = 1.0 + rng() * 1.2;
    terrain.addRock(start.x + off.x, start.z + off.z, r, rng() * Math.PI * 2);
  }
}

function placeShrubCluster(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const radius = pickRange(spec.radius, rng);
  const count = Math.floor(radius * radius * 0.6);
  for (let i = 0; i < count; i++) {
    const off = randomOffset(radius, rng);
    terrain.addBush(start.x + off.x, start.z + off.z, 0.7 + rng() * 0.5);
  }
}

function placePalmGrove(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const radius = pickRange(spec.radius, rng);
  const count = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i++) {
    const off = randomOffset(radius * 0.8, rng);
    terrain.addPalm(start.x + off.x, start.z + off.z, 0.9 + rng() * 0.4);
  }
}

// Palms arranged in a ring around every pond. Reads _pondPositions
// (populated by placePond). No-op when no ponds exist. Used by Oasis:
// each pond gets its own ring so a map with 3 oases gets 3 rings.
//
// Palm count scales with pond radius so bigger oases look proportionally
// lush — a 28-unit pond gets ~20 palms around it, a 18-unit one gets
// ~12. The ring sits at 1.55x the pond radius, inside the grass halo
// (which extends to 1.9x) and outside the mud rim (1.3x).
function placePalmRing(terrain, rng, region, cells, spec) {
  const ponds = terrain._pondPositions;
  if (!ponds || ponds.length === 0) return;

  for (const pond of ponds) {
    const ringRadius = pond.radius * 1.55 + rng() * 2;
    const count = Math.max(12, Math.floor(pond.radius * 0.75));
    const baseAngle = rng() * Math.PI * 2;

    for (let i = 0; i < count; i++) {
      const angle = baseAngle + (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.35;
      const r = ringRadius + (rng() - 0.5) * 2;
      const x = pond.x + Math.cos(angle) * r;
      const z = pond.z + Math.sin(angle) * r;
      terrain.addPalm(x, z, 0.9 + rng() * 0.4);
    }
  }
}

function placeDryWash(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const biomeR = biomeRadius(cells, terrain.cellSize);
  const length = Math.min(pickRange(spec.length, rng), biomeR * 2.5);
  const width = pickRange(spec.width, rng);
  const halfWidth = width * 0.5;

  const angle = (rng() - 0.5) * 0.9;
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const meanderAmp = 2 + rng() * 4;
  const meanderFreq = 0.05 + rng() * 0.03;
  const meanderPhase = rng() * Math.PI * 2;

  const step = 1.5;
  const steps = Math.ceil(length / step);
  for (let i = 0; i <= steps; i++) {
    const t = i * step - length * 0.5;
    const perp = Math.sin(t * meanderFreq + meanderPhase) * meanderAmp;
    const x = start.x + dx * t - dz * perp;
    const z = start.z + dz * t + dx * perp;
    if (x < region.minX || x > region.maxX ||
        z < region.minZ || z > region.maxZ) continue;
    paintConditional(terrain, x, z, halfWidth, TerrainType.SAND, GRASS_LIKE);
  }
}

function placeRidge(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const biomeR = biomeRadius(cells, terrain.cellSize);
  const length = Math.min(pickRange(spec.length, rng), biomeR * 2.5);
  const width = pickRange(spec.width, rng);
  const halfWidth = width * 0.5;

  const angle = rng() * Math.PI;
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);

  const step = 1.5;
  const steps = Math.ceil(length / step);
  const rockCount = Math.max(3, Math.floor(length / 10));

  for (let i = 0; i <= steps; i++) {
    const t = i * step - length * 0.5;
    const x = start.x + dx * t;
    const z = start.z + dz * t;
    if (x < region.minX || x > region.maxX ||
        z < region.minZ || z > region.maxZ) continue;
    paintConditional(terrain, x, z, halfWidth, TerrainType.ROCKY, GRASS_LIKE);
  }

  const seg = length / rockCount;
  for (let i = 0; i < rockCount; i++) {
    const t = i * seg - length * 0.5 + seg * 0.5;
    const perp = (rng() - 0.5) * width;
    const x = start.x + dx * t - dz * perp;
    const z = start.z + dz * t + dx * perp;
    if (x < region.minX || x > region.maxX ||
        z < region.minZ || z > region.maxZ) continue;
    const r = 0.9 + rng() * 1.5;
    terrain.addRock(x, z, r, rng() * Math.PI * 2);
  }
}

function placeCauseway(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const biomeR = biomeRadius(cells, terrain.cellSize);
  const length = Math.min(pickRange(spec.length, rng), biomeR * 2.5);
  const width = pickRange(spec.width, rng);
  const halfWidth = width * 0.5;

  const angle = (rng() - 0.5) * 1.2;
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);

  const step = 1.5;
  const steps = Math.ceil(length / step);
  for (let i = 0; i <= steps; i++) {
    const t = i * step - length * 0.5;
    const x = start.x + dx * t;
    const z = start.z + dz * t;
    if (x < region.minX || x > region.maxX ||
        z < region.minZ || z > region.maxZ) continue;
    paintConditional(terrain, x, z, halfWidth, TerrainType.GRASS, WET_LIKE);
  }
}

function placeMarshPatch(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const radius = pickRange(spec.radius, rng);
  paintConditional(terrain, start.x, start.z, radius, TerrainType.MUD, GRASS_LIKE);
  paintConditional(terrain, start.x, start.z, radius * 0.6, TerrainType.SHALLOW_WATER, DRY_GROUND);
}

// Marsh patch anchored to the river bank. No-op when the battle has no
// river. Picks a sample point along the river, offsets perpendicular
// from the bank, and paints mud + shallow water there.
function placeBankMarsh(terrain, rng, region, cells, spec) {
  const path = terrain._riverPath;
  if (!path || path.length === 0) return;

  const { pt, nx, nz } = riverSample(path, rng);
  const side = rng() < 0.5 ? 1 : -1;
  const offset = pt.bankWidth + 2 + rng() * 6;
  const cx = pt.x + nx * side * offset;
  const cz = pt.z + nz * side * offset;

  const radius = pickRange(spec.radius, rng);
  paintConditional(terrain, cx, cz, radius, TerrainType.MUD, GRASS_LIKE);
  paintConditional(terrain, cx, cz, radius * 0.6, TerrainType.SHALLOW_WATER, DRY_GROUND);
}

// Oxbow: a small water body next to the river. Reads terrain._riverPath
// (recorded by paintRiver), picks a random sample along it, offsets
// perpendicular to the river, and paints a small pond there. No-op when
// no river exists.
function placeOxbow(terrain, rng, region, cells, spec) {
  const path = terrain._riverPath;
  if (!path || path.length === 0) return;

  const { pt, nx, nz } = riverSample(path, rng);
  const side = rng() < 0.5 ? 1 : -1;
  const offset = (pt.bankWidth + 3 + rng() * 6) * side;
  const cx = pt.x + nx * offset;
  const cz = pt.z + nz * offset;

  const radius = pickRange(spec.radius, rng);

  paintConditional(terrain, cx, cz, radius * 1.3, TerrainType.MUD, DRY_GROUND);
  paintConditional(terrain, cx, cz, radius, TerrainType.SHALLOW_WATER, DRY_GROUND);
  paintConditional(terrain, cx, cz, radius * 0.5, TerrainType.DEEP_WATER, DRY_GROUND);
}

// Dense vegetation along the river banks. Picks N random points along
// the river, offsets perpendicular from the bank, and places a small
// cluster of trees + bushes at each. No-op when no river exists.
function placeRiverbank(terrain, rng, region, cells, spec) {
  const path = terrain._riverPath;
  if (!path || path.length === 0) return;

  const clusters = rollCount(spec.count, rng);
  const treesPerCluster = 3 + Math.floor(rng() * 3);
  const bushesPerCluster = 2 + Math.floor(rng() * 2);

  for (let c = 0; c < clusters; c++) {
    const { pt, nx, nz } = riverSample(path, rng);
    const side = rng() < 0.5 ? 1 : -1;

    // Trees sit just past the mud rim.
    const treeOffset = pt.bankWidth + 1.5 + rng() * 4;
    const cx = pt.x + nx * side * treeOffset;
    const cz = pt.z + nz * side * treeOffset;

    for (let i = 0; i < treesPerCluster; i++) {
      const off = randomOffset(3 + rng() * 3, rng);
      const tx = cx + off.x;
      const tz = cz + off.z;
      const t = terrain.typeAt(tx, tz);
      if (t === TerrainType.GRASS || t === TerrainType.FOREST_FLOOR) {
        terrain.addTree(tx, tz, 0.9 + rng() * 0.4);
      }
    }

    // Bushes hug the water's edge (mud or shallow rim).
    for (let i = 0; i < bushesPerCluster; i++) {
      const edgeOffset = pt.bankWidth + 0.5 + rng() * 1.5;
      const bx = pt.x + nx * side * edgeOffset + (rng() - 0.5) * 2;
      const bz = pt.z + nz * side * edgeOffset + (rng() - 0.5) * 2;
      terrain.addBush(bx, bz, 0.7 + rng() * 0.5);
    }
  }
}

// Fallen logs: short rotated WALL segments, rendered as horizontal
// cylinders by TerrainObstacleView.
function placeFallenLog(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const length = pickRange(spec.length, rng);
  const angle = rng() * Math.PI * 2;
  const dx = Math.cos(angle) * length / 2;
  const dz = Math.sin(angle) * length / 2;
  terrain.addFallenLog(
    start.x - dx, start.z - dz,
    start.x + dx, start.z + dz
  );
}

// Sun shrine (grassland): one tall column at the centre of a stone ring.
// Landmark-scale — the column is 5-7 world units tall, the ring has 6
// stones around it. Only places once per biome region, so a grassland
// auto-mosaic still gets at most one shrine on the map.
function placeSunShrine(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const pillarH = 5 + rng() * 2;

  terrain.addColumn(start.x, start.z, pillarH);

  const ringRadius = 4 + rng() * 2;
  const stones = 6;
  const baseAngle = rng() * Math.PI * 2;
  for (let i = 0; i < stones; i++) {
    const angle = baseAngle + (i / stones) * Math.PI * 2;
    const x = start.x + Math.cos(angle) * ringRadius;
    const z = start.z + Math.sin(angle) * ringRadius;
    terrain.addRock(x, z, 0.8 + rng() * 0.6, rng() * Math.PI * 2);
  }
}

// Stone circle (jungle): 6-8 large rocks arranged in a ring around a
// small grass clearing. Reads as an ancient ritual site swallowed by
// the forest.
function placeStoneCircle(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const radius = 6 + rng() * 4;
  const stones = 6 + Math.floor(rng() * 3);
  const baseAngle = rng() * Math.PI * 2;

  // Clear vegetation in the centre.
  paintConditional(terrain, start.x, start.z, radius * 0.5, TerrainType.GRASS, FOREST_ONLY);

  for (let i = 0; i < stones; i++) {
    const angle = baseAngle + (i / stones) * Math.PI * 2 + (rng() - 0.5) * 0.2;
    const x = start.x + Math.cos(angle) * radius;
    const z = start.z + Math.sin(angle) * radius;
    terrain.addRock(x, z, 1.5 + rng() * 1.0, angle * 0.5);
  }
}

// Shipwreck (seaside): a boat hull made from four logStyle wall segments
// (rendered as horizontal wooden cylinders), a broken plank sticking out,
// scattered debris rocks, and occasionally a palm growing up through the
// wreckage. Placed once or twice per seaside beach.
function placeShipwreck(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const angle = rng() * Math.PI * 2;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const L = 10 + rng() * 6;
  const W = 3 + rng() * 2;

  const toWorld = (lx, lz) => ({
    x: start.x + lx * ca - lz * sa,
    z: start.z + lx * sa + lz * ca
  });

  const hull = [
    toWorld(-L, 0),
    toWorld(0, -W),
    toWorld(L, 0),
    toWorld(0, W)
  ];

  for (let i = 0; i < 4; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % 4];
    terrain.addFallenLog(a.x, a.z, b.x, b.z);
  }

  // Broken plank sticking out from the bow.
  const brokenAngle = angle + Math.PI + (rng() - 0.5) * 0.8;
  const brokenLen = 3 + rng() * 3;
  terrain.addFallenLog(
    hull[2].x, hull[2].z,
    hull[2].x + Math.cos(brokenAngle) * brokenLen,
    hull[2].z + Math.sin(brokenAngle) * brokenLen
  );

  // Debris.
  const debris = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < debris; i++) {
    const r = 2 + rng() * 4;
    const a = rng() * Math.PI * 2;
    const x = start.x + Math.cos(a) * r;
    const z = start.z + Math.sin(a) * r;
    terrain.addRock(x, z, 0.5 + rng() * 0.8, rng() * Math.PI * 2);
  }

  if (rng() < 0.5) {
    terrain.addPalm(
      start.x + (rng() - 0.5) * 4,
      start.z + (rng() - 0.5) * 4,
      1.2 + rng() * 0.4
    );
  }
}

// Height-only placer (runs after carveWater).
function placeDuneRidge(terrain, rng, region, cells, spec) {
  const start = pickAnchor(cells, terrain, rng);
  const biomeR = biomeRadius(cells, terrain.cellSize);
  const length = Math.min(pickRange(spec.length, rng), biomeR * 2.5);
  const width = pickRange(spec.width, rng);
  const height = pickRange(spec.height, rng);
  const halfWidth = width * 0.5;

  const angle = (rng() - 0.5) * 0.4;
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);

  const crestCount = 3 + Math.floor(rng() * 4);
  const segLen = length / crestCount;

  const margin = halfWidth + 1;
  const bMinX = Math.min(start.x, start.x + dx * length) - margin;
  const bMaxX = Math.max(start.x, start.x + dx * length) + margin;
  const bMinZ = Math.min(start.z, start.z + dz * length) - margin;
  const bMaxZ = Math.max(start.z, start.z + dz * length) + margin;

  const H = terrain.height;
  const cs = terrain.cellSize;
  const b = terrain.bounds;
  const ix0 = Math.max(0, Math.floor((bMinX - b.minX) / cs));
  const ix1 = Math.min(terrain.cols - 1, Math.floor((bMaxX - b.minX) / cs));
  const iz0 = Math.max(0, Math.floor((bMinZ - b.minZ) / cs));
  const iz1 = Math.min(terrain.rows - 1, Math.floor((bMaxZ - b.minZ) / cs));

  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const px = b.minX + ix * cs;
      const pz = b.minZ + iz * cs;
      const relX = px - start.x;
      const relZ = pz - start.z;
      const t = relX * dx + relZ * dz;
      const perp = -relX * dz + relZ * dx;
      if (Math.abs(t) > length * 0.5 + halfWidth) continue;
      if (Math.abs(perp) > halfWidth) continue;

      const crest = Math.abs(Math.sin(((t + length * 0.5) / segLen) * Math.PI));
      const duneH = height * (0.5 + crest * 0.7);
      const falloff = 1 - Math.abs(perp) / halfWidth;
      const add = duneH * falloff;
      if (add <= 0) continue;

      const cellIx = Math.floor((px - b.minX) / cs);
      const cellIz = Math.floor((pz - b.minZ) / cs);
      if (cellIx >= 0 && cellIx < terrain.cols &&
          cellIz >= 0 && cellIz < terrain.rows) {
        const idx = cellIz * terrain.cols + cellIx;
        const cellT = terrain.types[idx];
        if (cellT === TerrainType.SHALLOW_WATER ||
            cellT === TerrainType.DEEP_WATER) {
          continue;
        }
        if (GRASS_LIKE.has(cellT) || cellT === TerrainType.SAND) {
          terrain.types[idx] = TerrainType.SAND;
        }
      }

      H.setVertex(ix, iz, H.getVertex(ix, iz) + add);
    }
  }
}

const PLACERS = {
  stream: placeStream,
  pond: placePond,
  clearing: placeClearing,
  treeCluster: placeTreeCluster,
  rockOutcrop: placeRockOutcrop,
  shrubCluster: placeShrubCluster,
  palmGrove: placePalmGrove,
  palmRing: placePalmRing,
  dryWash: placeDryWash,
  ridge: placeRidge,
  causeway: placeCauseway,
  marshPatch: placeMarshPatch,
  bankMarsh: placeBankMarsh,
  oxbow: placeOxbow,
  riverbank: placeRiverbank,
  fallenLog: placeFallenLog,
  sunShrine: placeSunShrine,
  stoneCircle: placeStoneCircle,
  shipwreck: placeShipwreck
};

const HEIGHT_PLACERS = {
  duneRidge: placeDuneRidge
};

function buildBiomeCellMap(terrain, region, biomeGrid) {
  const cs = terrain.cellSize;
  const b = terrain.bounds;
  const ix0 = Math.max(0, Math.floor((region.minX - b.minX) / cs));
  const ix1 = Math.min(terrain.cols - 1, Math.floor((region.maxX - b.minX) / cs));
  const iz0 = Math.max(0, Math.floor((region.minZ - b.minZ) / cs));
  const iz1 = Math.min(terrain.rows - 1, Math.floor((region.maxZ - b.minZ) / cs));
  const map = new Map();
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const biomeId = BiomeList[biomeGrid[iz * terrain.cols + ix]].id;
      let list = map.get(biomeId);
      if (!list) { list = []; map.set(biomeId, list); }
      list.push({ ix, iz });
    }
  }
  return map;
}

function runPlacers(terrain, { rng, region, biomeGrid }, featuresByBiome, placerTable) {
  const cellsByBiome = buildBiomeCellMap(terrain, region, biomeGrid);
  for (const [biomeId, cells] of cellsByBiome) {
    if (cells.length === 0) continue;
    const features = featuresByBiome[biomeId];
    if (!features) continue;
    // Insertion order of Object.keys is preserved in JS, so `pond` listed
    // before `palmRing` in BiomeFeatures means palmRing sees the pond.
    for (const kind of Object.keys(features)) {
      const placer = placerTable[kind];
      if (!placer) continue;
      const spec = features[kind];
      const count = effectiveCount(spec.count, cells.length, rng);
      for (let i = 0; i < count; i++) {
        placer(terrain, rng, region, cells, spec);
      }
    }
  }
}

export const TerrainFeaturePass = {
  // Cell-type features: run between the ground pass and carveWater.
  place(terrain, ctx) {
    runPlacers(terrain, ctx, BiomeFeatures, PLACERS);
  },

  // Height features: run after carveWater so smoothing does not flatten
  // the crests.
  placeHeight(terrain, ctx) {
    runPlacers(terrain, ctx, BiomeHeightFeatures, HEIGHT_PLACERS);
  }
};
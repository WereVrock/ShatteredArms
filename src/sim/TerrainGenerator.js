import { TerrainMap } from './TerrainMap.js';
import { TerrainType, TerrainConfig } from '../config/TerrainConfig.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { TerrainPresets, Biomes, BiomeList } from '../config/BiomeConfig.js';
import { TerrainHeightGenerator } from './TerrainHeightGenerator.js';
import { BiomeField } from './BiomeField.js';
import { TerrainGroundPass } from './TerrainGroundPass.js';
import { TerrainObstaclePass } from './TerrainObstaclePass.js';
import { TerrainFeaturePass } from './TerrainFeaturePass.js';

const DEFAULT_REGION = { minX: -130, maxX: 130, minZ: -130, maxZ: 130 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Raise the ROAD_STONE deck above the water surface. Without this the
// bridge is a stone-coloured TILE at water level (the deck was underwater).
//
// Water-adjacent deck vertices are lifted only to `waterLevel`, not to the
// deck height. If they were lifted all the way, the terrain around the deck
// would slope up above the water surface and OCCLUDE it — the visible water
// would stop at the foot of the bridge instead of reaching the deck edge.
// Lifting them to `waterLevel` lets the water run right up to the bridge,
// with the deck beveling up from the water edge to its interior height.
function raiseBridgeCells(terrain, region, targetHeight, waterLevel) {
  const H = terrain.height;
  const cs = terrain.cellSize;
  const b = terrain.bounds;
  const types = terrain.types;
  const cols = terrain.cols;
  const rows = terrain.rows;
  const ix0 = Math.max(0, Math.floor((region.minX - b.minX) / cs));
  const ix1 = Math.min(cols - 1, Math.floor((region.maxX - b.minX) / cs));
  const iz0 = Math.max(0, Math.floor((region.minZ - b.minZ) / cs));
  const iz1 = Math.min(rows - 1, Math.floor((region.maxZ - b.minZ) / cs));

  const isWater = (x, z) => {
    if (x < 0 || z < 0 || x >= cols || z >= rows) return false;
    const t = types[z * cols + x];
    return t === TerrainType.SHALLOW_WATER || t === TerrainType.DEEP_WATER;
  };

  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      if (types[iz * cols + ix] !== TerrainType.ROAD_STONE) continue;
      for (let dz = 0; dz <= 1; dz++) {
        for (let dx = 0; dx <= 1; dx++) {
          const vx = ix + dx, vz = iz + dz;
          // Vertex (vx, vz) is a corner of the four cells at
          // (vx-1..vx, vz-1..vz). If any of them is water, don't lift it
          // above the water surface.
          const touchesWater =
            isWater(vx - 1, vz - 1) || isWater(vx, vz - 1) ||
            isWater(vx - 1, vz)     || isWater(vx, vz);
          const target = touchesWater ? waterLevel : targetHeight;
          if (H.getVertex(vx, vz) < target) H.setVertex(vx, vz, target);
        }
      }
    }
  }
}

// Two straight wall obstacles along the bridge, offset perpendicular to
// the road direction. These are the parapets — solid collision on both
// sides of the deck so the bridge reads as a real structure.
function addBridgeParapets(terrain, bridge, width) {
  const { x1, z1, x2, z2 } = bridge;
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < 1.5) return;

  const ux = dx / len, uz = dz / len;
  const nx = -uz, nz = ux;
  const halfW = width * 0.95;
  const wallH = 0.85;

  for (const side of [1, -1]) {
    terrain.addWall(
      x1 + nx * halfW * side, z1 + nz * halfW * side,
      x2 + nx * halfW * side, z2 + nz * halfW * side,
      wallH
    );
  }
}

// One meandering road. 50% of battles get a stone-paved road, the rest a
// dirt one. Anywhere the road crosses SHALLOW/DEEP water becomes a real
// bridge: ROAD_STONE deck raised above the water line, with two wall
// parapets along its sides.
//
// Two-pass because the water check must see ORIGINAL terrain:
// the fillCircle radius (2.2) is larger than the step (1), so once a
// single cell is painted ROAD_STONE, the next step's terrain.typeAt()
// reads ROAD_STONE and would report "no water" — leaving a 1-cell
// bridge that is not raised and reads as a normal dirt road with a
// grey stripe. The pre-scan below snapshots every waypoint's water
// status BEFORE painting begins, which fixes the whole crossing.
function paintRoad(terrain, rng, region, chance) {
  if (rng() >= chance) return;
  const isStone = rng() < 0.5;
  const roadType = isStone ? TerrainType.ROAD_STONE : TerrainType.ROAD;
  const roadWidth = 2.2;

  const x0 = (rng() - 0.5) * 60;
  const amp = 10 + rng() * 20;
  const freq = 0.02 + rng() * 0.02;
  const phase = rng() * Math.PI * 2;

  const isWaterAt = (x, z) => {
    const t = terrain.typeAt(x, z);
    return t === TerrainType.DEEP_WATER || t === TerrainType.SHALLOW_WATER;
  };
  // Probe the full road width, not just the centreline: a road whose
  // EDGE clips the river must be a bridge across its whole width.
  const probeR = roadWidth * 0.9;

  // Pass 1: pre-scan every waypoint against the UNPAINTED terrain.
  const waypoints = [];
  for (let z = region.minZ; z <= region.maxZ; z += 1) {
    const x = x0 + amp * Math.sin(z * freq + phase);
    const isBridge =
      isWaterAt(x, z) ||
      isWaterAt(x + probeR, z) ||
      isWaterAt(x - probeR, z) ||
      isWaterAt(x, z + probeR) ||
      isWaterAt(x, z - probeR);
    waypoints.push({ x, z, isBridge });
  }

  // Pass 2: paint, tracking contiguous bridge spans so parapets get one
  // wall per side per span (not one per cell).
  const bridges = [];
  let current = null;
  for (const wp of waypoints) {
    terrain.fillCircle(wp.x, wp.z, roadWidth,
      wp.isBridge ? TerrainType.ROAD_STONE : roadType);
    if (wp.isBridge) {
      if (!current) current = { x1: wp.x, z1: wp.z, x2: wp.x, z2: wp.z };
      else { current.x2 = wp.x; current.z2 = wp.z; }
    } else if (current) {
      bridges.push(current);
      current = null;
    }
  }
  if (current) bridges.push(current);

  // Raise the deck above BOTH the water surface and any surrounding
  // ground that sits lower than the deck, so the bridge reads as a
  // raised structure rather than a shallow dip in the terrain.
  if (bridges.length > 0) {
    const waterLevel = terrain.waterLevel || 0;
    const targetHeight = Math.max(waterLevel + 0.65, 0.35);
    raiseBridgeCells(terrain, region, targetHeight, waterLevel);
    for (const b of bridges) addBridgeParapets(terrain, b, roadWidth);
  }
}

// Paints a single sinuous river channel along `axis` ('x' or 'z') from
// `from` to `to`. The perpendicular offset at each step comes from a
// sine wave centred on `center`. Returns the sampled centreline path
// (one entry per world unit of length) — used by downstream feature
// placers (oxbow, marsh patches, bank features).
//
// `halfWidth` is the deep-channel half-width; `bankWidth` is the
// shallow-water half-width. Bank first, then deep on top, so the deep
// overwrites the middle and the visible depth gradient runs from a wide
// shallow rim to a narrower deep core.
function paintChannel(terrain, {
  axis, from, to, center, amp, freq, phase, halfWidth, bankWidth
}) {
  const path = [];
  for (let t = from; t <= to; t += 1) {
    const perp = center + amp * Math.sin(t * freq + phase);
    const x = axis === 'x' ? t : perp;
    const z = axis === 'x' ? perp : t;
    path.push({ x, z, halfWidth, bankWidth });
    terrain.fillCircle(x, z, bankWidth, TerrainType.SHALLOW_WATER);
    terrain.fillCircle(x, z, halfWidth, TerrainType.DEEP_WATER);
  }
  return path;
}

// Seaside: a sea strip along one edge of the region. Picks one of the
// four edges, waves the coastline, and paints three bands from the edge
// inward: DEEP_WATER (centre of the sea), SHALLOW_WATER (the surf),
// SAND (the beach). The rest of the map is whatever the biome's ground
// rules produced, which for Seaside is beach + grassland.
//
// Runs BEFORE carveWater (same reasoning as paintRiver): the water
// carve then lowers the sea bed below the water surface, and the beach
// side of the coastline stays above sea level so it does not get
// flooded.
function paintSea(terrain, rng, region) {
  // side: 0 = minZ, 1 = maxZ, 2 = minX, 3 = maxX
  const side = Math.floor(rng() * 4);
  const depth = 100 + rng() * 60;         // sea width, world units
  const coastAmp = 15 + rng() * 20;       // wavy coastline amplitude
  const coastFreq = 0.015 + rng() * 0.01; // wave frequency along the coast
  const phase = rng() * Math.PI * 2;

  const cs = terrain.cellSize;
  const b = terrain.bounds;
  const cols = terrain.cols;
  const rows = terrain.rows;
  const types = terrain.types;

  for (let iz = 0; iz < rows; iz++) {
    for (let ix = 0; ix < cols; ix++) {
      const x = b.minX + (ix + 0.5) * cs;
      const z = b.minZ + (iz + 0.5) * cs;
      if (x < region.minX || x > region.maxX ||
          z < region.minZ || z > region.maxZ) continue;

      // dist = distance inward from the sea edge (positive), along =
      // coordinate along the coastline used for the wave.
      let dist, along;
      if (side === 0)      { dist = z - region.minZ; along = x; }
      else if (side === 1) { dist = region.maxZ - z; along = x; }
      else if (side === 2) { dist = x - region.minX; along = z; }
      else                 { dist = region.maxX - x; along = z; }

      const wave = Math.sin(along * coastFreq + phase) * coastAmp;
      const localDepth = Math.max(20, depth + wave);
      if (dist > localDepth) continue;

      const idx = iz * cols + ix;
      const f = dist / localDepth;
      if (f < 0.55)      types[idx] = TerrainType.DEEP_WATER;
      else if (f < 0.85) types[idx] = TerrainType.SHALLOW_WATER;
      else               types[idx] = TerrainType.SAND;
    }
  }
}

// Riverlands: 1-2 sinuous channels, arranged in one of three styles.
// The road pass runs after this, so wherever the road crosses any
// channel it paints ROAD_STONE on top — the bridge.
//
//   single    one river. Flow axis is X (perpendicular to the usual
//             army line along Z=0) 75% of the time, Z (parallel to
//             the army line) 25% — variety without breaking the
//             classic "river between the armies" read.
//   double    two independent rivers, offset perpendicular by 30-70
//             units, with different amplitudes / frequencies / phases
//             so the two cross occasionally but mostly run parallel.
//             Reads as a lowland basin with several waterways.
//   tributary one main river plus a thinner perpendicular channel
//             that joins it at a point on its run. Reads as a feeder
//             stream meeting the main flow — the classic river
//             confluence, which reads as a landmark.
//
// forceCenter (custom battle with biome='river') skips the extra
// channels and the orientation randomness — a custom-battle river is
// meant to be one clean stream between the armies, not a complex
// system. The random-mode river is the one that got the variety.
//
// _riverPath (singular) is still set to the primary channel for
// backward compat with BiomeFeatures' oxbow / bank-marsh placers. New
// code that wants the complete set of channels can read _riverPaths
// (array of paths, in paint order — primary first, secondary next).
function paintRiver(terrain, rng, region, forceCenter) {
  // Flow axis. 'x' means the river runs left-to-right (perpendicular
  // to the usual army line along Z=0); 'z' means top-to-bottom.
  const mainAxis = forceCenter ? 'x' : (rng() < 0.75 ? 'x' : 'z');
  const mainFrom = mainAxis === 'x' ? region.minX : region.minZ;
  const mainTo = mainAxis === 'x' ? region.maxX : region.maxZ;
  const perpMid = mainAxis === 'x'
    ? (region.minZ + region.maxZ) * 0.5
    : (region.minX + region.maxX) * 0.5;

  // Primary channel: 80% near the middle, 20% offset. forceCenter
  // pins it to perpMid.
  const centered = forceCenter || rng() < 0.8;
  const mainCenter = perpMid + (centered
    ? (rng() - 0.5) * 12
    : (rng() - 0.5) * 90);
  const mainHalfWidth = 4 + rng() * 3;
  const mainBankWidth = mainHalfWidth + 2;

  const primary = paintChannel(terrain, {
    axis: mainAxis, from: mainFrom, to: mainTo,
    center: mainCenter,
    amp: 10 + rng() * 18,
    freq: 0.010 + rng() * 0.008,
    phase: rng() * Math.PI * 2,
    halfWidth: mainHalfWidth, bankWidth: mainBankWidth
  });

  const allPaths = [primary];

  // Branch style. ALWAYS rolled, including in forceCenter mode.
  //
  // The previous version skipped this roll when forceCenter was true,
  // intending "custom-battle rivers should be a clean single stream".
  // But forceCenter is ALSO true whenever the caller passes
  // biome === 'river' explicitly — which is exactly what the terrain
  // test page does. The test page therefore never rolled for style and
  // always produced a single river (the "no other stream" report).
  //
  // forceCenter now only pins the MAIN river's axis and centering; the
  // branch style rolls on every seed. Custom battle keeps its
  // predictable orientation, but a tributary or a second river can
  // appear — both are more interesting landmarks than a single stream,
  // so "forceCenter implies single" was the wrong trade.
  //
  // Probabilities biased toward variety: single is now the 30% case,
  // not the 50% case. A user testing the river biome sees a new
  // layout on most regens instead of alternating between "single" and
  // "single" with different wavelengths.
  let style = 'single';
  {
    const roll = rng();
    if (roll < 0.30) style = 'double';
    else if (roll < 0.70) style = 'tributary';
    // else 'single' (30% chance)
  }

  if (style === 'double') {
    // Second river, independent of the first. Perpendicular offset
    // ensures the two are visibly separate for most of their run,
    // while different frequency / phase makes them cross sometimes.
    const sign = rng() < 0.5 ? -1 : 1;
    const secondCenter = mainCenter + sign * (30 + rng() * 40);
    const secondHalfWidth = 3 + rng() * 2.5;
    const second = paintChannel(terrain, {
      axis: mainAxis, from: mainFrom, to: mainTo,
      center: secondCenter,
      amp: 8 + rng() * 15,
      freq: 0.008 + rng() * 0.010,
      phase: rng() * Math.PI * 2,
      halfWidth: secondHalfWidth,
      bankWidth: secondHalfWidth + 1.5
    });
    allPaths.push(second);
  } else if (style === 'tributary') {
    // Thinner perpendicular channel that joins the primary at a point
    // on its run. The tributary's sine oscillates around the merge
    // point's coordinate on the main-flow axis; near the merge the two
    // water bodies overlap, creating a wider deep pool at the
    // confluence — which reads as a natural river fork rather than as
    // two unrelated streams.
    const mergeT = 0.25 + rng() * 0.5;
    const sample = primary[Math.floor(mergeT * (primary.length - 1))];
    // Along the tributary's own flow axis, the merge sits at the
    // primary's coordinate on that axis.
    const mergeOnTribAxis = mainAxis === 'x' ? sample.z : sample.x;
    // Perpendicular to that (i.e. along the main-flow axis), the
    // tributary is centred at the primary's coordinate there. Its sine
    // then wanders around this centre, so the tributary's far end
    // curves rather than running dead-straight to the merge.
    const tribCenter = mainAxis === 'x' ? sample.x : sample.z;

    const tribAxis = mainAxis === 'x' ? 'z' : 'x';
    const edgeMin = mainAxis === 'x' ? region.minZ : region.minX;
    const edgeMax = mainAxis === 'x' ? region.maxZ : region.maxX;
    const fromMin = rng() < 0.5;
    const tribFrom = fromMin ? edgeMin : mergeOnTribAxis;
    const tribTo = fromMin ? mergeOnTribAxis : edgeMax;

    const tribHalfWidth = 2 + rng() * 1.5;
    const trib = paintChannel(terrain, {
      axis: tribAxis, from: tribFrom, to: tribTo,
      center: tribCenter,
      amp: 4 + rng() * 6,
      freq: 0.015 + rng() * 0.010,
      phase: rng() * Math.PI * 2,
      halfWidth: tribHalfWidth,
      bankWidth: tribHalfWidth + 1.5
    });
    allPaths.push(trib);
  }

  // Backward compat: _riverPath still holds the primary channel.
  // BiomeFeatures' oxbow / bank-marsh placers read this and continue
  // to work unchanged. New code that wants every channel can read
  // _riverPaths.
  terrain._riverPath = primary;
  terrain._riverPaths = allPaths;
}

// Biome with the most cells inside the generated region. Used by the
// scene to pick per-biome fog, sky, water and particle effects — the
// mosaic has many biomes, but a single dominant one is what the ambient
// layer should key off.
//
// biomeGrid stores the biome INDEX (0..BiomeList.length-1) per cell;
// this returns the biome ID string.
function computeDominantBiome(biomeGrid, terrain) {
  const counts = new Uint32Array(BiomeList.length);
  const region = terrain.region || terrain.bounds;
  const cs = terrain.cellSize;
  const b = terrain.bounds;
  const ix0 = Math.max(0, Math.floor((region.minX - b.minX) / cs));
  const ix1 = Math.min(terrain.cols - 1, Math.floor((region.maxX - b.minX) / cs));
  const iz0 = Math.max(0, Math.floor((region.minZ - b.minZ) / cs));
  const iz1 = Math.min(terrain.rows - 1, Math.floor((region.maxZ - b.minZ) / cs));
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      counts[biomeGrid[iz * terrain.cols + ix]]++;
    }
  }
  let bestIdx = 0;
  let bestCount = counts[0];
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > bestCount) { bestIdx = i; bestCount = counts[i]; }
  }
  return BiomeList[bestIdx].id;
}

// Deterministic: same seed + preset + biome -> same terrain on every
// machine. For multiplayer, send only { seed, preset } and generate on both
// sides.
//
// Passes: heights -> ground types (per biome) -> lakes -> road -> walls,
// trees and rocks. Nothing is cleared for the armies: TerrainPlacement moves
// units off blocked ground afterwards.
export class TerrainGenerator {
  static generate({
    seed = 1, preset = 'normal', bounds = CombatConfig.mapBounds,
    region = DEFAULT_REGION, biome = 'auto', ruinType = 'random'
  } = {}) {
    const presetName = TerrainPresets[preset] ? preset : 'normal';
    const p = TerrainPresets[presetName];
    seed = (seed | 0) || 1;
    const rng = mulberry32(seed);
    const terrain = new TerrainMap(bounds);
    terrain.region = region;

    const _tGen = performance.now();
    const biomeField = new BiomeField(seed, biome);
    const elevationOn = !!TerrainConfig.elevation.enabled;
    const relief = elevationOn ? TerrainHeightGenerator.reliefFor(presetName) : 0;

    if (elevationOn) {
      TerrainHeightGenerator.generate(terrain, {
        seed, preset: presetName, region,
        reliefMultAt: (x, z) => biomeField.reliefMultAt(x, z)
      });
    }
    const _tHeight = performance.now();

    const biomeGrid = TerrainGroundPass.paint(terrain, {
      seed, shift: p.thresholdShift, region, biomeField, elevationOn
    });
    // Persist on the terrain so downstream renderers can tint obstacles
    // by the biome they sit in. One Uint8Array of cols x rows bytes.
    terrain.biomeGrid = biomeGrid;
    // One dominant biome drives fog, sky, water and particle effects —
    // the mosaic can have many biomes, but ambient must pick one.
    terrain.dominantBiome = computeDominantBiome(biomeGrid, terrain);
    const _tGround = performance.now();

    // Riverlands: paint the actual river BEFORE carving lakes. carveWater
    // then lowers the terrain under the river bed the same way it lowers
    // it under biome-generated lakes, so the water surface sits below
    // the surrounding ground and the bridge raise below has something to
    // rise above.
    //
    // Fires when the biome was forced to 'river' (biome === 'river') or
    // when 'auto' picked 'river' as the seed's home biome. Other biomes
    // get no river; forcing 'river' is the correct way to see one.
    const isRiverHome = (biome === 'river') ||
      (biome === 'auto' && biomeField.homeBiome && biomeField.homeBiome.id === 'river');
    if (isRiverHome) {
      paintRiver(terrain, rng, region, biome === 'river');
    }
    const _tRiver = performance.now();

    // Seaside: paint a sea strip along one map edge. Same reasoning as
    // paintRiver — before carveWater so the sea bed gets lowered.
    const isSeaside = (biome === 'seaside') ||
      (biome === 'auto' && biomeField.homeBiome && biomeField.homeBiome.id === 'seaside');
    if (isSeaside) {
      paintSea(terrain, rng, region);
    }
    const _tSea = performance.now();

    // Structural features (streams, ponds, clearings, ridges, dry washes,
    // clusters). Runs AFTER the river (so Riverlands' marsh patches can
    // sit near it) and BEFORE the water carve (so any water the features
    // paint gets its terrain bed lowered the same way biome-lakes do).
    // Modifies CELL TYPES only; the obstacle pass then responds naturally
    // (dense trees on forest floor, none on water, sparse on grass).
    TerrainFeaturePass.place(terrain, { rng, region, biomeGrid });
    const _tFeature = performance.now();

    // Lakes sit in basins; the carve returns the water surface height.
    if (elevationOn) {
      terrain.waterLevel = TerrainHeightGenerator.carveWater(terrain, region, relief);
    }
    const _tWater = performance.now();

    // Height-only features (dune ridges) run AFTER carveWater because
    // carveWater's shore smoothing would otherwise flatten the crests.
    // They only raise terrain above surrounding ground, so they cannot
    // leave water floating (a raise cannot push a water bed BELOW level).
    TerrainFeaturePass.placeHeight(terrain, { rng, region, biomeGrid });
    const _tHeightFeatures = performance.now();

    const forced = biome !== 'auto' ? Biomes[biome] : null;
    paintRoad(terrain, rng, region, forced ? forced.roadChance : 0.8);
    const _tRoad = performance.now();

    TerrainObstaclePass.place(terrain, {
      rng, preset: p, region, biomeField, biomeGrid, seed, ruinType
    });
    const _tObs = performance.now();

    terrain.touch();
    const _tTouch = performance.now();

    console.log(
      `%c[terrain.gen] ` +
      `height=${(_tHeight - _tGen).toFixed(0)}ms ` +
      `ground=${(_tGround - _tHeight).toFixed(0)}ms ` +
      `river=${(_tRiver - _tGround).toFixed(0)}ms ` +
      `sea=${(_tSea - _tRiver).toFixed(0)}ms ` +
      `feature=${(_tFeature - _tSea).toFixed(0)}ms ` +
      `water=${(_tWater - _tFeature).toFixed(0)}ms ` +
      `dunes=${(_tHeightFeatures - _tWater).toFixed(0)}ms ` +
      `road=${(_tRoad - _tHeightFeatures).toFixed(0)}ms ` +
      `obstacles=${(_tObs - _tRoad).toFixed(0)}ms ` +
      `touch=${(_tTouch - _tObs).toFixed(0)}ms ` +
      `total=${(_tTouch - _tGen).toFixed(0)}ms`,
      'color:#8c8;font-weight:bold'
    );

    return terrain;
  }
}
// ===== src/config/BiomeConfig.js =====
import { TerrainType } from './TerrainConfig.js';

// Biome and preset data. No logic.
//
// A battle is generated from a MOSAIC of biomes (see BiomeField): two
// low-frequency noise fields, moisture and ruggedness, choose the biome of
// each cell, and the seed biases the climate of the whole battle. A scenario
// may force a single biome instead (scenario.terrainBiome).
//
// `ruins` density table: sites per 10,000 cells. One site is a small
// cluster of 7-10 ruin models (see RuinPatterns).
// `ruinType: 'mixed'` (City Ruins only) picks a different archetype per
// site; every other biome uses the battle-wide ruinType.
// `treeScale` (optional): multiplier applied to tree scale in this biome.
//   Jungle uses 2.2 to grow oversized canopy trees.
// `defaultGround` (optional): cell type used when no ground rule matches.
//   Oasis uses SAND so the entire map is desert; the pond feature paints
//   the water and greenery around the actual pool. Without this, oasis
//   fell back to grass and read as "grassland with a pond".
// Water: DEEP_WATER / SHALLOW_WATER in a biome's ground rules mean lakes
// form there. Only biomes where water belongs (marsh, oasis) list them.
// Riverlands deliberately does NOT list water — the paintRiver pass
// carves one river, and any extra water rule turned the map into a lake
// field. Arid, grassland, steppes, highland etc. also have no water.

const T = TerrainType;

export const TerrainPresets = {
  open:   { thresholdShift: 0.04,  obstacleMult: 0.7, reliefMult: 0.5,  walls: 1 },
  normal: { thresholdShift: 0,     obstacleMult: 1.0, reliefMult: 1.0,  walls: 2 },
  rough:  { thresholdShift: -0.04, obstacleMult: 1.4, reliefMult: 1.75, walls: 3 }
};

export const BiomeSelection = {
  fieldScale: 0.012,
  warp: { scale: 0.02, amount: 30 },
  climateBiasRange: 0.05,
  homeInfluence: 0.55,
  transitionPasses: 1,

  highlandRugged: 0.55,
  aridMoisture: 0.44,
  marshMoisture: 0.60,
  marshMaxRugged: 0.48,
  riverMaxRugged: 0.36,
  riverMoisture: 0.64,
  woodlandMoisture: 0.55,
  jungleRugged: 0.54,
  steppesMoisture: 0.49,
  wastelandRugged: 0.55,
  ruinsCiv: 0.66,
  volcanicRugged: 0.68,
  volcanicMoisture: 0.38
};

export const BiomeClimateTargets = {
  grassland: { moisture: 0.50, rugged: 0.50 },
  woodland:  { moisture: 0.60, rugged: 0.55 },
  marsh:     { moisture: 0.68, rugged: 0.40 },
  highland:  { moisture: 0.55, rugged: 0.68 },
  arid:      { moisture: 0.35, rugged: 0.55 },
  ruins:     { moisture: 0.45, rugged: 0.60 },
  river:     { moisture: 0.70, rugged: 0.35 },
  steppes:   { moisture: 0.48, rugged: 0.55 },
  jungle:    { moisture: 0.62, rugged: 0.60 },
  wasteland: { moisture: 0.42, rugged: 0.60 },
  oasis:     { moisture: 0.40, rugged: 0.42 },
  seaside:   { moisture: 0.65, rugged: 0.30 },
  volcanic:  { moisture: 0.28, rugged: 0.76 }
};

const grassland = {
  id: 'grassland', index: 0, displayName: 'Grassland',
  // Flat, open meadow. No water, few rocks, sparse trees.
  relief: 0.45, roadChance: 0.85, wallChance: 0.6,
  ground: [
    { type: T.MUD,           field: 'wet',    min: 0.75 },
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.68 },
    { type: T.ROCKY,         field: 'rocky',  min: 0.72 },
    { type: T.SAND,          field: 'dry',    min: 0.76 }
  ],
  trees: { onForestFloor: 0.12, onGrass: 0.0012, onMud: 0 },
  rocks: { onRocky: 0.02, onGrass: 0.0004, onSand: 0 },
  bushes: { onGrass: 0.008 },
  ruins: { onGrass: 0.35 }
};

const woodland = {
  id: 'woodland', index: 1, displayName: 'Woodland',
  relief: 0.75, roadChance: 0.6, wallChance: 0.1,
  ground: [
    { type: T.DEEP_WATER,    field: 'wet',    min: 0.88 },
    { type: T.SHALLOW_WATER, field: 'wet',    min: 0.82 },
    { type: T.MUD,           field: 'wet',    min: 0.74 },
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.46 },
    { type: T.ROCKY,         field: 'rocky',  min: 0.72 }
  ],
  trees: { onForestFloor: 0.28, onGrass: 0.010, onMud: 0 },
  rocks: { onRocky: 0.05, onGrass: 0.0015, onSand: 0 },
  bushes: { onForestFloor: 0.03, onGrass: 0.02 },
  ruins: { onForestFloor: 0.5, onGrass: 0.25 }
};

const marsh = {
  id: 'marsh', index: 2, displayName: 'Marsh',
  relief: 0.4, roadChance: 0.5, wallChance: 0,
  ground: [
    { type: T.DEEP_WATER,    field: 'wet',    min: 0.76 },
    { type: T.SHALLOW_WATER, field: 'wet',    min: 0.66 },
    { type: T.MUD,           field: 'wet',    min: 0.56 },
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.70 }
  ],
  trees: { onForestFloor: 0.20, onGrass: 0.002, onMud: 0.010 },
  rocks: { onRocky: 0, onGrass: 0, onSand: 0 },
  ruins: { onGrass: 0.25 }
};

// Highland: mountain plateau. No water at all — the 1.4x relief makes any
// lake level a deep pit in the hillside, which reads as floating water.
// Mud patches survive because they are the biome's low, wet spots.
const highland = {
  id: 'highland', index: 3, displayName: 'Highland',
  relief: 1.4, roadChance: 0.5, wallChance: 0.6,
  ground: [
    { type: T.MUD,           field: 'wet',    min: 0.80 },
    { type: T.ROCKY,         field: 'rocky',  min: 0.54 },
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.66 }
  ],
  trees: { onForestFloor: 0.20, onGrass: 0.002, onMud: 0 },
  rocks: { onRocky: 0.07, onGrass: 0.003, onSand: 0 },
  ruins: { onRocky: 0.5, onGrass: 0.2 }
};

// Arid: desert. No water at all — no lakes, no oasis pockets inside.
// The only way to see water on an arid map is the Oasis biome proper,
// which the player can force from Custom Battle.
const arid = {
  id: 'arid', index: 4, displayName: 'Arid',
  relief: 0.7, roadChance: 0.7, wallChance: 0.3,
  ground: [
    { type: T.SAND,          field: 'dry',    min: 0.46 },
    { type: T.ROCKY,         field: 'rocky',  min: 0.58 }
  ],
  trees: { onForestFloor: 0.15, onGrass: 0.002, onMud: 0 },
  rocks: { onRocky: 0.06, onGrass: 0.002, onSand: 0.003 },
  cacti: { onSand: 0.012, onGrass: 0.003 },
  ruins: { onSand: 0.3, onGrass: 0.2 }
};

// City Ruins: broken stone, dense ruin patterns from every archetype.
const ruins = {
  id: 'ruins', index: 5, displayName: 'City Ruins',
  relief: 0.6, roadChance: 0.3, wallChance: 0.4,
  ground: [
    { type: T.ROCKY,         field: 'rocky',  min: 0.50 },
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.72 },
    { type: T.MUD,           field: 'wet',    min: 0.82 }
  ],
  trees: { onForestFloor: 0.14, onGrass: 0.001, onMud: 0 },
  rocks: { onRocky: 0.04, onGrass: 0.001, onSand: 0 },
  ruinType: 'mixed',
  // Double the previous density — the whole point of this biome is being
  // a ruined city, not a grassy field with one temple.
  ruins: { onRocky: 30, onGrass: 22, onForestFloor: 14, onMud: 8 }
};

// Riverlands: paintRiver carves the real river through the map. Ground
// rules here paint NO water at all — otherwise the whole biome fills
// with scattered ponds wherever the wet noise happens to be high, and
// the map reads as a swamp with a river in it rather than a river
// valley. bankMarsh, oxbow and riverbank in BiomeFeatures add the only
// extra water, and all three are anchored to the river's path.
const river = {
  id: 'river', index: 6, displayName: 'Riverlands',
  relief: 0.5, roadChance: 1.0, wallChance: 0.1,
  ground: [
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.62 },
    { type: T.MUD,           field: 'wet',    min: 0.62 },
    { type: T.SAND,          field: 'dry',    min: 0.72 }
  ],
  trees: { onForestFloor: 0.26, onGrass: 0.006, onMud: 0.015 },
  rocks: { onRocky: 0.04, onGrass: 0.001, onSand: 0 },
  ruins: { onGrass: 0.4, onMud: 0.25 }
};

// Steppes / bozkırlar: open dry grass. Few trees, no mud — this is a
// steppe, not a marsh. SAND is present but rare (only very dry pockets).
const steppes = {
  id: 'steppes', index: 7, displayName: 'Steppes',
  relief: 0.5, roadChance: 0.6, wallChance: 0.1,
  ground: [
    { type: T.SAND,          field: 'dry',    min: 0.74 },
    { type: T.ROCKY,         field: 'rocky',  min: 0.78 },
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.85 }
  ],
  trees: { onForestFloor: 0.10, onGrass: 0.001, onMud: 0 },
  rocks: { onRocky: 0.05, onGrass: 0.0015, onSand: 0.0015 },
  bushes: { onGrass: 0.03, onSand: 0.01 },
  ruins: { onGrass: 0.35, onSand: 0.2 }
};

// Jungle: oversized canopy trees (treeScale 2.2 -> trunks reach ~5m,
// crowns extend ~3m across, silhouettes are visibly bigger than other
// biomes' trees). Very dense underbrush.
// Jungle: dense canopy, wet underbrush, but NO surface water from the
// biome's ground rules — an earlier version had wet-threshold lakes
// across 15% of the map, which read as "flooded forest" rather than
// "thick jungle". The stream feature (BiomeFeatures.jungle.stream)
// still paints narrow jungle creeks; those are the only water on the
// map.
const jungle = {
  id: 'jungle', index: 8, displayName: 'Jungle',
  relief: 0.8, roadChance: 0.3, wallChance: 0,
  ground: [
    { type: T.MUD,           field: 'wet',    min: 0.68 },
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.30 }
  ],
  treeScale: 2.2,
  trees: { onForestFloor: 0.22, onGrass: 0.015, onMud: 0.02 },
  rocks: { onRocky: 0.02, onGrass: 0, onSand: 0 },
  palms: { onForestFloor: 0.06, onGrass: 0.005 },
  bushes: { onForestFloor: 0.05, onGrass: 0.02 },
  ruins: { onForestFloor: 0.2, onGrass: 0.1 }
};

const wasteland = {
  id: 'wasteland', index: 9, displayName: 'Wasteland',
  relief: 0.9, roadChance: 0.2, wallChance: 0.3,
  ground: [
    { type: T.ROCKY,         field: 'rocky',  min: 0.45 },
    { type: T.SAND,          field: 'dry',    min: 0.58 }
  ],
  trees: { onForestFloor: 0.05, onGrass: 0.0005, onMud: 0 },
  rocks: { onRocky: 0.12, onGrass: 0.002, onSand: 0.01 },
  ruins: { onRocky: 0.4, onSand: 0.2 }
};

// Oasis: pure sand everywhere. The pond feature (with grassRing: true)
// paints the water, the mud rim, the green halo and the palm ring — so
// the ONLY greenery on the map is right around the water. Earlier the
// biome's own ground rules painted grass / forest / water across the
// whole tile, which read as "grassland with some sand" instead of "an
// oasis in a sand sea".
const oasis = {
  id: 'oasis', index: 10, displayName: 'Oasis',
  relief: 0.4, roadChance: 0.4, wallChance: 0,
  defaultGround: T.SAND,
  ground: [
    { type: T.SAND,          field: 'dry',    min: 0.25 }
  ],
  trees: { onForestFloor: 0.15, onGrass: 0.001, onMud: 0 },
  rocks: { onRocky: 0.01, onGrass: 0.001, onSand: 0.001 },
  palms: { onGrass: 0.002 },
  ruins: { onGrass: 0.1, onSand: 0.05 }
};

// Seaside: a sandy coast on one edge of the map. paintSea (in
// TerrainGenerator) carves a deep-to-shallow sea strip along one edge
// with a wavy coastline; the inland side is sand beach that blends into
// grassland. Palms and shrubs scatter across the beach.
const seaside = {
  id: 'seaside', index: 11, displayName: 'Seaside',
  relief: 0.35, roadChance: 0.5, wallChance: 0,
  ground: [
    { type: T.SAND,          field: 'dry',    min: 0.30 },
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.72 },
    { type: T.MUD,           field: 'wet',    min: 0.80 }
  ],
  trees: { onForestFloor: 0.18, onGrass: 0.003, onMud: 0.005 },
  rocks: { onRocky: 0.02, onGrass: 0.001 },
  palms: { onGrass: 0.008 },
  bushes: { onGrass: 0.012 },
  ruins: { onGrass: 0.15, onSand: 0.1 }
};

// Volcanic Caldera: black basalt ground, red ash sky, tall steep
// relief (volcanic cones). No water — same reasoning as highland: the
// steep relief makes any lake level a pit, and the biome reads better
// as pure black rock than as "hot water in a black field". The dead-
// tree tree mix (BiomeTreeMix) keeps the few trees this biome allows
// consistent with the theme.
//
// defaultGround: ROCKY so cells not covered by SAND or MUD fall
// through to hardened basalt instead of the GRASS default. Trees only
// spawn on the scattered FOREST_FLOOR patches (sparse — this is not a
// woodland), and the FOREST_FLOOR colour override in BiomeVisuals
// makes them read as scorched ground rather than a green forest.
const volcanic = {
  id: 'volcanic', index: 12, displayName: 'Volcanic Caldera',
  relief: 1.6, roadChance: 0.3, wallChance: 0.4,
  defaultGround: T.ROCKY,
  ground: [
    { type: T.SAND,          field: 'dry',    min: 0.55 },
    { type: T.FOREST_FLOOR,  field: 'forest', min: 0.72 },
    { type: T.MUD,           field: 'wet',    min: 0.80 }
  ],
  trees: { onForestFloor: 0.08, onGrass: 0, onMud: 0 },
  rocks: { onRocky: 0.06, onGrass: 0, onSand: 0.005 },
  ruins: { onRocky: 0.4, onSand: 0.2 }
};

export const BiomeList = [
  grassland, woodland, marsh, highland, arid,
  ruins, river, steppes, jungle, wasteland, oasis, seaside, volcanic
];

export const Biomes = {
  grassland, woodland, marsh, highland, arid,
  ruins, river, steppes, jungle, wasteland, oasis, seaside, volcanic
};
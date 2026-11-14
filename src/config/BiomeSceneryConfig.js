// ===== src/config/BiomeSceneryConfig.js =====
// Biome scenery: per-biome density of camp-style sites (tents, towers,
// graveyards, etc.) built from the camp prop library. Mirrors RuinConfig:
// models declare collision + height; patterns compose models into a
// hand-authored layout; per-biome density table decides which biome gets
// which patterns and how often.
//
// STATIC PROPS ONLY. The camp prop library has some props that spawn
// animated children (fire, wisps, glow sprites, swaying banners). The
// renderer only consumes the merged static mesh from each prop's
// CampContext (see BiomeSceneryBuilder.js), so any animated sprite a
// prop emits is silently discarded. See BiomeSceneryBuilder.js for the
// per-model build closures.
//
// Schema per model: { collision, height } — collision radius in world
// units, height above ground for arrow/LOS blocking.
//
// Schema per pattern: { radius, parts: [{ model, dx, dz }] }. radius is
// the anchor-to-farthest-part distance; the placer rejects a new site if
// its radius overlaps an existing one.
//
// Density: sites per 10,000 cells. Keyed by biome id (matches
// BiomeList[].id). A biome with a null / absent entry gets NO scenery.

export const BiomeSceneryModels = {
  // --- Human camp ---
  human_tent:         { collision: 1.8, height: 3.0 },
  human_pavilion:     { collision: 3.5, height: 4.5 },
  human_wagon:        { collision: 1.8, height: 1.5 },
  human_crate:        { collision: 0.5, height: 0.7 },
  human_barrel:       { collision: 0.35, height: 0.9 },
  human_hayBale:      { collision: 0.6, height: 0.6 },
  human_weaponRack:   { collision: 1.2, height: 2.2 },
  human_horse:        { collision: 1.0, height: 2.0 },
  human_fence:        { collision: 1.5, height: 1.3 },
  human_palisade:     { collision: 3.0, height: 2.5 },
  human_watchtower:   { collision: 1.8, height: 5.5 },
  human_dummy:        { collision: 0.5, height: 1.8 },

  // --- Goblin / tribal ---
  goblin_hideTent:    { collision: 1.8, height: 2.5 },
  goblin_bonePile:    { collision: 0.8, height: 0.6 },
  goblin_cage:        { collision: 1.0, height: 2.0 },
  goblin_meatRack:    { collision: 1.2, height: 2.0 },
  goblin_warDrum:     { collision: 0.6, height: 0.8 },
  goblin_spikedFence: { collision: 3.0, height: 2.5 },

  // --- Hobgoblin / military ---
  hobgoblin_warTent:  { collision: 2.0, height: 3.5 },
  hobgoblin_siegeRam: { collision: 1.5, height: 2.5 },
  hobgoblin_stoneTower: { collision: 1.5, height: 5.5 },

  // --- Undead / graveyard ---
  undead_gravestone:  { collision: 0.5, height: 1.2 },
  undead_deadTree:    { collision: 0.5, height: 2.4 },
  undead_boneArch:    { collision: 2.5, height: 3.7 },
  undead_ironFence:   { collision: 3.0, height: 1.5 },
  undead_openGrave:   { collision: 1.0, height: 0.3 },
  undead_coffin:      { collision: 0.8, height: 0.8 },
  undead_crypt:       { collision: 2.8, height: 7.0 },

  // --- Volcanic ---
  // Basalt column cluster. Collision 1.8 covers the whole formation
  // in one circle (units path around the cluster, not between the
  // pillars). Height 12.5 matches the tallest column, used for
  // arrow / LOS blocking.
  volcanic_basalt:    { collision: 1.8, height: 12.5 }
};

export const BiomeSceneryPatterns = {
  human_camp: {
    radius: 12,
    parts: [
      { model: 'human_pavilion',   dx:  0, dz: -3 },
      { model: 'human_tent',       dx: -6, dz:  0 },
      { model: 'human_tent',       dx:  6, dz:  0 },
      { model: 'human_tent',       dx: -4, dz:  6 },
      { model: 'human_wagon',      dx:  4, dz:  6 },
      { model: 'human_crate',      dx: -1, dz:  1 },
      { model: 'human_crate',      dx:  1.5, dz: 0.5 },
      { model: 'human_barrel',     dx: -2, dz: -1 },
      { model: 'human_hayBale',    dx:  2, dz: -1 },
      { model: 'human_weaponRack', dx: -8, dz: -2 },
      { model: 'human_fence',      dx:  8, dz:  4 }
    ]
  },

  human_outpost: {
    radius: 8,
    parts: [
      { model: 'human_watchtower', dx: 0, dz: 0 },
      { model: 'human_tent',       dx: -4, dz: 3 },
      { model: 'human_palisade',   dx: 0, dz: 5 },
      { model: 'human_crate',      dx: 2, dz: 2 }
    ]
  },

  goblin_camp: {
    radius: 10,
    parts: [
      { model: 'goblin_hideTent', dx: -5, dz:  0 },
      { model: 'goblin_hideTent', dx:  5, dz:  0 },
      { model: 'goblin_hideTent', dx:  0, dz:  5 },
      { model: 'goblin_bonePile', dx:  0, dz:  0 },
      { model: 'goblin_meatRack', dx: -3, dz: -4 },
      { model: 'goblin_warDrum',  dx:  3, dz: -4 },
      { model: 'goblin_cage',     dx:  6, dz: -3 }
    ]
  },

  hobgoblin_bivouac: {
    radius: 11,
    parts: [
      { model: 'hobgoblin_warTent',  dx: -4, dz:  0 },
      { model: 'hobgoblin_warTent',  dx:  4, dz:  0 },
      { model: 'hobgoblin_warTent',  dx:  0, dz: -5 },
      { model: 'hobgoblin_siegeRam', dx:  0, dz:  5 },
      { model: 'hobgoblin_warTent',  dx: -8, dz: -3 },
      { model: 'hobgoblin_warTent',  dx:  8, dz: -3 }
    ]
  },

  graveyard: {
    radius: 9,
    parts: [
      { model: 'undead_gravestone', dx: -3, dz: -3 },
      { model: 'undead_gravestone', dx:  3, dz: -3 },
      { model: 'undead_gravestone', dx: -3, dz:  0 },
      { model: 'undead_gravestone', dx:  3, dz:  0 },
      { model: 'undead_gravestone', dx: -3, dz:  3 },
      { model: 'undead_gravestone', dx:  3, dz:  3 },
      { model: 'undead_deadTree',   dx: -5, dz:  0 },
      { model: 'undead_deadTree',   dx:  5, dz:  0 },
      { model: 'undead_openGrave',  dx:  0, dz:  5 },
      { model: 'undead_coffin',     dx:  0, dz: -5 },
      { model: 'undead_ironFence',  dx:  0, dz:  7 }
    ]
  },

  crypt_site: {
    radius: 8,
    parts: [
      { model: 'undead_crypt',      dx:  0, dz: -3 },
      { model: 'undead_boneArch',   dx:  0, dz:  4 },
      { model: 'undead_deadTree',   dx: -5, dz:  0 },
      { model: 'undead_deadTree',   dx:  5, dz:  0 },
      { model: 'undead_gravestone', dx: -4, dz:  6 },
      { model: 'undead_gravestone', dx:  4, dz:  6 }
    ]
  },

  // Volcanic field: two basalt column clusters arranged as a small
  // formation. Deliberately two, not three — three starts to read as
  // "wall" at battle zoom, while two reads as "a scattering of
  // formations on a volcanic plain", which is what the biome should
  // look like. Each cluster's per-instance Y rotation from
  // placeSceneryPattern gives them distinct silhouettes even though
  // they share one geometry.
  volcanic_field: {
    radius: 6,
    parts: [
      { model: 'volcanic_basalt', dx: -2, dz: -1 },
      { model: 'volcanic_basalt', dx:  3, dz:  2 }
    ]
  }
};

// Per-biome density (sites per 10,000 cells) + allowed pattern types.
// `null` = no scenery for that biome.
export const BiomeSceneryByBiome = {
  grassland: { onGrass: 0.15, types: ['human_camp'] },
  woodland:  { onGrass: 0.20, types: ['goblin_camp'] },
  marsh:     null,
  highland:  { onGrass: 0.15, types: ['hobgoblin_bivouac'] },
  arid:      { onSand: 0.10, types: ['goblin_camp'] },
  ruins:     null,   // already dense with ruin patterns
  river:     { onGrass: 0.15, types: ['human_camp'] },
  steppes:   { onGrass: 0.15, types: ['goblin_camp'] },
  jungle:    { onForestFloor: 0.10, types: ['goblin_camp'] },
  wasteland: { onGrass: 0.30, types: ['graveyard', 'crypt_site'] },
  oasis:     null,
  seaside:   { onSand: 0.10, types: ['human_camp'] },

  // Volcanic: basalt formations sit on hardened basalt (ROCKY) and
  // ash (SAND). Higher density than other biomes because the basalt
  // columns ARE the biome's identity — a volcanic map without them
  // would read as "dark wasteland" instead of "volcanic caldera".
  volcanic:  { onRocky: 1.5, onSand: 0.5, types: ['volcanic_field'] }
};

// Deterministic per (biome, ix, iz, seed) pick from the biome's type list.
export function pickSceneryType(biome, ix, iz, seed) {
  const def = BiomeSceneryByBiome[biome.id];
  if (!def || !def.types || def.types.length === 0) return null;
  if (def.types.length === 1) return def.types[0];

  let h = Math.imul(ix | 0, 374761393)
        + Math.imul(iz | 0, 668265263)
        + Math.imul((seed | 0) + 41, 1442695041);
  h |= 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  const f = (h >>> 0) / 4294967295;
  return def.types[Math.floor(f * def.types.length)];
}

// Module-level density multiplier. Default 1 — production callers never
// change this, and leaving it at 1 reproduces the authored densities
// exactly. The terrain test page multiplies by 20 while its "Scenery
// 20×" mode is on, so a single site that lands once per ~60,000 cells
// becomes visible in a 4-view screenshot pass instead of hiding in the
// 96% of the map the test harness does not capture.
let _densityMultiplier = 1;

export function setSceneryDensityMultiplier(mult) {
  const v = parseFloat(mult);
  _densityMultiplier = (v > 0) ? v : 0;
}

export function getSceneryDensityMultiplier() {
  return _densityMultiplier;
}

// Density lookup by biome id + ground key ('onGrass', 'onSand', ...).
// Returns the authored density multiplied by the current runtime
// multiplier (1 in production, up to 20 in the terrain test's boosted
// mode). 0 means "no scenery in this biome".
export function sceneryDensityFor(biomeId, key) {
  const def = BiomeSceneryByBiome[biomeId];
  if (!def) return 0;
  return (def[key] || 0) * _densityMultiplier;
}
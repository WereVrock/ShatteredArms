// ===== BiomeVisuals.js =====
// Per-biome visual identity. DATA ONLY.
//
// Density values are RELATIVE: high = thicker fog. The actual fog
// distance is computed by SceneSetup (in-game) or the test page (in
// test) from the CURRENT camera-to-target distance, so a zoomed-out
// overview still sees the whole map while a closeup has depth. Higher
// density shrinks that distance proportionally.
//
// Reference: 0.0015 (seaside) reads as a faint haze at the horizon.
// 0.0035 (jungle/marsh) reads as a soft atmosphere that does not hide
// the battlefield. Above 0.005 starts to obscure, which is not wanted.

export const BiomeVisuals = {
  grassland: {},

  woodland: {
    ground: {
      grass:       { color: [0x30, 0x4a, 0x22], alpha: 0.75 },
      forestFloor: { color: [0x1e, 0x2e, 0x14], alpha: 0.95 }
    },
    treeStyle: 'standard',
    water: { deep: [0x20, 0x30, 0x38], shallow: [0x30, 0x42, 0x48] },
    fog: { color: 0x2a3038, density: 0.0025 },
    sky: 0x18202a
  },

  marsh: {
    ground: {
      grass: { color: [0x44, 0x52, 0x30], alpha: 0.7 },
      mud:   { color: [0x3a, 0x30, 0x20], alpha: 0.95 }
    },
    treeStyle: 'standard',
    water: { deep: [0x2e, 0x3a, 0x24], shallow: [0x3a, 0x48, 0x2a] },
    fog: { color: 0x3a4030, density: 0.0035 },
    sky: 0x2a3020,
    particles: 'marsh-bugs'
  },

  highland: {
    ground: {
      grass: { color: [0x5a, 0x62, 0x48], alpha: 0.7 },
      rocky: { color: [0x8a, 0x88, 0x80], alpha: 0.9 }
    },
    treeStyle: 'standard',
    snowHeight: 9.0,
    water: { deep: [0x1c, 0x28, 0x2c], shallow: [0x2e, 0x3c, 0x40] },
    fog: { color: 0x6a7080, density: 0.0030 },
    sky: 0x505870,
    particles: 'snow'
  },

  arid: {
    ground: {
      sand:  { color: [0xc0, 0xa0, 0x70], alpha: 0.9 },
      rocky: { color: [0x9a, 0x80, 0x60], alpha: 0.9 }
    },
    treeStyle: 'standard',
    water: { deep: [0x30, 0x50, 0x60], shallow: [0x40, 0x60, 0x70] },
    fog: { color: 0x9a8060, density: 0.0020 },
    sky: 0x706050,
    particles: 'sand'
  },

  ruins: {
    ground: {
      grass: { color: [0x4a, 0x48, 0x38], alpha: 0.7 },
      rocky: { color: [0x82, 0x7a, 0x70], alpha: 0.9 }
    },
    treeStyle: 'standard',
    water: { deep: [0x1e, 0x28, 0x30], shallow: [0x30, 0x3a, 0x42] },
    fog: { color: 0x4a4840, density: 0.0028 },
    sky: 0x3a3830
  },

  river: {
    ground: {
      grass: { color: [0x42, 0x5a, 0x32], alpha: 0.75 }
    },
    treeStyle: 'standard',
    water: { deep: [0x20, 0x40, 0x58], shallow: [0x30, 0x50, 0x68] },
    fog: { color: 0x303840, density: 0.0020 },
    sky: 0x283848
  },

  steppes: {
    ground: {
      grass:       { color: [0xb0, 0xa0, 0x60], alpha: 0.85 },
      forestFloor: { color: [0x80, 0x78, 0x48], alpha: 0.9 },
      sand:        { color: [0xa8, 0x98, 0x68], alpha: 0.9 },
      rocky:       { color: [0x90, 0x88, 0x78], alpha: 0.9 }
    },
    treeStyle: 'dead',
    water: { deep: [0x30, 0x48, 0x50], shallow: [0x40, 0x58, 0x60] },
    fog: { color: 0x9a9060, density: 0.0025 },
    sky: 0x806040,
    particles: 'sand'
  },

  jungle: {
    ground: {
      grass:       { color: [0x18, 0x30, 0x18], alpha: 0.85 },
      forestFloor: { color: [0x10, 0x1e, 0x10], alpha: 0.95 },
      mud:         { color: [0x28, 0x24, 0x18], alpha: 0.95 }
    },
    treeStyle: 'standard',
    water: { deep: [0x10, 0x28, 0x18], shallow: [0x18, 0x34, 0x20] },
    fog: { color: 0x1a2418, density: 0.0035 },
    sky: 0x0e1810,
    particles: 'mist'
  },

  wasteland: {
    ground: {
      grass: { color: [0x68, 0x58, 0x40], alpha: 0.8 },
      sand:  { color: [0x90, 0x78, 0x58], alpha: 0.9 },
      rocky: { color: [0x72, 0x62, 0x50], alpha: 0.9 }
    },
    treeStyle: 'dead',
    water: { deep: [0x28, 0x28, 0x28], shallow: [0x38, 0x36, 0x34] },
    fog: { color: 0x6a5040, density: 0.0030 },
    sky: 0x4a3020
  },

  oasis: {
    ground: {
      grass: { color: [0x40, 0x70, 0x30], alpha: 0.85 },
      sand:  { color: [0xc8, 0xb0, 0x80], alpha: 0.9 }
    },
    treeStyle: 'standard',
    water: { deep: [0x20, 0x50, 0x60], shallow: [0x30, 0x68, 0x78] },
    fog: { color: 0x7a6850, density: 0.0015 },
    sky: 0x504030
  },

  seaside: {
    ground: {
      grass: { color: [0x50, 0x68, 0x38], alpha: 0.75 },
      sand:  { color: [0xe0, 0xd0, 0xa0], alpha: 0.92 }
    },
    treeStyle: 'standard',
    water: { deep: [0x0e, 0x38, 0x60], shallow: [0x1a, 0x50, 0x78] },
    fog: { color: 0x6090a0, density: 0.0012 },
    sky: 0x5080a8
  },

  // Volcanic Caldera. Black basalt + ash + scorched scrub. The fog is
  // a warm reddish-brown that reads as "ash haze" — combined with the
  // dark red sky it makes the biome immediately distinct from wasteland
  // (which is brown-grey) without needing any shader work. Ground
  // colours are deliberately near-black so the basalt columns stand
  // out as lighter formations against the field.
  volcanic: {
    ground: {
      rocky:       { color: [0x3a, 0x2a, 0x20], alpha: 0.95 },
      sand:        { color: [0x24, 0x16, 0x0e], alpha: 0.95 },
      mud:         { color: [0x14, 0x0c, 0x06], alpha: 0.95 },
      forestFloor: { color: [0x24, 0x18, 0x10], alpha: 0.90 }
    },
    treeStyle: 'dead',
    fog: { color: 0x3a1808, density: 0.0035 },
    sky: 0x2a1008,
    particles: 'ash'
  }
};

export const TERRAIN_TYPE_KEY = [
  'grass',        // 0 GRASS
  'road',         // 1 ROAD
  'mud',          // 2 MUD
  'sand',         // 3 SAND
  'shallowWater', // 4 SHALLOW_WATER
  'forestFloor',  // 5 FOREST_FLOOR
  'rocky',        // 6 ROCKY
  'deepWater',    // 7 DEEP_WATER
  'roadStone'     // 8 ROAD_STONE
];
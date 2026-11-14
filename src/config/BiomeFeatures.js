// ===== BiomeFeatures.js =====
// Per-biome structural feature declarations. DATA ONLY.
//
// A "feature" is a hand-authored placement rule that runs BEFORE the
// obstacle pass. Each feature modifies cell types (paints water, marks
// forest floor, adds sand paths) and may place some landmark obstacles
// directly. The obstacle pass then fills in trees/rocks naturally on
// top of the modified cells.
//
// Counts are capped per biome by cell count (see TerrainFeaturePass's
// CELLS_PER_FEATURE_CAP): a biome that fills 5% of the map places fewer
// features than one that fills 40%.
//
// Kinds and their effects:
//   stream       linear band of water with muddy banks
//   pond         circular water body; records its position for later
//                features (palmRing, bankMarsh)
//   clearing     circular patch of grass cut out of forest floor
//   treeCluster  circular patch of forest floor + landmark trees
//   rockOutcrop  circular patch of rocky ground + landmark rocks
//   shrubCluster scattered bushes
//   palmGrove    scattered palms (used when not anchored to water)
//   palmRing     palms arranged in a ring around the last pond — for
//                Oasis (a lush green ring at the water's edge)
//   dryWash      linear band of sand (a dry riverbed)
//   ridge        linear band of rocky ground + rocks along the line
//   causeway     linear band of grass through wet terrain
//   marshPatch   circular patch of mud + shallow water (anywhere)
//   bankMarsh    like marshPatch but anchored to the river bank;
//                no-op when the battle has no river
//   oxbow        small pond near the river, off its main path
//   riverbank    clusters of trees and bushes along the river bank;
//                no-op when the battle has no river
//   fallenLog    short WALL segments rendered as horizontal cylinders
//
// BiomeFeatures entries without a declared kind simply have no features.

export const BiomeFeatures = {
  // Grassland: one sun shrine somewhere on the map — a tall central
  // column with a ring of standing stones. Landmark, not decoration.
  grassland: {
    treeCluster:  { count: [1, 2], radius: [10, 18] },
    rockOutcrop:  { count: [1, 2], radius: [5, 10] },
    sunShrine:    { count: [0, 1] }
  },

  woodland: {
    stream:       { count: [1, 2], length: [80, 140], width: [3, 5] },
    pond:         { count: [2, 3], radius: [4, 7] },
    clearing:     { count: [3, 5], radius: [10, 20] },
    rockOutcrop:  { count: [1, 2], radius: [6, 12] },
    fallenLog:    { count: [4, 8], length: [3, 6] }
  },

  marsh: {
    pond:         { count: [3, 5], radius: [5, 10] },
    causeway:     { count: [1, 2], length: [60, 120], width: [2, 3] }
  },

  highland: {
    ridge:        { count: [2, 3], length: [40, 80], width: [4, 6] },
    rockOutcrop:  { count: [2, 3], radius: [5, 10] },
    stream:       { count: [0, 1], length: [60, 100], width: [2, 3] }
  },

  arid: {
    dryWash:      { count: [1, 2], length: [80, 140], width: [3, 5] },
    rockOutcrop:  { count: [1, 2], radius: [4, 8] }
  },

  // Ruins biome is fully covered by the ruin-pattern system.
  ruins: {},

  // Riverlands: the river is placed by paintRiver in TerrainGenerator.
  // Everything here hugs the river. bankMarsh and riverbank read
  // terrain._riverPath (recorded by paintRiver) and are no-ops when the
  // biome has no river. oxbow is a small cut-off meander pond.
  river: {
    bankMarsh:    { count: [2, 3], radius: [8, 14] },
    oxbow:        { count: [1, 2], radius: [4, 8] },
    riverbank:    { count: [4, 6] }
  },

  steppes: {
    dryWash:      { count: [1, 2], length: [80, 120], width: [4, 6] },
    shrubCluster: { count: [3, 5], radius: [3, 6] },
    rockOutcrop:  { count: [1, 2], radius: [4, 8] }
  },

  jungle: {
    stream:       { count: [1, 2], length: [60, 120], width: [2, 4] },
    clearing:     { count: [1, 2], radius: [8, 15] },
    rockOutcrop:  { count: [1, 2], radius: [4, 7] },
    stoneCircle:  { count: [1, 1] }
  },

  wasteland: {
    rockOutcrop:  { count: [3, 4], radius: [6, 12] },
    dryWash:      { count: [1, 2], length: [60, 100], width: [4, 6] }
  },

  // Oasis: 1-3 large oases in a sand sea. Each pond gets a grass halo
  // and a palm ring. minEdgeDistance keeps the oases away from the map
  // edge so the greenery reads as distinct green islands rather than a
  // clipped band. palmRing's count is 1 (one pass) but it rings EVERY
  // pond it finds, so 1-3 ponds get 1-3 palm rings from one call.
  oasis: {
    pond:         { count: [1, 3], radius: [18, 28], grassRing: true, minEdgeDistance: 70 },
    palmRing:     { count: [1, 1] }
  },

  // Seaside: palms and shrubs scattered along the beach. The sea itself
  // is painted by paintSea in TerrainGenerator; these features fill in
  // the vegetation on the sand.
  seaside: {
    palmGrove:    { count: [3, 5], radius: [4, 8] },
    shrubCluster: { count: [2, 4], radius: [3, 6] },
    rockOutcrop:  { count: [1, 2], radius: [4, 6] },
    shipwreck:    { count: [1, 2] }
  }
};

// Height-only features. These modify the heightfield, so they run AFTER
// carveWater (which smooths the terrain and would otherwise flatten the
// dune crests). They use the same schema as BiomeFeatures, with an extra
// `height` field.
export const BiomeHeightFeatures = {
  arid: {
    duneRidge: { count: [2, 3], length: [60, 100], width: [8, 14], height: [2.5, 4.5] }
  }
};
// Terrain data only. No logic.

export const TerrainType = Object.freeze({
  GRASS: 0,
  ROAD: 1,             // dirt / paved road
  MUD: 2,
  SAND: 3,
  SHALLOW_WATER: 4,
  FOREST_FLOOR: 5,
  ROCKY: 6,
  DEEP_WATER: 7,
  ROAD_STONE: 8        // cobbled road / bridge surface
});

// Indexed by TerrainType. foot/mounted are WALK-gait speed multipliers.
// Other gaits derive from them via GAIT_EXPONENT (see below).
// blocked: impassable cell. grassy: grass tufts may grow here (render only).
// color/alpha: overlay colour painted over the base ground texture.
//
// The two water entries are the LAKE BED colour, not the water: the water
// itself is a separate transparent mesh (TerrainWaterView) drawn on top.
export const TerrainTypes = [
  { name: 'grass',         foot: 1.00, mounted: 1.00, blocked: false, grassy: true,  color: [0x3f, 0x55, 0x28], alpha: 0 },
  { name: 'road',          foot: 1.12, mounted: 1.25, blocked: false, grassy: false, color: [0x8a, 0x77, 0x57], alpha: 0.92 },
  { name: 'mud',           foot: 0.55, mounted: 0.40, blocked: false, grassy: false, color: [0x4e, 0x3b, 0x28], alpha: 0.94 },
  { name: 'sand',          foot: 0.80, mounted: 0.70, blocked: false, grassy: false, color: [0xb8, 0xa4, 0x70], alpha: 0.92 },
  { name: 'shallow water', foot: 0.50, mounted: 0.40, blocked: false, grassy: false, color: [0x4a, 0x5c, 0x58], alpha: 0.95 },
  { name: 'forest floor',  foot: 0.80, mounted: 0.65, blocked: false, grassy: true,  color: [0x2d, 0x40, 0x1e], alpha: 0.80 },
  { name: 'rocky ground',  foot: 0.70, mounted: 0.55, blocked: false, grassy: false, color: [0x6e, 0x6a, 0x62], alpha: 0.88 },
  { name: 'deep water',    foot: 0.10, mounted: 0.10, blocked: true,  grassy: false, color: [0x1f, 0x33, 0x3e], alpha: 0.97 },
  { name: 'stone road',    foot: 1.15, mounted: 1.30, blocked: false, grassy: false, color: [0x9a, 0x94, 0x88], alpha: 0.95 }
];

// Gait -> exponent applied to the terrain multiplier. A terrain with walk
// multiplier m gives m^exponent for that gait, so rough ground hurts a
// runner more than a walker. Add new gaits here.
export const GAIT_EXPONENT = { walk: 1.0, run: 1.5 };

export const ObstacleKind = Object.freeze({
  TREE: 0, ROCK: 1, WALL: 2,
  COLUMN: 3, BUSH: 4, CACTUS: 5, PALM: 6,
  RUIN: 7, SCENERY: 8
});

export const TerrainConfig = {
  // World units per terrain cell. Map is 800x800, so 2.0 = 400x400 cells.
  cellSize: 2.0,

  // Area the generator fills. Always at least +-minHalfExtent around the
  // origin, grown to cover every unit plus `padding`, snapped outward to
  // `snap` units, clamped to the map.
  // Terrain covers the whole playable field PLUS a skirt beyond it, so
  // the field-boundary marker (at CombatConfig.mapBounds, ±400) sits on
  // generated ground instead of bare flat plane. Without this the
  // boundary sampling in SceneSetup._updateFieldEdgeHeights had no
  // terrain to sample at the edges and the strips stayed flat while
  // hills rose around them.
  //
  // 440 = mapBounds (±400) + edge-fade zone (40 in
  // TerrainHeightGenerator). Boundary at ±400 sits inside the fade-free
  // band, so it follows real hill heights rather than the flat taper at
  // the mesh edge. Padding 60 is a fallback for units deployed beyond
  // ±380 — rare but the region still grows for them.
  //
  // Cost: ~774k cells vs ~578k at the previous 380/60 setting, so
  // generation is ~1.34x slower than the last patch. One-time hitch,
  // not per-frame.
  // Terrain covers past CombatConfig.mapBounds (±400) so the field-
  // boundary strips, which are at ±400, sit inside the generated region
  // and can sample real terrain heights. 440 = 400 + the 40-unit edge-
  // fade zone in TerrainHeightGenerator, so the boundary is exactly at
  // the start of the fade and gets full hill height.
  // minHalfExtent 440 -> 520. The generated terrain now extends 120 world
  // units beyond CombatConfig.mapBounds (±400) instead of 40. Same
  // generation passes (height, ground, features, obstacles, water) all
  // cover the extended area — this is not a decorative ring, it is more
  // of the same terrain.
  //
  // Cost: cell count grows from ~193k to ~270k (+40%), so generation is
  // ~40% slower (~1.4s vs ~1.0s at the previous setting). One-time hitch
  // on battle load, no per-frame cost.
  //
  // Effect: with the camera target clamped to mapBounds, the player
  // never sees a hard terrain edge — the terrain fills the visible area
  // all the way out to the fog wall.
  // minHalfExtent 520 -> 1000. The generated terrain now extends 600
  // world units beyond CombatConfig.mapBounds (±400) instead of 120 —
  // 5x the previous buffer. Same generation passes (height, ground,
  // features, obstacles, water) all cover the extended area; it is
  // more of the same terrain, not a decorative ring.
  //
  // Cost: cell count scales with the SQUARE of the linear extent, so
  // going from ±520 to ±1000 grows the grid from ~270k to ~1,000,000
  // cells (3.7x). Expected one-time load cost: ~1.4s -> ~5s. The
  // overlay texture grows from 1560x1560 to 3000x3000 px (~36 MB).
  // All one-time — no per-frame cost.
  //
  // Effect: the buffer now comfortably exceeds the maximum distance the
  // camera can see from any point inside the playable field, so even at
  // max zoom-out in a corner the player never sees the terrain's hard
  // edge — the terrain fills the view all the way out to the fog wall.
  region: { minHalfExtent: 1000, padding: 60, snap: 10 },

  // Terrain is NEVER cleared for the armies. After generation,
  // TerrainPlacement moves units standing on blocked ground (deep water,
  // trees, rocks, walls) to the nearest free spot.
  //   margin:    extra clearance around a soldier's body.
  //   shiftStep / maxShift: whole-formation search grid and range.
  //   nudgeStep / maxNudge: single-soldier fallback search.
  // shiftFormation: true moves a whole unit to the nearest spot where every
  // soldier is free (the old behaviour, which relocated big units up to
  // maxShift away). Off by default: slots and soldiers are placed individually.
  placement: { margin: 0.15, shiftFormation: false, shiftStep: 3, maxShift: 60, nudgeStep: 0.5, maxNudge: 30 },

  // Obstacle bucket size for collision queries.
  obstacleBucketSize: 8,
  defaultSoldierRadius: 0.25,

  // Hills and valleys. Heights are always >= 0 (valley floor = 0) so the flat
  // base ground plane never shows through the terrain mesh.
  elevation: {
    // Set false to generate flat terrain (no hills).
    enabled: true,
    // Tobler hiking function, normalised so flat ground = 1.0:
    //   factor = exp(-k * (|slope + offset| - offset))
    // slope = rise / run along the direction of travel.
    toblerK: 2.2,
    toblerKMounted: 3.2,
    toblerOffset: 0.05,
    // Floor raised from 0.2 to 0.4 so an extreme slope cannot turn
    // a unit into a crawl, but typical hills still differentiate.
    minSpeedFactor: 0.4,
    maxSpeedFactor: 1.2,
    // Walking fatigue multiplier while climbing: 1 + slope * factor, capped.
    // Slope 0.3 -> 3.4x. Raise the factor to make hills more exhausting.
    climbFatigueFactor: 8,
    climbFatigueCap: 5
  },

  tree: { collisionRadius: 0.32, trunkHeight: 2.2 },
  rock: { minRadius: 0.7, maxRadius: 2.6, heightFactor: 1.05 },
  wall: { thickness: 0.7, height: 1.4 },
  column: { radius: 0.5, height: 3.0 },
  bush: { radius: 0.55, height: 0.85 },
  cactus: { radius: 0.3, height: 2.0 },
  palm: { trunkRadius: 0.22, trunkHeight: 4.2, crownRadius: 1.3 },

  nav: {
    // Clearance is measured up to this distance from obstacles.
    maxClearance: 8,
    // Cells closer than proximityDist to an obstacle cost extra, so
    // paths prefer open ground over hugging trees and walls.
    proximityDist: 3.0,
    proximityPenalty: 0.25,
    // A* node cap per search. Unreachable goals stop here and return the
    // best partial path instead of flooding the whole map.
    maxExpansions: 60000,
    // Weighted A*: heuristic multiplier. Higher = fewer expansions, slightly
    // longer raw paths (smoothing recovers most of it). 1.0 = exact A*.
    heuristicWeight: 1.3,
    // Soft clearance: extra cost per unit a cell falls short of the requested
    // clearance, and a steeper one under tightClearance (barely fits a soldier).
    narrowPenalty: 0.8,
    tightClearance: 0.6,
    tightPenalty: 6,
    // A goal inside a rock or lake snaps to the nearest open cell within this many cells.
    goalSnapCells: 8,
    // Node budget for the wide-clearance A* stages. The last stage uses
    // maxExpansions above.
    stageExpansions: 6000,
    // If a straight line is no more than this much costlier than ideal,
    // skip A* entirely.
    directPathSlack: 1.15,
    // Largest clearance a path search demands, however wide the formation.
    // Wider units squeeze their column count to fit (see FormationSqueeze)
    // instead of detouring or failing. Raise it to make big units prefer wider
    // gaps; lower it to let them take tighter shortcuts. Gaps narrower than
    // this still work through the final 0.6 fallback stage.
    squeezeClearance: 2.0,
    // Max cells scanned ahead when smoothing a path.
    smoothLookahead: 60
  }
};
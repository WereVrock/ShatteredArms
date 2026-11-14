import { TerrainGenerator } from './TerrainGenerator.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { TerrainConfig } from '../config/TerrainConfig.js';

// Terrain region for a battle: always at least the default square around
// the origin, grown to cover every unit plus padding, clamped to the map.
// Snapped outward to a coarse grid so tiny unit-position differences never
// change the region. Deterministic for identical unit positions.
function regionFor(units) {
  const cfg = TerrainConfig.region;
  const b = CombatConfig.mapBounds;
  let minX = -cfg.minHalfExtent, maxX = cfg.minHalfExtent;
  let minZ = -cfg.minHalfExtent, maxZ = cfg.minHalfExtent;

  for (const u of units) {
    for (const s of u.soldiers) {
      if (!s.isAlive()) continue;
      if (s.pos.x - cfg.padding < minX) minX = s.pos.x - cfg.padding;
      if (s.pos.x + cfg.padding > maxX) maxX = s.pos.x + cfg.padding;
      if (s.pos.z - cfg.padding < minZ) minZ = s.pos.z - cfg.padding;
      if (s.pos.z + cfg.padding > maxZ) maxZ = s.pos.z + cfg.padding;
    }
  }

  // The region is NOT clamped to CombatConfig.mapBounds. It is only
  // bounded by minHalfExtent (the guaranteed square around the origin)
  // plus unit positions + padding. This is what lets terrain generation
  // extend past the playable field into the fog — the previous
  // Math.max(b.minX, ...) / Math.min(b.maxX, ...) clamps silently
  // undid every minHalfExtent increase, so terrain stayed locked to
  // ±mapBounds no matter what the config said.
  //
  // Units live inside mapBounds, so their +padding growth cannot push
  // the region more than `padding` past the playable field even in the
  // worst case. minHalfExtent is the driver that extends the terrain
  // further than that.
  const snap = cfg.snap;
  return {
    minX: Math.floor(minX / snap) * snap,
    maxX: Math.ceil(maxX / snap) * snap,
    minZ: Math.floor(minZ / snap) * snap,
    maxZ: Math.ceil(maxZ / snap) * snap
  };
}

// Pure sim-side terrain construction (no rendering). Deterministic for a
// given seed, preset, biome and unit positions, so multiplayer peers that
// feed in the same inputs get identical terrain.
//
// Nothing is cleared for deployment zones or units any more. Units standing
// on blocked ground are moved afterwards by TerrainPlacement.
export function buildBattleTerrain({ units, seed, preset, biome = 'auto', ruinType = 'random' }) {
  const _tA = performance.now();
  const region = regionFor(units);
  // The TerrainMap grid must cover the FULL region the generator writes
  // to. regionFor() deliberately extends past CombatConfig.mapBounds
  // into the fog (see TerrainConfig.region), but TerrainMap is built
  // with its `bounds` argument — passing only mapBounds (±400) silently
  // clamped every cell past the playable field, so all generation passes
  // (heights, ground, features, water, road, obstacles) stopped at ±400
  // and the map edges showed a bare flat plane until the fog wall.
  // Union the two so the terrain actually reaches the fog.
  const mb = CombatConfig.mapBounds;
  const bounds = {
    minX: Math.min(mb.minX, region.minX),
    maxX: Math.max(mb.maxX, region.maxX),
    minZ: Math.min(mb.minZ, region.minZ),
    maxZ: Math.max(mb.maxZ, region.maxZ)
  };
  const terrain = TerrainGenerator.generate({
    seed, preset, biome, ruinType, region, bounds
  });
  const _tB = performance.now();
  // Nav grid build is DEFERRED to the first findPath() call. With the 5x
  // buffer (1M cells) the eager warmNav() was a 500-1500ms block in the
  // battle-load critical path, which the player perceives as "the game
  // is slow to start". Removing it moves that cost to the first move
  // order — a ~1s hitch the first time the player clicks Move — which
  // is the pacing most games use: fast load, brief delay the first time
  // you touch a system. The Pathfinder is still lazily created by
  // TerrainMap.findPath, so no other code needs to change.
  // terrain.warmNav();
  const _tC = performance.now();
  console.log(
    `%c[terrain.build] generate=${(_tB - _tA).toFixed(0)}ms ` +
    `warmNav=${(_tC - _tB).toFixed(0)}ms ` +
    `total=${(_tC - _tA).toFixed(0)}ms`,
    'color:#8c8;font-weight:bold'
  );
  return terrain;
}
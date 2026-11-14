import { fbm, hash2 } from './TerrainNoise.js';
import { Biomes, BiomeSelection, BiomeClimateTargets } from '../config/BiomeConfig.js';

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Biomes eligible as the "home biome" of a map. The special override
// biomes (ruins, oasis) are excluded: they are applied as pockets on top
// of the climate mosaic, not as whole-map settings.
const HOME_BIOME_IDS = [
  'grassland', 'woodland', 'marsh', 'highland', 'arid',
  'river', 'steppes', 'jungle', 'wasteland', 'seaside'
];

// Decides which biome every point of the battlefield belongs to.
// Deterministic for a given seed + biome id, so multiplayer peers agree.
//
//   biomeId 'auto'      hybrid: one home biome (seed-picked) dominates,
//                       the remaining fraction is a climate mosaic of
//                       neighbouring biomes.
//   any id in Biomes    that one biome everywhere.
export class BiomeField {
  constructor(seed, biomeId = 'auto') {
    this.seed = seed;
    this.forced = (biomeId && biomeId !== 'auto' && Biomes[biomeId]) ? Biomes[biomeId] : null;

    // Home biome: the seed picks one climate biome, which becomes the
    // dominant biome of the map. Skipped when a biome is forced.
    this.homeBiome = null;
    if (!this.forced) {
      const idx = Math.floor(hash2(seed, 7, 211) * HOME_BIOME_IDS.length);
      this.homeBiome = Biomes[HOME_BIOME_IDS[idx]];
    }

    // Small per-seed climate bias — makes different seeds differ even
    // when they pick the same home biome.
    const range = BiomeSelection.climateBiasRange;
    this.moistureBias = (hash2(seed, 3, 71) - 0.5) * 2 * range;
    this.ruggedBias = (hash2(seed, 5, 73) - 0.5) * 2 * range;

    // Home bias: pull the whole map's climate toward the home biome's
    // natural centre. With homeInfluence = 0.55 an arid home gets a
    // moisture mean around 0.42, which puts the arid threshold at the
    // sweet spot: ~55% of the map becomes arid, the rest still holds a
    // real mosaic of neighbours.
    if (this.homeBiome) {
      const t = BiomeClimateTargets[this.homeBiome.id];
      if (t) {
        const w = BiomeSelection.homeInfluence;
        this.moistureBias += (t.moisture - 0.5) * w;
        this.ruggedBias += (t.rugged - 0.5) * w;
      }
    }
  }

  _warpX(x, z) {
    const w = BiomeSelection.warp;
    return x + (fbm(x * w.scale + 3.1, z * w.scale, this.seed * 13 + 7) - 0.5) * w.amount;
  }

  _warpZ(x, z) {
    const w = BiomeSelection.warp;
    return z + (fbm(x * w.scale, z * w.scale + 8.3, this.seed * 13 + 19) - 0.5) * w.amount;
  }

  _moisture(wx, wz) {
    const s = BiomeSelection.fieldScale;
    return fbm(wx * s + 9.3, wz * s, this.seed * 17 + 101) + this.moistureBias;
  }

  _rugged(wx, wz) {
    const s = BiomeSelection.fieldScale;
    return fbm(wx * s, wz * s + 4.7, this.seed * 19 + 211) + this.ruggedBias;
  }

  // High-frequency "civilisation" noise that spawns ruins pockets.
  _civ(wx, wz) {
    const s = 0.014;
    return fbm(wx * s + 42.1, wz * s, this.seed * 23 + 401);
  }

  // Fine-grained wetness inside arid regions; high values become oases.
  _aridWet(wx, wz) {
    const s = 0.08;
    return fbm(wx * s + 33.3, wz * s + 4.1, this.seed * 11 + 97);
  }

  biomeAt(x, z) {
    if (this.forced) return this.forced;
    const sel = BiomeSelection;
    const wx = this._warpX(x, z);
    const wz = this._warpZ(x, z);

    // Ruins override wherever civilisation noise is high.
    if (this._civ(wx, wz) >= sel.ruinsCiv) return Biomes.ruins;

    const r = this._rugged(wx, wz);
    if (r >= sel.highlandRugged) return Biomes.highland;

    const m = this._moisture(wx, wz);
    if (m <= sel.aridMoisture) {
      // Arid is a desert — no water, no oasis pockets. The Oasis biome
      // still exists and can be forced from Custom Battle, but the auto
      // mosaic never sprinkles wet patches inside a desert any more.
      return Biomes.arid;
    }
    if (m >= sel.marshMoisture && r <= sel.marshMaxRugged) return Biomes.marsh;

    // Flat + wet -> river valleys.
    if (r <= sel.riverMaxRugged && m >= sel.riverMoisture) return Biomes.river;

    if (m >= sel.woodlandMoisture) {
      if (r >= sel.jungleRugged) return Biomes.jungle;
      return Biomes.woodland;
    }

    // Mid moisture bands.
    if (r >= sel.wastelandRugged) return Biomes.wasteland;
    if (m <= sel.steppesMoisture) return Biomes.steppes;
    return Biomes.grassland;
  }

  // Hill height multiplier at a point. Smooth (not per-biome) so hills do
  // not step at biome borders. 0.5 .. 1.4 in auto mode.
  reliefMultAt(x, z) {
    if (this.forced) return this.forced.relief;
    const r = this._rugged(this._warpX(x, z), this._warpZ(x, z));
    return 0.5 + 0.9 * smoothstep(0.38, 0.68, r);
  }
}
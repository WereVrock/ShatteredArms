// ===== RuinConfig.js =====
// Ruin types + model definitions. Data only, no logic.
//
// A "ruin type" is a thematic archetype (Temple, Fortress, ...). Each type
// owns 4 visual models. TerrainObstaclePass picks one model per placement
// roll from the archetype chosen for the battle (or a seed-derived random
// one when the caller asks for 'random').
//
// Every model is a small composite of primitive parts. The renderer builds
// one shared geometry per `shape` (see RUIN_SHAPES) and places each part
// via an InstancedMesh. Composite parts are baked into per-instance
// matrices, not merged into one mesh, so the geometry is reused across
// every instance of every model that shares the same shape.
//
// Schema per model:
//   type      — which archetype this belongs to (matches RuinTypes.id).
//   color     — base RGB 0..1. Per-instance shade variation is applied
//               by the renderer via hash2().
//   collision — circular collision radius, in world units.
//   height    — arrow / line-of-sight blocking height above ground.
//   parts     — array of { shape, scale:[x,y,z], offset:[x,y,z], rot? }
//               where offset is the CENTRE of the part relative to the
//               obstacle's base (ground level). rot is optional [x,y,z]
//               Euler radians; when absent the part inherits the
//               obstacle's Y rotation.
//
// All collision queries treat RUIN like ROCK: circular, r + soldier radius.
// Only the renderer cares about `parts`.

export const RuinTypes = [
  // 'none' disables ruin placement entirely, even inside the City Ruins
  // biome. It is not listed in RuinModelsByType, so 'random' never picks
  // it — only an explicit 'none' choice turns ruins off.
  { id: 'none',     displayName: 'No ruins' },
  { id: 'temple',   displayName: 'Temple Ruins' },
  { id: 'fortress', displayName: 'Fortress Ruins' },
  { id: 'village',  displayName: 'Village Ruins' },
  { id: 'tomb',     displayName: 'Tomb Ruins' },
  { id: 'aqueduct', displayName: 'Aqueduct' }
];

export const RuinModelsByType = {
  temple:   ['temple_column', 'temple_drum', 'temple_altar', 'temple_pediment'],
  fortress: ['fortress_tower', 'fortress_wall', 'fortress_gate', 'fortress_rubble'],
  village:  ['village_hut', 'village_well', 'village_fence', 'village_cart'],
  tomb:     ['tomb_sarcophagus', 'tomb_obelisk', 'tomb_statue', 'tomb_doorway'],
  aqueduct: ['aqueduct_pillar', 'aqueduct_arch', 'aqueduct_block', 'aqueduct_pipe']
};

export const RuinModels = {
  // ---------- Temple ----------
  temple_column: {
    type: 'temple', color: [0.78, 0.75, 0.68], collision: 0.55, height: 3.6,
    parts: [
      { shape: 'taper', scale: [1.10, 3.60, 1.10], offset: [0, 1.80, 0] },
      { shape: 'box',   scale: [1.30, 0.30, 1.30], offset: [0, 0.15, 0] }
    ]
  },
  temple_drum: {
    type: 'temple', color: [0.76, 0.73, 0.66], collision: 0.60, height: 0.9,
    parts: [
      { shape: 'cylinder', scale: [1.20, 1.20, 1.20], offset: [0, 0.55, 0],
        rot: [Math.PI / 2, 0, 0] }
    ]
  },
  temple_altar: {
    type: 'temple', color: [0.80, 0.78, 0.72], collision: 0.85, height: 1.3,
    parts: [
      { shape: 'box', scale: [1.40, 1.10, 0.90], offset: [0, 0.55, 0] },
      { shape: 'box', scale: [1.60, 0.20, 1.00], offset: [0, 1.20, 0] }
    ]
  },
  temple_pediment: {
    type: 'temple', color: [0.78, 0.76, 0.70], collision: 0.75, height: 1.3,
    parts: [
      { shape: 'box', scale: [1.80, 0.40, 0.60], offset: [0, 0.20, 0] },
      { shape: 'box', scale: [1.40, 0.55, 0.45], offset: [0, 0.70, 0],
        rot: [0, 0, 0.25] },
      { shape: 'box', scale: [1.40, 0.55, 0.45], offset: [0, 0.70, 0],
        rot: [0, 0, -0.25] }
    ]
  },

  // ---------- Fortress ----------
  fortress_tower: {
    type: 'fortress', color: [0.56, 0.53, 0.48], collision: 1.05, height: 4.0,
    parts: [
      { shape: 'cylinder', scale: [1.70, 4.00, 1.70], offset: [0, 2.00, 0] },
      { shape: 'box',      scale: [1.90, 0.55, 1.90], offset: [0, 4.25, 0] }
    ]
  },
  fortress_wall: {
    type: 'fortress', color: [0.55, 0.52, 0.47], collision: 1.10, height: 2.4,
    parts: [
      { shape: 'box', scale: [2.60, 2.40, 0.65], offset: [0, 1.20, 0] }
    ]
  },
  fortress_gate: {
    type: 'fortress', color: [0.58, 0.55, 0.50], collision: 0.85, height: 3.6,
    parts: [
      { shape: 'box', scale: [0.85, 3.60, 0.85], offset: [0, 1.80, 0] },
      { shape: 'box', scale: [1.15, 0.45, 1.15], offset: [0, 3.70, 0] }
    ]
  },
  fortress_rubble: {
    type: 'fortress', color: [0.52, 0.50, 0.46], collision: 0.90, height: 1.2,
    parts: [
      { shape: 'ico',   scale: [1.60, 1.30, 1.60], offset: [0.35, 0.30, 0.20] },
      { shape: 'ico',   scale: [1.10, 0.90, 1.10], offset: [-0.45, 0.25, 0.35] },
      { shape: 'icoHi', scale: [1.30, 1.00, 1.30], offset: [0.10, 0.35, -0.40] }
    ]
  },

  // ---------- Village ----------
  village_hut: {
    type: 'village', color: [0.60, 0.50, 0.36], collision: 1.05, height: 1.8,
    parts: [
      { shape: 'box', scale: [2.00, 1.10, 1.60], offset: [0, 0.55, 0] },
      { shape: 'box', scale: [1.40, 0.55, 1.10], offset: [0, 1.35, 0],
        rot: [0, 0, 0.18], color: [0.42, 0.30, 0.20] },
      { shape: 'box', scale: [1.40, 0.55, 1.10], offset: [0, 1.35, 0],
        rot: [0, 0, -0.18], color: [0.42, 0.30, 0.20] }
    ]
  },
  village_well: {
    type: 'village', color: [0.56, 0.53, 0.46], collision: 0.65, height: 0.9,
    parts: [
      { shape: 'cylinder', scale: [1.30, 0.90, 1.30], offset: [0, 0.45, 0] }
    ]
  },
  village_fence: {
    type: 'village', color: [0.55, 0.42, 0.28], collision: 0.30, height: 1.6,
    parts: [
      { shape: 'box', scale: [0.28, 1.60, 0.28], offset: [0, 0.80, 0] }
    ]
  },
  village_cart: {
    type: 'village', color: [0.50, 0.36, 0.22], collision: 0.90, height: 1.0,
    parts: [
      { shape: 'box',      scale: [1.60, 0.40, 0.90], offset: [0, 0.55, 0],
        rot: [0, 0, 0.30] },
      { shape: 'cylinder', scale: [0.90, 0.15, 0.90], offset: [0, 0.20, 0.55],
        rot: [Math.PI / 2, 0, 0], color: [0.35, 0.25, 0.15] }
    ]
  },

  // ---------- Tomb ----------
  tomb_sarcophagus: {
    type: 'tomb', color: [0.62, 0.58, 0.51], collision: 0.90, height: 0.95,
    parts: [
      { shape: 'box', scale: [2.20, 0.75, 0.95], offset: [0, 0.375, 0] },
      { shape: 'box', scale: [2.40, 0.20, 1.05], offset: [0, 0.85, 0] }
    ]
  },
  tomb_obelisk: {
    type: 'tomb', color: [0.64, 0.60, 0.54], collision: 0.55, height: 4.2,
    parts: [
      { shape: 'box',  scale: [0.70, 4.20, 0.70], offset: [0, 2.10, 0] },
      { shape: 'cone', scale: [0.70, 0.70, 0.70], offset: [0, 4.55, 0] }
    ]
  },
  tomb_statue: {
    type: 'tomb', color: [0.66, 0.61, 0.55], collision: 0.65, height: 2.6,
    parts: [
      { shape: 'box',      scale: [1.20, 0.60, 1.20], offset: [0, 0.30, 0] },
      { shape: 'cylinder', scale: [0.55, 1.80, 0.55], offset: [0, 1.50, 0] }
    ]
  },
  tomb_doorway: {
    type: 'tomb', color: [0.55, 0.52, 0.46], collision: 1.05, height: 2.6,
    parts: [
      { shape: 'box', scale: [1.70, 2.40, 0.65], offset: [0, 1.20, 0] },
      { shape: 'box', scale: [2.00, 0.40, 0.95], offset: [0, 2.60, 0] }
    ]
  },

  // ---------- Aqueduct ----------
  aqueduct_pillar: {
    type: 'aqueduct', color: [0.72, 0.68, 0.60], collision: 0.70, height: 5.0,
    parts: [
      { shape: 'box', scale: [1.05, 5.00, 1.05], offset: [0, 2.50, 0] },
      { shape: 'box', scale: [1.30, 0.35, 1.30], offset: [0, 0.18, 0] }
    ]
  },
  aqueduct_arch: {
    type: 'aqueduct', color: [0.71, 0.67, 0.59], collision: 1.15, height: 5.0,
    parts: [
      { shape: 'box', scale: [0.85, 5.00, 0.95], offset: [-1.10, 2.50, 0] },
      { shape: 'box', scale: [0.85, 5.00, 0.95], offset: [ 1.10, 2.50, 0] },
      { shape: 'box', scale: [3.05, 0.75, 1.05], offset: [0, 5.35, 0] }
    ]
  },
  aqueduct_block: {
    type: 'aqueduct', color: [0.69, 0.65, 0.58], collision: 0.95, height: 1.4,
    parts: [
      { shape: 'box', scale: [1.80, 1.40, 1.40], offset: [0, 0.70, 0],
        rot: [0, 0.40, 0.12] }
    ]
  },
  aqueduct_pipe: {
    type: 'aqueduct', color: [0.62, 0.58, 0.52], collision: 0.55, height: 0.7,
    parts: [
      { shape: 'cylinder', scale: [0.70, 1.80, 0.70], offset: [0, 0.35, 0],
        rot: [Math.PI / 2, 0, 0] }
    ]
  }
};

// One pattern per ruin type. A pattern is a small, hand-authored layout
// of ruin models relative to a single anchor point (dx, dz in world
// units). The placer picks an anchor, a random rotation, and lays the
// whole pattern down. Radius is the max distance from the anchor to any
// part; the placer uses it to keep two patterns from overlapping.
//
// Ordering is deliberate: linear patterns (tomb, aqueduct) list parts
// along +Z so the visual axis is preserved when the anchor rotates.
export const RuinPatterns = {
  // Tapınak avlusu: merkezde sunak, etrafında 6 sütun, bir tarafta
  // alınlık, 2 devrik tambur. Yaklaşık 7 birim yarıçap.
  temple: {
    radius: 9,
    parts: [
      { model: 'temple_altar',    dx:  0,   dz:  0 },
      { model: 'temple_column',   dx: -5,   dz: -5 },
      { model: 'temple_column',   dx:  5,   dz: -5 },
      { model: 'temple_column',   dx: -5,   dz:  5 },
      { model: 'temple_column',   dx:  5,   dz:  5 },
      { model: 'temple_column',   dx:  0,   dz: -7 },
      { model: 'temple_column',   dx:  0,   dz:  7 },
      { model: 'temple_pediment', dx:  7.5, dz:  0 },
      { model: 'temple_drum',     dx: -7.5, dz:  0 },
      { model: 'temple_drum',     dx:  3,   dz:  7.5 }
    ]
  },

  // Yıkık kale: ortada kapı, sağa-sola duvar blokları, uçlarda kule
  // dipleri, etrafta moloz. Lineer hat boyunca uzun (~16 birim).
  fortress: {
    radius: 12,
    parts: [
      { model: 'fortress_gate',   dx:  0,   dz:  0 },
      { model: 'fortress_wall',   dx: -3,   dz: -2 },
      { model: 'fortress_wall',   dx: -5.5, dz: -2 },
      { model: 'fortress_wall',   dx:  3,   dz: -2 },
      { model: 'fortress_wall',   dx:  5.5, dz: -2 },
      { model: 'fortress_tower',  dx: -8,   dz: -2 },
      { model: 'fortress_tower',  dx:  8,   dz: -2 },
      { model: 'fortress_rubble', dx: -2,   dz:  3 },
      { model: 'fortress_rubble', dx:  4,   dz:  4 }
    ]
  },

  // Terk edilmiş köy: merkez kuyu, 4 kulübe, 2 çit, 1 araba.
  // Yaklaşık 8 birim yarıçap.
  village: {
    radius: 10,
    parts: [
      { model: 'village_well',    dx:  0,   dz:  0 },
      { model: 'village_hut',     dx: -6,   dz: -5 },
      { model: 'village_hut',     dx:  6,   dz: -5 },
      { model: 'village_hut',     dx: -6,   dz:  5 },
      { model: 'village_hut',     dx:  6,   dz:  5 },
      { model: 'village_fence',   dx: -3,   dz:  7.5 },
      { model: 'village_fence',   dx:  3,   dz:  7.5 },
      { model: 'village_cart',    dx:  2.5, dz: -7 }
    ]
  },

  // Nekropol: lineer hat, obelisk önde, 5 lahit sırası, mezar kapısı
  // sonda, yanlarda 2 heykel. Yaklaşık 9 birim yarıçap.
  tomb: {
    radius: 10,
    parts: [
      { model: 'tomb_obelisk',     dx:  0,   dz: -8 },
      { model: 'tomb_sarcophagus', dx: -0.2, dz: -5 },
      { model: 'tomb_sarcophagus', dx: -0.2, dz: -2.5 },
      { model: 'tomb_sarcophagus', dx: -0.2, dz:  0 },
      { model: 'tomb_sarcophagus', dx: -0.2, dz:  2.5 },
      { model: 'tomb_sarcophagus', dx: -0.2, dz:  5 },
      { model: 'tomb_doorway',     dx:  0,   dz:  8 },
      { model: 'tomb_statue',      dx:  3.5, dz:  0 },
      { model: 'tomb_statue',      dx: -3.5, dz:  0 }
    ]
  },

  // Su kemeri: lineer hat, pillar-arch-pillar-arch-pillar, yanlarda
  // 1 blok + 1 boru. Uzun eksen (~20 birim).
  aqueduct: {
    radius: 11,
    parts: [
      { model: 'aqueduct_pillar', dx:  0, dz: -9 },
      { model: 'aqueduct_arch',   dx:  0, dz: -4.5 },
      { model: 'aqueduct_pillar', dx:  0, dz:  0 },
      { model: 'aqueduct_arch',   dx:  0, dz:  4.5 },
      { model: 'aqueduct_pillar', dx:  0, dz:  9 },
      { model: 'aqueduct_block',  dx:  3, dz:  0 },
      { model: 'aqueduct_pipe',   dx: -3, dz: -4 }
    ]
  }
};

// Deterministic picker for the 'mixed' archetype (City Ruins biome, or
// any caller that asks for a mix). Same (ix, iz, seed) returns the same
// type on every machine.
export function pickRandomRuinType(seed, ix, iz) {
  const ids = Object.keys(RuinModelsByType);
  let h = Math.imul(ix | 0, 374761393)
        + Math.imul(iz | 0, 668265263)
        + Math.imul((seed | 0) + 71, 1442695041);
  h |= 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  const f = (h >>> 0) / 4294967295;
  return ids[Math.floor(f * ids.length)];
}

// Resolve the ruin type for a battle. Returns an id from RuinTypes.
// 'random' (or an unknown id) picks one deterministically from the seed,
// so multiplayer peers agree.
export function resolveRuinType(ruinType, seed) {
  // 'none' short-circuits: no ruins anywhere, not even the City Ruins
  // biome's own dense patches.
  if (ruinType === 'none') return 'none';
  if (typeof ruinType === 'string' && RuinModelsByType[ruinType]) {
    return ruinType;
  }
  const ids = Object.keys(RuinModelsByType);
  // Simple deterministic hash of the seed -> index. Bit-slices of a
  // lowbias-style mix avoid clustering on small seeds.
  let h = (seed | 0) ^ 0x9E3779B9;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = (h ^ (h >>> 16)) >>> 0;
  return ids[h % ids.length];
}
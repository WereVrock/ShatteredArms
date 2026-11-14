// ===== src/config/BiomeTreeMix.js =====
// Per-biome tree TYPE distribution. DATA ONLY.
//
// Before this: every biome had exactly ONE tree shape, chosen by
// BiomeVisuals[biome].treeStyle ('standard' | 'dead'). Woodland had
// 100% standard, steppes 100% dead, and so on. A real landscape has
// multiple tree silhouettes mixed together — this module introduces
// that without touching total tree count (which is still controlled
// by BiomeConfig.trees.on* density rules).
//
// FOUR VARIANTS exist:
//   standard  — the pre-existing icosahedron-crown tree (unchanged)
//   pine      — the campaign screen's stacked-cone pine (CampScenery.pine)
//   round     — the campaign screen's lobed roundTree (CampScenery.roundTree)
//   dead      — the campaign screen's RECURSIVE deadTree
//               (CampScenery.deadTree, depth-3 branching). Replaces
//               the battlefield's previous 3-fixed-branch version.
//
// Weights are per-biome probabilities, MUST sum to <= 1.0. The
// remainder falls back to 'standard'. So { standard: 0.5, pine: 0.3 }
// means 30% pine, 20% implicit standard, 50% explicit standard = 50%.
//
// VARIANT PICK USES hash2(cellX, cellZ, seed) — NOT rng(). The tree
// POSITIONS on a given seed are unchanged by this feature; only the
// APPEARANCE of each tree changes. Existing saved seeds still put a
// tree at the same spot; it may now be a pine instead of an
// icosahedron. That is the intended "multiple types" upgrade path.

export const BiomeTreeMix = {
  // Open meadow: mostly broadleaf round, some pine on the slopes.
  grassland: { standard: 0.45, round: 0.40, pine: 0.15 },

  // Closed canopy: broadleaf dominant with a strong pine mix — the
  // silhouette most people picture for a temperate mixed forest.
  woodland:  { standard: 0.30, round: 0.45, pine: 0.25 },

  // Marsh: drowned woodland. Mostly standard + some dead.
  marsh:     { standard: 0.55, dead: 0.45 },

  // Highland: pine dominates, a few dead on the exposed ridges.
  highland:  { standard: 0.20, pine: 0.70, dead: 0.10 },

  // Desert edge: scrubby, dry. Standard + dead + a few rare pines.
  arid:      { standard: 0.45, dead: 0.45, pine: 0.10 },

  // Ruined city: half-dead trees, some survivors.
  ruins:     { standard: 0.30, dead: 0.50, round: 0.20 },

  // Riverbank: lush broadleaf with pine on the higher banks.
  river:     { standard: 0.35, round: 0.45, pine: 0.20 },

  // Steppe: mostly dead, some survivors, occasional pine on lee slopes.
  steppes:   { standard: 0.20, dead: 0.60, pine: 0.20 },

  // Jungle: low canopy-broadleaf ratio at ground level; standard
  // represents the towering emergent, round the understory.
  jungle:    { standard: 0.35, round: 0.55, pine: 0.10 },

  // Wasteland: dead dominates, everything is withered.
  wasteland: { standard: 0.15, dead: 0.70, round: 0.15 },

  // Oasis: small lush pocket in a sand sea. Broadleaf round only.
  oasis:     { standard: 0.40, round: 0.55, pine: 0.05 },

  // Seaside: coastal meadow, mixed broadleaf + pine.
  seaside:   { standard: 0.40, round: 0.40, pine: 0.20 },

  // Volcanic: trees are rare on this biome (density is per-cell, not
  // per-mix), and every tree that does appear is dead — the biome's
  // FOREST_FLOOR patches are scorched ground where a few stand- ing
  // skeletons survive. 100% dead keeps the theme consistent.
  volcanic:  { dead: 1.0 }
};

// Picks a tree variant for a biome given a roll in [0, 1). `roll` comes
// from the placer as hash2(cellX, cellZ, seed+777) — deterministic per
// cell, so tree appearances are stable across reloads AND tree
// positions on existing saved seeds are unchanged.
export function pickTreeVariant(biomeId, roll) {
  const mix = BiomeTreeMix[biomeId];
  if (!mix) return 'standard';
  let acc = 0;
  if (mix.pine)  { acc += mix.pine;  if (roll < acc) return 'pine'; }
  if (mix.round) { acc += mix.round; if (roll < acc) return 'round'; }
  if (mix.dead)  { acc += mix.dead;  if (roll < acc) return 'dead'; }
  return 'standard';
}
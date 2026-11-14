// ===== BiomeTint.js =====
// Per-biome tree colour ranges. DATA ONLY.
//
// Trees are rendered as one InstancedMesh; each instance's colour is
// picked inside the biome's (hue, hueRange, sat, lit, litRange) window
// using a per-tree hash. Woodland trees come out darker than grassland
// trees; steppe trees come out dry and yellowish; jungle trees come out
// deep tropical green. Without this every tree in every biome uses the
// same base colour, which was the "boring" half of the biome sameness
// complaint.
//
// Colour space is HSL. Ranges are applied as `base + hash * range`.

export const BiomeTint = {
  grassland: { tree: { hue: 0.26, hueRange: 0.06, sat: 0.45, lit: 0.22, litRange: 0.09 } },
  // Darker, cooler — a closed-canopy forest.
  woodland:  { tree: { hue: 0.23, hueRange: 0.05, sat: 0.50, lit: 0.16, litRange: 0.07 } },
  // Deep tropical — high saturation, very dark. Reads as thick canopy.
  jungle:    { tree: { hue: 0.30, hueRange: 0.06, sat: 0.62, lit: 0.13, litRange: 0.06 } },
  // Dry yellow-green. Reads as drought-stressed steppe scrub.
  steppes:   { tree: { hue: 0.13, hueRange: 0.04, sat: 0.40, lit: 0.30, litRange: 0.08 } },
  // Muted highland green — thin, cold, wind-beaten.
  highland:  { tree: { hue: 0.24, hueRange: 0.05, sat: 0.35, lit: 0.20, litRange: 0.07 } },
  // Dark, low-saturation. Drowned roots.
  marsh:     { tree: { hue: 0.21, hueRange: 0.05, sat: 0.35, lit: 0.15, litRange: 0.06 } },
  // Same dry yellow as steppes — a desert tree looks like a dry scrub.
  arid:      { tree: { hue: 0.13, hueRange: 0.04, sat: 0.35, lit: 0.32, litRange: 0.08 } },
  // Dull, dusty — a dead city has dead trees.
  ruins:     { tree: { hue: 0.22, hueRange: 0.05, sat: 0.30, lit: 0.18, litRange: 0.07 } },
  // Riverbank green, a touch fresher than grassland.
  river:     { tree: { hue: 0.26, hueRange: 0.06, sat: 0.48, lit: 0.21, litRange: 0.08 } },
  // Brownish-grey — dead or nearly-dead.
  wasteland: { tree: { hue: 0.18, hueRange: 0.05, sat: 0.25, lit: 0.22, litRange: 0.07 } },
  // Vivid tropical green — the only lush tree in a sand sea.
  oasis:     { tree: { hue: 0.30, hueRange: 0.06, sat: 0.55, lit: 0.24, litRange: 0.08 } },
  // Charred black-brown. The few trees volcanic allows are dead and
  // scorched — a dark warm hue with very low saturation matches the
  // ash terrain they stand on.
  volcanic:  { tree: { hue: 0.08, hueRange: 0.03, sat: 0.25, lit: 0.14, litRange: 0.05 } }
};

// Fallback when the biome grid lookup misses (old saved terrain, or a
// cell outside the generated region). Matches the pre-tint default.
export const DEFAULT_TREE_TINT = {
  hue: 0.26, hueRange: 0.06, sat: 0.45, lit: 0.22, litRange: 0.09
};
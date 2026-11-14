// ===== src/render/BiomeSceneryBuilder.js =====
// Maps each BiomeSceneryModels id to its CampPropKit / CampPropKitDark
// build closure. Two maps stay in sync by modelId — BiomeSceneryConfig.js
// owns collision + height, this file owns how to construct the mesh.
//
// STATIC ONLY. Props like crypt, stoneTower, watchtower, table, lampPost
// internally emit glow sprites via `glowSprite()`; those go into the
// CampContext's animated group (`ctx.group`), NOT the merged static
// geometry (`ctx.merged`). buildSceneryGeometry returns ONLY the merged
// mesh — animated sprites are silently dropped. That is exactly what we
// want for battlefield scenery: crypt shell yes, green glow no.
//
// The merged geometry is built ONCE per modelId and cached by the caller
// (TerrainObstacleView._sceneryGeometry). Every placed instance of that
// model shares the geometry — one InstancedMesh per modelId.

import * as Kit from './camp/CampPropKit.js';
import * as Dark from './camp/CampPropKitDark.js';
import * as Volcanic from './camp/VolcanicProps.js';

const BUILDERS = {
  // --- Human camp ---
  human_tent:         (L) => Kit.bellTent(L),
  human_pavilion:     (L) => Kit.pavilion(L),
  human_wagon:        (L) => Kit.wagon(L),
  human_crate:        (L) => Kit.crate(L),
  human_barrel:       (L) => Kit.barrel(L),
  human_hayBale:      (L) => Kit.hayBale(L),
  human_weaponRack:   (L) => Kit.weaponRack(L),
  human_horse:        (L) => Kit.horse(L),
  human_fence:        (L) => Kit.fence(L, { len: 3 }),
  human_palisade:     (L) => Kit.palisade(L, { len: 6 }),
  human_watchtower:   (L) => Kit.watchtower(L),
  human_dummy:        (L) => Kit.dummy(L),

  // --- Goblin / tribal ---
  goblin_hideTent:    (L) => Dark.hideTent(L),
  goblin_bonePile:    (L) => Dark.bonePile(L),
  goblin_cage:        (L) => Dark.cage(L),
  goblin_meatRack:    (L) => Dark.meatRack(L),
  goblin_warDrum:     (L) => Dark.warDrum(L),
  goblin_spikedFence: (L) => Dark.spikedFence(L, { len: 6 }),

  // --- Hobgoblin / military ---
  hobgoblin_warTent:    (L) => Dark.warTent(L),
  hobgoblin_siegeRam:   (L) => Dark.siegeRam(L),
  hobgoblin_stoneTower: (L) => Dark.stoneTower(L),

  // --- Undead / graveyard ---
  undead_gravestone: (L) => Dark.gravestone(L),
  undead_deadTree:   (L) => Dark.deadTree(L),
  undead_boneArch:   (L) => Dark.boneArch(L, { w: 5, h: 3.6 }),
  undead_ironFence:  (L) => Dark.ironFence(L, { len: 6 }),
  undead_openGrave:  (L) => Dark.openGrave(L),
  undead_coffin:     (L) => Dark.coffin(L),
  undead_crypt:      (L) => Dark.crypt(L),

  // --- Volcanic ---
  volcanic_basalt:   (L) => Volcanic.basaltColumns(L)
};

// Builds the merged static geometry for a modelId at world origin. Returns
// { geometry, material } — a plain THREE.Mesh's .geometry and .material,
// ready for InstancedMesh. Returns null for unknown modelId.
//
// The CampContext RNG is seeded to 0 so geometry is byte-identical on
// every call — a hideTent's random tent-colour palette is fixed once per
// session per modelId. Per-instance variety comes from the InstancedMesh
// Y-rotation and shade tint, not from a re-rolled build.
export function buildSceneryGeometry(modelId) {
  const build = BUILDERS[modelId];
  if (!build) return null;

  const ctx = new Kit.CampContext(0);
  const L = ctx.local(0, 0, 0, 1);
  build(L);

  const mesh = ctx.merged.build();
  return { geometry: mesh.geometry, material: mesh.material };
}
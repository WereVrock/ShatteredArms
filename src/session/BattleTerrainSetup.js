import { buildBattleTerrain } from '../sim/BattleTerrainBuilder.js';
import { TerrainPlacement } from '../sim/TerrainPlacement.js';
import { TerrainView } from '../render/TerrainView.js';
import { ActiveTerrain } from './ActiveTerrain.js';

// Builds the terrain for a battle and hooks it into the sim and the scene.
// preset 'none' leaves the battle on flat, uniform ground.
// biome: 'auto' (a mosaic chosen by the seed) or a biome id from BiomeConfig.
// `zones` is accepted for compatibility and ignored: deployment zones are no
// longer cleared. Units standing on blocked ground are settled afterwards.
// Returns { terrain, view } (both null for 'none').
export function setupBattleTerrain({
  simulation, sceneSetup, units, seed, preset,
  biome = 'auto', ruinType = 'random'
}) {
  if (preset === 'none') {
    simulation.setTerrain(null);
    ActiveTerrain.clear();
    return { terrain: null, view: null };
  }

  const _t0 = performance.now();
  const terrain = buildBattleTerrain({ units, seed, preset, biome, ruinType });
  const _t1 = performance.now();
  TerrainPlacement.settleUnits(units, terrain);
  const _t2 = performance.now();
  // Also hands the terrain to every unit so deployment drags settle too.
  simulation.setTerrain(terrain);
  ActiveTerrain.set(terrain);

  const view = new TerrainView(sceneSetup, terrain);
  const _t3 = performance.now();
  // Routes through SceneSetup so the field-boundary strips also get their
  // Y values refreshed. Previously only the grass was lifted, so the
  // boundary stayed at its flat 0.06 baseline while hills rose around it.
  sceneSetup.applyTerrain(terrain);
  const _t4 = performance.now();
  // Re-derives the camera height from the new ground.
  sceneSetup.panCamera(0, 0);
  const _t5 = performance.now();

  console.log(
    `%c[terrain.setup] ` +
    `build=${(_t1 - _t0).toFixed(0)}ms ` +
    `settle=${(_t2 - _t1).toFixed(0)}ms ` +
    `view=${(_t3 - _t2).toFixed(0)}ms ` +
    `apply=${(_t4 - _t3).toFixed(0)}ms ` +
    `pan=${(_t5 - _t4).toFixed(0)}ms ` +
    `total=${(_t5 - _t0).toFixed(0)}ms`,
    'color:#8c8;font-weight:bold'
  );

  scheduleProgressiveUpgrade(view, terrain);

  return { terrain, view };
}

// Progressive quality upgrade. The initial battle-load path uses the
// fast TEX_SCALE (2) overlay texture and a 2x2-block noise sampling
// path, which together dominate battle-load time at the 5x buffer
// extent. As soon as the browser has spare cycles (idle callback, or a
// fallback timeout), the overlay is re-built at the authored
// TARGET_TEX_SCALE (3) and swapped in, and the nav grid is warmed so
// the first move order does not hitch. Chunk geometry and shader are
// untouched — only the sampler uniform is reassigned, so the upgrade
// costs nothing per-frame.
//
// The first-frame check on view.surface._overlayUniform handles the
// case where requestIdleCallback fires before the shader has compiled:
// we retry a moment later instead of silently skipping the upgrade.
//
// Every step is guarded: a failure logs and is ignored so a bug here
// can never block a battle.
function scheduleProgressiveUpgrade(view, terrain) {
  if (!view || !view.surface) return;

  const tryUpgrade = () => {
    // Wait until the shader has compiled (i.e. the first render
    // shipped). Retries until ready, then upgrades once.
    if (!view.surface._overlayUniform) {
      setTimeout(tryUpgrade, 500);
      return;
    }
    try {
      view.surface.upgradeOverlayTexture(3);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[terrain] overlay upgrade failed:', e);
    }
    try {
      if (terrain && typeof terrain.warmNav === 'function') {
        terrain.warmNav();
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[terrain] nav warm failed:', e);
    }
  };

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(tryUpgrade, { timeout: 5000 });
  } else {
    setTimeout(tryUpgrade, 1500);
  }
}
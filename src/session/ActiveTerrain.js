// ===== src/session/ActiveTerrain.js =====
// Battle-scoped terrain handle for view and input code that only needs
// heights (renderer, camera, mouse picking). The sim receives its terrain by
// injection (BattleSimulation.setTerrain) and never reads this, so headless
// runs cannot clobber what the screen is showing.
let current = null;

export const ActiveTerrain = {
  set(terrain) { current = terrain || null; },
  get() { return current; },
  // Debug convenience: mirrors get() under a field name so console
  // inspection (`ActiveTerrain.terrain`) works without calling a method.
  // Has no effect on the game itself.
  get terrain() { return current; },
  clear() { current = null; },
  // 0 when there is no terrain or it is flat.
  heightAt(x, z) {
    return current && current.hasElevation ? current.heightAt(x, z) : 0;
  }
};

// TEMPORARY DEBUG EXPOSURE. Attaches the module to window so the browser
// console can inspect it during development. Safe to leave in a dev build;
// remove this block before shipping if you care about not polluting the
// global namespace.
if (typeof window !== 'undefined') {
  window.ActiveTerrain = ActiveTerrain;
}
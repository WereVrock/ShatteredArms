// Tracks the standalone scenario currently being played, so Restart can
// re-launch the same scenario after a page reload. Campaign battles do not
// use this — they are tracked by CampaignState.phase === 'battle'.
//
// sessionStorage scoped: cleared when the tab closes, survives a reload
// within the same tab. Cleared by the Menu button (which abandons the
// current battle entirely).

const STORAGE_KEY = 'battle-prototype-active-scenario-v1';

export const ActiveScenario = {
  set(scenarioId) {
    try { sessionStorage.setItem(STORAGE_KEY, scenarioId); } catch (e) {}
  },

  get() {
    try { return sessionStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  },

  clear() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
};
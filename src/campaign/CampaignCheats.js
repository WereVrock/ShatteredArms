// ===== CampaignCheats.js =====
// Development-only keyboard cheats for the campaign. Inert unless the
// player has flipped "Enable test features" on in the main-menu Settings
// dialog — see SettingsStore.enableTestFeatures and areChampionsEnabled.
//
// A cheat mutates the LIVE campaign state object currently owned by the
// on-screen picker. The caller (CampaignFlow) supplies:
//   - getState():  the live state, or null when no picker is displayed
//                  (e.g. during a battle). Returning null suppresses
//                  every cheat, which is what makes _beginBattle's
//                  context clear an effective kill switch.
//   - onChange():  invoked after a successful mutation so the caller can
//                  persist and re-render. Kept as a callback so this
//                  module never reaches into CampaignState or a picker
//                  view directly.
//
// No UI. No DOM beyond the keydown listener. No knowledge of which
// picker is visible — the caller decides what "active" means.

import { SettingsStore } from '../ui/settings/SettingsStore.js';

// Cheat: grant skill points to the active champion.
// Key: 'p'. Grant size: 1 per press. Hold the key to stack.
const SKILL_POINTS_KEY = 'p';
const SKILL_POINTS_PER_PRESS = 1;

// Returns an uninstall function that removes the keydown listener. Safe
// to call more than once; each call removes exactly one listener.
export function installCampaignCheats({ getState, onChange }) {
  const handler = (e) => {
    if (!SettingsStore.get().enableTestFeatures) return;

    // Do not fire on modifier combos — a real browser shortcut (Ctrl+P,
    // Cmd+P) must pass through untouched.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (typeof e.key !== 'string') return;
    if (e.key.toLowerCase() !== SKILL_POINTS_KEY) return;

    // Ignore keystrokes aimed at a form control so typing in a text
    // field never triggers a grant.
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    const state = getState();
    if (!state || !state.champion) return;

    state.champion.unspentPoints += SKILL_POINTS_PER_PRESS;
    console.log(
      `[cheat] +${SKILL_POINTS_PER_PRESS} skill point `
      + `(now ${state.champion.unspentPoints} unspent)`
    );
    if (onChange) onChange();
  };

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
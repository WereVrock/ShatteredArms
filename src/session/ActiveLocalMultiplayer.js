// ===== ActiveLocalMultiplayer.js =====
// Persistence slot for an in-progress same-device (local) multiplayer
// battle, so a hard refresh re-enters the battle instead of dropping to
// the main menu.
//
// Stores just enough to rebuild the battle from scratch: the force source
// (either a PlayableScenarios id, or a custom-battle roster pair) plus
// the local-MP config (mode, interval). The battle itself restarts FRESH
// on resume — same opening positions, same coin toss — matching the
// single-player Restart semantics. Mid-battle state (turn index, timer,
// soldier casualties, coin-toss outcome) is deliberately NOT preserved;
// preserving it would require re-entering LocalMultiplayerController's
// state machine mid-phase, which is a much larger change with its own
// bug surface. If that becomes wanted later, it belongs here as extra
// fields plus a resume-aware branch in the controller.
//
// sessionStorage scoped: survives a same-tab reload, cleared when the
// tab closes, never bleeds between tabs. Cleared by the shared
// returnToMainMenu() exit path, same as ActiveScenario and
// ActiveCustomBattle.

const STORAGE_KEY = 'battle-prototype-active-local-mp-v1';

// Shape check on load. Rejects a payload that has no resolvable force
// source (neither a scenarioId string nor a well-formed customRosters
// object) so a partially-written slot cannot put boot into a state where
// the local launcher has nothing to build from.
function parsePayload(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.mode !== 'string') return null;

    const hasScenario = typeof parsed.scenarioId === 'string'
      && parsed.scenarioId.length > 0;
    const hasCustom = parsed.customRosters
      && Array.isArray(parsed.customRosters.blueRoster)
      && Array.isArray(parsed.customRosters.redRoster);
    if (!hasScenario && !hasCustom) return null;

    return parsed;
  } catch (e) {
    return null;
  }
}

export const ActiveLocalMultiplayer = {
  set(config) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) { /* private mode / quota — silently degrade to no-resume */ }
  },

  load() {
    try {
      return parsePayload(sessionStorage.getItem(STORAGE_KEY));
    } catch (e) {
      return null;
    }
  },

  clear() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
};
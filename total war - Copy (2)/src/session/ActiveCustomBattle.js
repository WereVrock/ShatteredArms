// ===== ActiveCustomBattle.js =====
// Two related persistence slots for custom battles:
//
//   ACTIVE   — the custom battle currently being fought. Set when a
//              custom battle is launched from the setup screen; read at
//              boot so Restart resumes the same battle; cleared by Exit
//              to Main Menu. sessionStorage scoped (per-tab, per-session).
//
//   LAST SETUP — the rosters the player last configured, regardless of
//              whether they're currently fighting. Used to pre-populate
//              the Custom Battle setup screen so the player can quickly
//              re-launch (or tweak) their previous configuration. NOT
//              cleared by Exit to Main Menu. localStorage scoped so it
//              survives tab close — the setup is a player-authored
//              artifact, not session state.
//
// Both slots store the same shape:
//   { blueRoster: [...], redRoster: [...] }
// with roster entries matching RosterLayout / CampaignBattleBuilder:
//   { id, typeId, aliveCount, maxCount, isUndead }
//
// The two are deliberately separate. Clearing the active slot on Exit is
// what makes the exit-to-menu flow work; clearing the last-setup slot on
// Exit would discard the player's configuration just because they left a
// battle — which is exactly what this module exists to prevent.

const ACTIVE_KEY = 'battle-prototype-active-custom-battle-v1';
const LAST_SETUP_KEY = 'battle-prototype-last-custom-setup-v1';

// Shared load/validate logic. Both slots use the same shape and the same
// corruption guard: both rosters must be arrays, or the whole payload is
// treated as absent (matching CampaignState.load's behaviour).
function parsePayload(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed
        || !Array.isArray(parsed.blueRoster)
        || !Array.isArray(parsed.redRoster)) {
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

function writeJson(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

function readJson(storage, key) {
  try { return parsePayload(storage.getItem(key)); } catch (e) { return null; }
}

export const ActiveCustomBattle = {
  // --- currently active battle (Restart / resume) -------------------------

  set(blueRoster, redRoster) {
    writeJson(sessionStorage, ACTIVE_KEY, { blueRoster, redRoster });
  },

  load() {
    return readJson(sessionStorage, ACTIVE_KEY);
  },

  clear() {
    try { sessionStorage.removeItem(ACTIVE_KEY); } catch (e) {}
  },

  // --- last configured setup (pre-populate the setup screen) --------------

  setLastSetup(blueRoster, redRoster) {
    writeJson(localStorage, LAST_SETUP_KEY, { blueRoster, redRoster });
  },

  getLastSetup() {
    return readJson(localStorage, LAST_SETUP_KEY);
  },

  clearLastSetup() {
    try { localStorage.removeItem(LAST_SETUP_KEY); } catch (e) {}
  }
};
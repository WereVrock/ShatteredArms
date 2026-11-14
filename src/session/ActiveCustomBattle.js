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
//   {
//     blueRoster:      [...],
//     redRoster:       [...],
//     playerTeamId:    'blue' | 'red' | null,
//     aiTierByTeamId:  { blue: <tierId>, red: <tierId> } | undefined,
//     biome:           'auto' | <biomeId> | undefined
//   }
// with roster entries matching RosterLayout / CampaignBattleBuilder:
//   { id, typeId, aliveCount, maxCount, isUndead }
//
// Field history:
//   playerTeamId    — added so a Restart-button reload of a custom battle
//                     resumes with the same side selection.
//   aiTierByTeamId  — per-team AI difficulty, added with the multi-tier
//                     Custom Battle feature. Optional.
//   biome           — terrain biome override. 'auto' (or absent) keeps
//                     the generator's hybrid mosaic; any other id forces
//                     that biome on the whole map. Optional so older
//                     saves continue to work.

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

// Builds the persisted payload from the loose arguments. Centralised so
// set() and setLastSetup() cannot drift on which fields they carry.
function makePayload(blueRoster, redRoster, playerTeamId, aiTierByTeamId, biome, ruinType) {
  const payload = { blueRoster, redRoster };
  // Preserve the explicit null case (spectator / both-AI battle) —
  // only omit the field when the caller did not supply it at all.
  if (playerTeamId !== undefined) payload.playerTeamId = playerTeamId;
  // Shallow-copy so a caller mutating its own tier map afterwards cannot
  // retroactively change what was written.
  if (aiTierByTeamId && typeof aiTierByTeamId === 'object') {
    payload.aiTierByTeamId = {
      blue: aiTierByTeamId.blue,
      red:  aiTierByTeamId.red
    };
  }
  // Terrain biome: only when the caller supplies one. Absence means 'auto'
  // to the reader (same effect as the string but preserves older saves
  // byte-for-byte).
  if (typeof biome === 'string' && biome.length > 0) {
    payload.biome = biome;
  }
  // Ruin archetype. Only meaningful when biome === 'ruins'; still stored
  // for every save so a switch back to 'ruins' keeps the last choice.
  if (typeof ruinType === 'string' && ruinType.length > 0) {
    payload.ruinType = ruinType;
  }
  return payload;
}

export const ActiveCustomBattle = {
  // --- currently active battle (Restart / resume) -------------------------

  set(blueRoster, redRoster, playerTeamId, aiTierByTeamId, biome, ruinType) {
    writeJson(
      sessionStorage,
      ACTIVE_KEY,
      makePayload(blueRoster, redRoster, playerTeamId, aiTierByTeamId, biome, ruinType)
    );
  },

  load() {
    return readJson(sessionStorage, ACTIVE_KEY);
  },

  clear() {
    try { sessionStorage.removeItem(ACTIVE_KEY); } catch (e) {}
  },

  // --- last configured setup (pre-populate the setup screen) --------------

  setLastSetup(blueRoster, redRoster, playerTeamId, aiTierByTeamId, biome, ruinType) {
    writeJson(
      localStorage,
      LAST_SETUP_KEY,
      makePayload(blueRoster, redRoster, playerTeamId, aiTierByTeamId, biome, ruinType)
    );
  },

  getLastSetup() {
    return readJson(localStorage, LAST_SETUP_KEY);
  },

  clearLastSetup() {
    try { localStorage.removeItem(LAST_SETUP_KEY); } catch (e) {}
  }
};
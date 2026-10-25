// ===== ActiveScenario.js =====
// ===== ActiveScenario.js =====
// Tracks the standalone scenario currently being played, so a Restart
// button reload can resume the same battle. Campaign battles do not
// use this — they are tracked by CampaignState.phase === 'battle'.
//
// sessionStorage scoped: cleared when the tab closes, survives a reload
// within the same tab. Cleared by Exit-to-Main-Menu (which abandons the
// battle entirely) and by the Ctrl+R → ScenarioMenu routing path.
//
// --- Schema evolution -----------------------------------------------------
//
//   v1 — bare string: the scenario id.
//
//   v2 — JSON payload { id, overrides? }, where `overrides` carries the
//        ScenarioMenu "Custom player setup" customization (playerTeamId,
//        aiTeamIds, aiTierByTeamId) that produced a resolved scenario
//        copy. Written only when the launch came from the ticked path.
//
// The overrides field serves two purposes:
//
//   1. It is the persistence-format signal that the last launch was a
//      customized scenario, which is what boot checks to decide whether
//      a Ctrl+R reload should route back to the ScenarioMenu (see
//      main.js's boot block) instead of auto-resuming.
//
//   2. It carries the customization so a Restart-button reload can
//      rebuild the exact same battle — the Restart button semantics
//      ("resume the same fight") still apply to a customized launch.
//
// get() still returns a bare string id so every existing caller keeps
// working. A v1 payload left behind by a pre-v2 session is read
// transparently and upgraded in place on the next write.

const STORAGE_KEY = 'battle-prototype-active-scenario-v2';
const LEGACY_KEY  = 'battle-prototype-active-scenario-v1';

function writePayload(payload) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (e) {}
  // Any write supersedes whatever a pre-v2 session left behind.
  try { sessionStorage.removeItem(LEGACY_KEY); } catch (e) {}
}

function readPayload() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.id === 'string' && parsed.id.length > 0) {
        return parsed;
      }
      return null;
    }
  } catch (e) {
    return null;
  }
  try {
    const legacy = sessionStorage.getItem(LEGACY_KEY);
    if (legacy && typeof legacy === 'string' && legacy.length > 0) {
      return { id: legacy };
    }
  } catch (e) { /* sessionStorage may throw in private mode */ }
  return null;
}

export const ActiveScenario = {
  // Plain scenario launch — no customization to carry. Boot will resume
  // the scenario directly on both Ctrl+R and Restart, matching the
  // pre-customization behavior.
  set(scenarioId) {
    writePayload({ id: scenarioId });
  },

  // Customized scenario launch (ScenarioMenu "Custom player setup"
  // ticked). Records the resolved override so:
  //   - Ctrl+R can route back to the ScenarioMenu (overrides present),
  //   - Restart can resume the exact customized battle.
  //
  // overrides shape: { playerTeamId, aiTeamIds, aiTierByTeamId }. Each
  // field is copied defensively; undefined fields are omitted.
  setCustomized(scenarioId, overrides) {
    if (!overrides || typeof overrides !== 'object') {
      this.set(scenarioId);
      return;
    }
    const payload = { id: scenarioId, overrides: {} };
    if (overrides.playerTeamId !== undefined) {
      payload.overrides.playerTeamId = overrides.playerTeamId;
    }
    if (Array.isArray(overrides.aiTeamIds)) {
      payload.overrides.aiTeamIds = overrides.aiTeamIds.slice();
    }
    if (overrides.aiTierByTeamId && typeof overrides.aiTierByTeamId === 'object') {
      payload.overrides.aiTierByTeamId = { ...overrides.aiTierByTeamId };
    }
    writePayload(payload);
  },

  // The scenario id, or null. Always a bare string when present.
  get() {
    const payload = readPayload();
    return payload ? payload.id : null;
  },

  // The persisted customization, or null. Boot uses null-ness as the
  // "was the last launch customized?" test — see main.js boot block.
  getOverrides() {
    const payload = readPayload();
    if (!payload || !payload.overrides) return null;
    return payload.overrides;
  },

  clear() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
    try { sessionStorage.removeItem(LEGACY_KEY); } catch (e) {}
  }
};
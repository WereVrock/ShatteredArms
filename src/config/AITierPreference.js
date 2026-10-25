// ===== AITierPreference.js =====
// Persistent preference for the AI difficulty tier used when a battle
// starts without an explicit tier override. Read by BattleAI when no
// opts.tierName is supplied; written by the AITierPicker widget embedded
// on the scenario and custom-battle setup screens.
//
// Kept in config/ rather than ui/ because BattleAI (an AI-layer module)
// reads it directly — pulling a value from a UI-layer module into the
// AI would invert the intended dependency direction. The store itself
// holds no DOM knowledge; the picker widget is what knows about UI.
//
// Persisted in localStorage under a dedicated key rather than through
// SettingsStore. SettingsStore holds global UI toggles (FPS, power
// scale, rush mode) that appear in the settings panel; AI difficulty is
// a per-battle choice made at setup time, and cluttering the settings
// panel with it would force a mental jump between "options" and "match
// setup". A stale or unrecognised stored value falls back to
// DEFAULT_AI_TIER so an older save from a build with different tier
// names cannot leave the game with no tier at all.

import { AITierConfig, DEFAULT_AI_TIER } from './AITierConfig.js';

const STORAGE_KEY = 'aiTierPreference';

function loadFromStorage() {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_AI_TIER;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && AITierConfig[raw]) return raw;
  } catch {
    // localStorage can throw on access in strict private-browsing modes.
    // Falling back to the default is always correct — the preference is
    // a nicety, not a correctness requirement.
  }
  return DEFAULT_AI_TIER;
}

let _value = loadFromStorage();
const _listeners = new Set();

export const AITierPreference = {
  get() {
    return _value;
  },

  // Setting to an unrecognised name falls back to DEFAULT_AI_TIER rather
  // than storing garbage. Notifies subscribers only when the value
  // actually changes, so a redundant set does not spark a re-render.
  set(name) {
    const next = AITierConfig[name] ? name : DEFAULT_AI_TIER;
    if (next === _value) return;
    _value = next;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, _value);
      }
    } catch {
      // Write failures are non-fatal: the in-memory value is updated and
      // the picker shows the new selection for the rest of the session.
      // Only the cross-reload persistence is lost.
    }
    for (const fn of _listeners) {
      try { fn(_value); } catch { /* subscriber errors must not break others */ }
    }
  },

  // Subscribe to changes. Returns an unsubscribe closure. Listener errors
  // are swallowed so one misbehaving subscriber cannot prevent the rest
  // from being notified.
  subscribe(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }
};
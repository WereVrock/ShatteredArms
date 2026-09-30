// ===== SettingsStore.js =====
// Persistent user settings, backed by localStorage. One shared key holds
// the whole settings object, so adding a new field is a one-line change to
// DEFAULTS and existing saves pick up the new default automatically.
//
// Subscribers are notified whenever a value changes via set(). They are NOT
// notified on initial load — callers who need the current value should call
// SettingsStore.get() explicitly at startup. This keeps the load path
// side-effect-free (loading a page shouldn't fire every subscriber).
//
// All storage access is wrapped in try/catch: localStorage can throw in
// private-browsing mode, on quota-exceeded writes, or when disabled by
// policy. In any of those cases the store degrades to in-memory-only —
// settings still apply for the session, they just don't persist.
const STORAGE_KEY = 'battle.settings.v1';

const DEFAULTS = Object.freeze({
  shadows: true,
  groundTexture: true,
  grass: true,
  fieldEdge: true,
  fog: true,
  // When true, a right-click double-click commits its move order with
  // directMarch — soldiers walk straight to their new formation slots
  // instead of the block assembling en route. Read by
  // OrderDragController at each right-mousedown.
  doubleClickDirectMarch: true
});

export class SettingsStore {
  static _current = null;
  static _listeners = new Set();

  // Returns the live settings object. The object is shared, not copied —
  // callers should treat it as read-only and mutate via set() so subscribers
  // fire. On first call, loads from localStorage and merges over DEFAULTS.
  static get() {
    if (!this._current) {
      this._current = this._load();
    }
    return this._current;
  }

  // Sets a single key. No-op if the value is unchanged, so subscribers don't
  // fire on redundant sets (a checkbox syncing from state, for example).
  static set(key, value) {
    const s = this.get();
    if (s[key] === value) return;
    s[key] = value;
    this._persist(s);
    for (const fn of this._listeners) {
      try { fn(s, key, value); } catch (e) { /* subscriber errors must not break others */ }
    }
  }

  // Registers a change listener. Returns an unsubscribe function.
  static subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // Clears persisted settings and resets in-memory state to DEFAULTS,
  // notifying subscribers. Useful for a "reset to defaults" button later.
  static reset() {
    this._current = { ...DEFAULTS };
    this._persist(this._current);
    for (const fn of this._listeners) {
      try { fn(this._current, null, null); } catch (e) { /* see set() */ }
    }
  }

  static _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
      // Spread order: DEFAULTS first, saved values over. Any key added to
      // DEFAULTS after a save was written is filled in with its default,
      // and any key removed from DEFAULTS but still present in an old save
      // is simply carried along unused.
      return { ...DEFAULTS, ...parsed };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  static _persist(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      // See file header — silent no-op, in-memory values still apply.
    }
  }
}
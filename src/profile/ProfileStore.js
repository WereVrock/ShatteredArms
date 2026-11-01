// Local profile store. Profiles are single-player identity only — a
// name on this machine, no password, no online account. Campaign saves
// and high-score submissions hang off the active profile.
//
// Storage layout (localStorage):
//   sa.profiles.v1 = {
//     activeId: string | null,
//     profiles: [{ id, name, createdAt }]
//   }
//
// Campaign state itself lives in CampaignState under a key that embeds
// the profile id (see CampaignState.js). This module never touches
// campaign data.

const STORAGE_KEY = 'sa.profiles.v1';
const MAX_NAME_LEN = 24;
const MAX_PROFILES = 12;

function blank() {
  return { activeId: null, profiles: [] };
}

function loadRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return blank();
    if (!Array.isArray(parsed.profiles)) return blank();
    return {
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      profiles: parsed.profiles.filter(
        p => p && typeof p.id === 'string' && typeof p.name === 'string'
      )
    };
  } catch (e) {
    return blank();
  }
}

function saveRaw(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // private mode / quota — profiles still work for the session via
    // the in-memory cache below, but will not survive a reload.
  }
}

// In-memory mirror so repeated reads do not re-parse. Mutators always
// write through to localStorage.
let _cache = loadRaw();

function persist() {
  saveRaw(_cache);
}

function sanitiseName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

function newId() {
  return 'p-' + Math.random().toString(36).slice(2, 10)
    + Date.now().toString(36).slice(-4);
}

export const ProfileStore = {
  list() {
    return _cache.profiles.slice();
  },

  getActive() {
    if (!_cache.activeId) return null;
    return _cache.profiles.find(p => p.id === _cache.activeId) || null;
  },

  getActiveId() {
    return _cache.activeId;
  },

  isLoggedIn() {
    return !!this.getActive();
  },

  // Create and optionally activate. Returns the new profile, or null if
  // the name is empty / at the profile cap / duplicate name (case-
  // insensitive).
  create(name, { activate = true } = {}) {
    const cleaned = sanitiseName(name);
    if (!cleaned) return null;
    if (_cache.profiles.length >= MAX_PROFILES) return null;
    const lower = cleaned.toLowerCase();
    if (_cache.profiles.some(p => p.name.toLowerCase() === lower)) return null;

    const profile = {
      id: newId(),
      name: cleaned,
      createdAt: Date.now()
    };
    _cache.profiles.push(profile);
    if (activate) _cache.activeId = profile.id;
    persist();
    return profile;
  },

  select(id) {
    if (!_cache.profiles.some(p => p.id === id)) return false;
    _cache.activeId = id;
    persist();
    return true;
  },

  // Clear the active selection without deleting the profile. Used by
  // "Leave profile" / logout.
  clearActive() {
    _cache.activeId = null;
    persist();
  },

  // Remove a profile. If it was active, activeId becomes null. Caller
  // is responsible for wiping the profile's campaign save (see
  // CampaignState.clearForProfile).
  remove(id) {
    const before = _cache.profiles.length;
    _cache.profiles = _cache.profiles.filter(p => p.id !== id);
    if (_cache.activeId === id) _cache.activeId = null;
    if (_cache.profiles.length !== before) persist();
    return _cache.profiles.length !== before;
  },

  // Reload from storage (e.g. after another tab mutated). Rarely needed.
  reload() {
    _cache = loadRaw();
  }
};
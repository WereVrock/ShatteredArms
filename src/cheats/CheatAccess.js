// ===== CheatAccess.js =====
// Single gate for debug cheats. Cheats are available only to the local
// profile named "wv" (case-insensitive). Evaluated on demand, so switching
// profiles takes effect the next time the check runs.

import { ProfileStore } from '../profile/ProfileStore.js';

export const CHEAT_PROFILE_NAME = 'wv';

export function isCheatUser() {
  const profile = ProfileStore.getActive();
  const name = profile && typeof profile.name === 'string'
    ? profile.name.trim().toLowerCase()
    : '';
  return name === CHEAT_PROFILE_NAME;
}
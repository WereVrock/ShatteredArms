// ===== CampaignSession.js =====
// Tracks whether the player deliberately exited the campaign to the
// menu (vs. being mid-battle). When this flag is set, boot shows the
// main menu instead of auto-resuming the campaign. It is set by
// Save & Exit paths and cleared whenever the player actually re-enters
// the campaign (Continue -> resume, or any battle start).
//
// Backed by localStorage, not sessionStorage: the campaign save itself
// survives tab close, and the "player paused at menu" state must
// survive with it. Otherwise closing the tab after Save & Exit would
// drop the player straight into the battle on reopen — the exact
// surprise the flag exists to prevent.
//
// This is a utility, not a UI class. It has no DOM and no logic beyond
// reading / writing the flag.

const KEY = 'sa.campaignPaused';

export const CampaignSession = {
  isPaused() {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch (e) {
      return false;
    }
  },

  setPaused() {
    try {
      localStorage.setItem(KEY, '1');
    } catch (e) { /* private mode — degrades to in-page behavior */ }
  },

  clearPaused() {
    try {
      localStorage.removeItem(KEY);
    } catch (e) { /* private mode */ }
  }
};
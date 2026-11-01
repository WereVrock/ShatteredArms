// Client for the global high-score board hosted on the Cloudflare worker.
// Failures are silent from the player's point of view — a missing board
// must never block campaign flow.
//
// Endpoints (see _worker.js):
//   GET  /api/highscores?balanceVersion=N&limit=10
//   POST /api/highscores   body: score payload JSON

import { VERSION } from '../config/Version.js';

const ENDPOINTS = {
  list: '/api/highscores',
  submit: '/api/highscores'
};

function balanceVersion() {
  return typeof VERSION.balanceVersion === 'number' ? VERSION.balanceVersion : 1;
}

function gameVersionName() {
  const name = (VERSION.name || '').trim();
  const num = VERSION.number || '';
  return name ? `${name} v${num}` : `v${num}`;
}

export const HighscoreApi = {
  balanceVersion,
  gameVersionName,

  async fetchTop({ limit = 10, balanceVersion: bv } = {}) {
    const ver = bv != null ? bv : balanceVersion();
    const url = `${ENDPOINTS.list}?balanceVersion=${encodeURIComponent(ver)}&limit=${limit}`;
    try {
      const res = await fetch(url, { method: 'GET', credentials: 'omit' });
      if (!res.ok) return { scores: [], balanceVersion: ver, error: `http-${res.status}` };
      const data = await res.json();
      return {
        scores: Array.isArray(data.scores) ? data.scores : [],
        balanceVersion: data.balanceVersion != null ? data.balanceVersion : ver
      };
    } catch (e) {
      return { scores: [], balanceVersion: ver, error: 'network' };
    }
  },

  // Fire-and-forget submit. Resolves to { ok, rank? } or { ok: false }.
  async submit(payload) {
    if (!payload || typeof payload.score !== 'number' || payload.score <= 0) {
      return { ok: false, reason: 'empty' };
    }
    const body = {
      playerName: String(payload.playerName || 'Unknown').slice(0, 24),
      score: Math.round(payload.score),
      battles: Math.max(0, payload.battles | 0),
      difficulty: payload.difficulty || 'normal',
      commander: String(payload.commander || 'None').slice(0, 40),
      balanceVersion: balanceVersion(),
      gameVersion: gameVersionName(),
      submittedAt: Date.now()
    };
    try {
      const res = await fetch(ENDPOINTS.submit, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify(body)
      });
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      const data = await res.json().catch(() => ({}));
      return { ok: true, rank: data.rank, accepted: data.accepted !== false };
    } catch (e) {
      return { ok: false, reason: 'network' };
    }
  }
};
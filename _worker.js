// Cloudflare Pages / Workers entry. Routes:
//   /ws              → Matchmaker Durable Object (multiplayer relay)
//   /api/highscores  → HighscoreBoard Durable Object (global top scores)
//   everything else  → static asset bundle
//
// Deploy with `npx wrangler pages deploy .` and the bindings in
// wrangler.toml.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const room = sanitiseRoom(url.searchParams.get('room'));
      const id = env.MATCHMAKER.idFromName(room);
      const stub = env.MATCHMAKER.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/api/highscores') {
      // Single global board instance. Partitioning by balanceVersion is
      // handled inside the DO so one object holds every era's list.
      const id = env.HIGHSCORES.idFromName('global');
      const stub = env.HIGHSCORES.get(id);
      return stub.fetch(request);
    }

    // Admin page. Routed explicitly so `/admin` (with or without a
    // trailing slash) always resolves to admin.html, regardless of any
    // future asset-layout change.
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      const adminUrl = new URL(request.url);
      adminUrl.pathname = '/admin.html';
      return env.ASSETS.fetch(new Request(adminUrl, request));
    }

    // Admin API. Password checked here, then forwarded to the DO on a
    // distinct internal path so the DO can tell admin traffic apart from
    // the public submit/list flow.
    if (url.pathname === '/api/admin/highscores') {
      return handleAdminHighscores(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

function sanitiseRoom(raw) {
  if (!raw) return 'default';
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return cleaned || 'default';
}

// Admin password is read from a Cloudflare secret, never from source.
//   Local dev  — `.dev.vars` in the project root: ADMIN_PASSWORD=your-password
//   Production — `npx wrangler pages secret put ADMIN_PASSWORD`
// If the secret is missing, the endpoint fails closed (500) rather than
// falling through to an empty-string comparison. The password is also
// stripped from the body before forwarding to the DO — the DO has no
// use for it, and keeping it out of DO storage/logs avoids leaking it
// through side channels.
async function handleAdminHighscores(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'method' }, 405);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad-json' }, 400);
  }

  const expected = env.ADMIN_PASSWORD;
  if (typeof expected !== 'string' || expected.length === 0) {
    return json({ error: 'admin-not-configured' }, 500);
  }
  if (!body || typeof body.password !== 'string' || body.password !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }

  // Strip the password before forwarding. The DO's _handleAdmin reads
  // only `action`, `balanceVersion`, and (for remove) `submittedAt` /
  // `playerName`.
  const { password: _pw, ...rest } = body;

  const adminUrl = new URL(request.url);
  adminUrl.pathname = '/admin/highscores';
  const adminReq = new Request(adminUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rest)
  });
  const id = env.HIGHSCORES.idFromName('global');
  const stub = env.HIGHSCORES.get(id);
  return stub.fetch(adminReq);
}

// ---------------------------------------------------------------------------
// Matchmaker (unchanged)
// ---------------------------------------------------------------------------

export class Matchmaker {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (this.sessions.length >= 2) {
      try { server.send(JSON.stringify({ type: 'error', reason: 'room-full' })); } catch {}
      try { server.close(1000, 'room-full'); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    const role = this.sessions.length === 0 ? 'host' : 'guest';
    const session = { ws: server, role };
    this.sessions.push(session);

    this._safeSend(server, { type: 'welcome', role, peers: this.sessions.length });
    if (this.sessions.length === 2) {
      for (const s of this.sessions) this._safeSend(s.ws, { type: 'paired' });
    }

    server.addEventListener('message', (event) => {
      for (const s of this.sessions) {
        if (s === session) continue;
        if (s.ws.readyState !== 1) continue;
        try { s.ws.send(event.data); } catch {}
      }
    });

    const cleanup = () => {
      this.sessions = this.sessions.filter(s => s !== session);
      for (const s of this.sessions) this._safeSend(s.ws, { type: 'peerLeft' });
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  _safeSend(ws, msg) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch {}
  }
}

// ---------------------------------------------------------------------------
// HighscoreBoard
// ---------------------------------------------------------------------------
// Stores top scores per balanceVersion in Durable Object storage.
// Shape in storage:
//   scores:v{N} → [{ playerName, score, battles, difficulty, commander,
//                    balanceVersion, gameVersion, submittedAt }, ...]
// Lists are kept sorted desc by score, truncated to MAX_STORED.

const MAX_STORED = 50;
const MAX_RETURN = 20;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders()
  });
}

export class HighscoreBoard {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Admin traffic (already password-verified by the worker) reaches
    // the DO on a distinct path so it can never collide with the public
    // GET/POST endpoints below.
    if (url.pathname === '/admin/highscores') {
      return this._handleAdmin(request);
    }

    if (request.method === 'GET') {
      const bv = clampInt(url.searchParams.get('balanceVersion'), 1, 9999, 1);
      const limit = clampInt(url.searchParams.get('limit'), 1, MAX_RETURN, 10);
      const list = await this._load(bv);
      return json({
        balanceVersion: bv,
        scores: list.slice(0, limit)
      });
    }

    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'bad-json' }, 400);
      }
      const entry = sanitiseEntry(body);
      if (!entry) return json({ error: 'invalid' }, 400);
      if (entry.score <= 0) return json({ accepted: false, reason: 'zero' });

      const list = await this._load(entry.balanceVersion);
      list.push(entry);
      list.sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt);
      const trimmed = list.slice(0, MAX_STORED);
      await this._save(entry.balanceVersion, trimmed);

      const rank = trimmed.findIndex(
        s => s.submittedAt === entry.submittedAt && s.playerName === entry.playerName
      ) + 1;

      return json({
        accepted: true,
        rank: rank > 0 ? rank : null,
        balanceVersion: entry.balanceVersion
      });
    }

    return json({ error: 'method' }, 405);
  }

  async _load(bv) {
    const key = `scores:v${bv}`;
    const data = await this.state.storage.get(key);
    return Array.isArray(data) ? data : [];
  }

  async _save(bv, list) {
    const key = `scores:v${bv}`;
    await this.state.storage.put(key, list);
  }

  // Admin operations. Every action takes a balanceVersion so a single
  // admin screen can manage any era's board. The password was verified
  // by the worker before this method runs.
  //
  // Actions:
  //   list     — return every stored score (no MAX_RETURN truncation)
  //   clearAll — delete the whole list for that balance version
  //   remove   — delete one entry, keyed by (submittedAt, playerName)
  async _handleAdmin(request) {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'bad-json' }, 400);
    }
    const action = body.action;
    const bv = clampInt(body.balanceVersion, 1, 9999, 1);

    if (action === 'list') {
      const list = await this._load(bv);
      return json({ balanceVersion: bv, scores: list });
    }

    if (action === 'clearAll') {
      await this.state.storage.delete(`scores:v${bv}`);
      return json({ ok: true });
    }

    if (action === 'remove') {
      const submittedAt = body.submittedAt;
      const playerName = body.playerName;
      if (typeof submittedAt !== 'number' || typeof playerName !== 'string') {
        return json({ error: 'missing-key' }, 400);
      }
      const list = await this._load(bv);
      const filtered = list.filter(
        s => !(s.submittedAt === submittedAt && s.playerName === playerName)
      );
      if (filtered.length === list.length) {
        return json({ ok: false, reason: 'not-found' });
      }
      await this._save(bv, filtered);
      return json({ ok: true });
    }

    if (action === 'upsert') {
      const entry = sanitiseEntry(body.entry);
      if (!entry || entry.score <= 0) return json({ error: 'invalid' }, 400);
      const list = await this._load(entry.balanceVersion);
      const kept = list.filter(
        s => !(s.playerName === entry.playerName && s.difficulty === entry.difficulty)
      );
      kept.push(entry);
      kept.sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt);
      await this._save(entry.balanceVersion, kept.slice(0, MAX_STORED));
      return json({ ok: true, balanceVersion: entry.balanceVersion });
    }

    return json({ error: 'unknown-action' }, 400);
  }
}

function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Sanitise a display string for storage. Preserves Unicode letters and
// marks — Turkish ğ, ş, ı, ç, ö, ü and any other script's letters
// (Cyrillic, CJK, accented Latin, …) — along with digits, whitespace,
// hyphens, apostrophes and periods. Only strips control / punctuation
// characters that are unsafe for display. NFC-normalised so visually
// identical strings compare equal across submissions.
function cleanText(raw, maxLen, fallback) {
  const src = typeof raw === 'string' ? raw : String(raw || '');
  const trimmed = src
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\s\-'.]/gu, '')
    .trim();
  if (trimmed.length <= maxLen) return trimmed || fallback;
  let sliced = trimmed.slice(0, maxLen);
  // Don't leave a dangling high surrogate at the length cap — a sliced
  // astral-plane code point would become a replacement glyph.
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) sliced = sliced.slice(0, -1);
  return sliced || fallback;
}

function sanitiseEntry(body) {
  if (!body || typeof body !== 'object') return null;
  const score = Math.round(Number(body.score));
  if (!Number.isFinite(score) || score < 0) return null;
  const balanceVersion = clampInt(body.balanceVersion, 1, 9999, 1);
  const playerName = cleanText(body.playerName, 24, 'Unknown');
  const commander = cleanText(body.commander, 40, 'None');
  const difficulty = ['easy', 'normal', 'hard'].includes(body.difficulty)
    ? body.difficulty
    : 'normal';
  const battles = Math.max(0, Math.min(999, parseInt(body.battles, 10) || 0));
  const gameVersion = String(body.gameVersion || '').slice(0, 40);
  const submittedAt = typeof body.submittedAt === 'number'
    ? body.submittedAt
    : Date.now();
  return {
    playerName,
    score,
    battles,
    difficulty,
    commander,
    balanceVersion,
    gameVersion,
    submittedAt
  };
}
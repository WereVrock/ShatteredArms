// Cloudflare Pages / Workers entry. Routes /ws to the Matchmaker Durable
// Object (keyed by room code) and everything else to the static asset
// bundle. Deploy with `npx wrangler pages deploy .` and the bindings in
// wrangler.toml.
//
// The Matchmaker is a pure relay: it pairs exactly two sessions per room,
// tells each its role ('host' | 'guest'), and forwards every subsequent
// message to the other peer verbatim. It never inspects game state.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const room = sanitiseRoom(url.searchParams.get('room'));
      const id = env.MATCHMAKER.idFromName(room);
      const stub = env.MATCHMAKER.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};

function sanitiseRoom(raw) {
  if (!raw) return 'default';
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return cleaned || 'default';
}

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
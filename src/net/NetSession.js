// Thin WebSocket wrapper for one peer. Owns the connection lifecycle and
// dispatches decoded JSON messages to registered handlers. Knows nothing
// about the game — HostController / GuestController interpret payloads.

export class NetSession {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.paired = false;
    this.role = null;
    this._handlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.addEventListener('open', () => {
        this.connected = true;
        resolve();
      });

      this.ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        this._dispatch(msg);
      });

      this.ws.addEventListener('close', () => {
        this.connected = false;
        this.paired = false;
        this._dispatch({ type: '_closed' });
      });

      this.ws.addEventListener('error', (err) => {
        if (!this.connected) reject(err);
      });
    });
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch {} }
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); return true; }
    catch { return false; }
  }

  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(handler);
  }

  // Removes a previously-registered handler. Symmetric with on(): passing
  // the same function reference that was registered removes exactly that
  // one subscription. No-op if the type has no handlers or the reference
  // is not found, so callers can call off() freely during teardown
  // without tracking whether each handler was actually attached.
  off(type, handler) {
    const arr = this._handlers.get(type);
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this._handlers.delete(type);
  }

  _dispatch(msg) {
    if (msg.type === 'welcome') this.role = msg.role;
    else if (msg.type === 'paired') this.paired = true;
    else if (msg.type === 'peerLeft') this.paired = false;

    // Snapshot the handler arrays before iterating: a handler is allowed
    // to call off() on itself (or on a sibling) as part of its own
    // processing — the common case being teardown triggered by a
    // 'welcome' with a wrong role, or by 'peerLeft'. Iterating the live
    // array would skip the next handler whenever one removes itself,
    // because the splice shifts the remaining entries left.
    const arr = this._handlers.get(msg.type);
    if (arr) for (const h of arr.slice()) h(msg);
    const any = this._handlers.get('*');
    if (any) for (const h of any.slice()) h(msg);
  }
}
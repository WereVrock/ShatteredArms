// ===== BuildInfo.js =====
// Reads and caches build metadata from buildinfo.properties, the file
// CodeClip regenerates on every applied change. Fetched once at startup
// (see load()) and held in module state for the lifetime of the page —
// the values never change while the page is open.
//
// The file is plain Java-style properties, two keys:
//   BUILD_NO=2S              (base-36 counter, increments per CodeClip write)
//   LAST_UPDATED=Wed-14:32:05
//
// Loading is asynchronous (the browser cannot read a local file
// synchronously), so the badge mounts before the fetch completes and
// subscribes via subscribe() to refresh once the values land. A failed
// fetch (offline dev, 404, file not deployed) still fires subscribers so
// consumers render their fallback rather than waiting forever.
//
// buildinfo.properties is expected at the site root — the same directory
// as index.html. On Cloudflare Pages that is /buildinfo.properties, which
// the relative fetch below resolves against the current document URL.

const SOURCE = 'buildinfo.properties';

let _loaded = false;
let _settled = false;
let _buildNo = null;
let _lastUpdated = null;
const _listeners = new Set();

// Minimal .properties parser. Handles:
//   - blank lines, '#' and '!' comments (Java properties spec)
//   - 'key = value' and 'key=value'
//   - trailing whitespace on both sides of key and value
// Ignores anything that does not contain '='. Does NOT handle escapes or
// line continuations — buildinfo.properties as written by CodeClip never
// uses them.
function _parse(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function _notify() {
  for (const fn of _listeners) {
    try { fn(); } catch (e) { /* subscriber errors must not break others */ }
  }
}

export const BuildInfo = {
  // Kick off the fetch. Idempotent — calling twice is a no-op, so multiple
  // modules can safely ask for load() at their own init time.
  load() {
    if (_loaded) return;
    _loaded = true;
    fetch(SOURCE, { cache: 'no-cache' })
      .then(r => (r.ok ? r.text() : ''))
      .then(text => {
        const props = _parse(text);
        _buildNo = props.BUILD_NO || null;
        _lastUpdated = props.LAST_UPDATED || null;
        _settled = true;
        _notify();
      })
      .catch(() => {
        _settled = true;
        _notify();
      });
  },

  // Raw values, or null when not yet known / not present in the file.
  get buildNo() { return _buildNo; },
  get lastUpdated() { return _lastUpdated; },

  // True once the fetch has resolved (success OR failure). Until then
  // consumers should render a "loading" fallback rather than assume the
  // file said nothing.
  get settled() { return _settled; },

  // Subscribe to "metadata has landed" notifications. Fires at most once
  // per page (the values never change after the fetch resolves). If the
  // fetch already settled when subscribe() is called, the listener is
  // invoked immediately on the next microtask so late subscribers are not
  // stranded.
  subscribe(fn) {
    _listeners.add(fn);
    if (_settled) Promise.resolve().then(() => { try { fn(); } catch (e) {} });
    return () => _listeners.delete(fn);
  }
};
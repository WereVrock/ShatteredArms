// ===== src/logging/BatchLogger.js =====
// Central log sink. Everything that wants to log goes through here.
//
// Motivation: in headless runs the console is flooded with per-tick events
// (AI decisions, combat, morale) and each console.log call is expensive —
// in DevTools it triggers a full I/O round-trip and DOM update. Batching
// all lines into a single console.log at the end of a run cuts the wall
// time of a scenario dramatically.
//
// Two modes:
//
//   autoFlush (default) — every push emits immediately. Used when a human
//     is watching, so output appears in real time. This is the default so
//     the playable scenarios and any interactive/dev session get live logs
//     without an extra configure() call.
//
//   buffered — lines accumulate in memory. Call flush() to emit them all
//     as one console.log. Long headless runs should switch to this to
//     avoid the per-line console I/O cost: call
//     BatchLogger.configure({ autoFlush: false }) at the start of a
//     headless run.
//
// Lines are stored as plain strings, optionally prefixed by a category.
// The prefix format is "category: message" when a category is given, or
// just "message" otherwise. Callers that want richer formatting can pass
// a preformatted string with no category.
//
// HISTORY: every pushed line is also appended to a separate growing
// history array. flush() only clears the *pending console buffer*, never
// the history. The headless UI reads history to populate the on-page log
// panel without stealing content from the console batch.
//
// Usage:
//   import { BatchLogger } from '../logging/BatchLogger.js';
//
//   BatchLogger.push('combat', `attacker=${a} defender=${d}`);
//   BatchLogger.push(null, 'plain line');
//
//   BatchLogger.flush();          // buffered mode: dump and clear
//   BatchLogger.clear();          // buffered mode: discard without printing
//
//   BatchLogger.configure({ autoFlush: true, enabled: true });

export class BatchLogger {
  // --- Configuration -----------------------------------------------------

  // When false, push() and flush() are no-ops. Used to silence output
  // entirely (e.g. a verbose-off headless run that still wants its own
  // summary line printed separately).
  static enabled = true;

  // When true, every push() emits immediately via console.log. When false,
  // lines buffer until flush() is called.
  static autoFlush = true;

  // Optional prefix applied to every line. Useful to tag a run, but
  // currently unused — callers usually prefix themselves.
  static prefix = '';

  // --- Internal state ----------------------------------------------------

  // Lines accumulated since the last flush(), waiting to be emitted as one
  // batched console.log call.
  static _buffer = [];

  // Every line ever pushed this session, in order. Never cleared by
  // flush(); only by clearHistory(). Read by the headless UI's log panel.
  static _history = [];

  // --- Public API --------------------------------------------------------

  // Update configuration. Unspecified keys are left unchanged, so a caller
  // can flip one flag without resetting the others.
  static configure({ enabled, autoFlush, prefix } = {}) {
    if (enabled !== undefined) this.enabled = !!enabled;
    if (autoFlush !== undefined) this.autoFlush = !!autoFlush;
    if (prefix !== undefined) this.prefix = String(prefix);
  }

  // Append a line. `category` may be null/undefined for an unprefixed line.
  // `message` is coerced to string.
  static push(category, message) {
    if (!this.enabled) return;

    const line = category
      ? `${category}: ${message}`
      : String(message);
    const prefixed = this.prefix ? this.prefix + line : line;

    this._history.push(prefixed);

    if (this.autoFlush) {
      console.log(prefixed);
      return;
    }

    this._buffer.push(prefixed);
  }

  // Emit everything buffered so far as one console.log call, then clear
  // the pending buffer. History is NOT cleared — the UI panel still needs
  // to read everything that was pushed.
  static flush() {
    if (!this.enabled) {
      this._buffer.length = 0;
      return;
    }
    if (this._buffer.length === 0) return;

    // Single console.log with newline-joined lines. DevTools renders this
    // as a multi-line block, and it costs one round-trip instead of N.
    console.log(this._buffer.join('\n'));
    this._buffer.length = 0;
  }

  // Discard the pending console buffer without printing. Does NOT touch
  // history — use clearHistory() for that.
  static clear() {
    this._buffer.length = 0;
  }

  // Current pending-buffer size, for tests / debugging.
  static bufferedCount() {
    return this._buffer.length;
  }

  // --- History (UI read side) --------------------------------------------

  // Full history array. Callers must not mutate it. Slice for a copy.
  static getHistory() {
    return this._history;
  }

  static historyLength() {
    return this._history.length;
  }

  // Wipe history. The headless UI calls this on the Reset button. The
  // console batch buffer is untouched — clear() handles that separately.
  static clearHistory() {
    this._history.length = 0;
  }
}
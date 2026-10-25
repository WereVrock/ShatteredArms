// ===== TickProfiler.js =====
// Per-section timing for BattleSimulation.tick(). Off by default: the
// simulation holds `tickProfile = null` and pays one null check per
// section. When an instance is attached (the render diagnostic does this),
// every section records the time since the previous mark.
//
// drainReport() returns one line with the average milliseconds per tick
// spent in each section, largest first, and resets the counters.
export class TickProfiler {
  constructor() {
    this._sums = new Map();
    this._ticks = 0;
    this._last = 0;
    this._tickStart = 0;
    this._totalSum = 0;
  }

  begin() {
    this._ticks++;
    this._tickStart = performance.now();
    this._last = this._tickStart;
  }

  mark(name) {
    const now = performance.now();
    this._sums.set(name, (this._sums.get(name) || 0) + (now - this._last));
    this._last = now;
  }

  end() {
    this._totalSum += performance.now() - this._tickStart;
  }

  drainReport() {
    if (this._ticks === 0) return 'no ticks sampled';

    const rows = Array.from(this._sums.entries()).sort((a, b) => b[1] - a[1]);
    const parts = rows.map(([name, sum]) => `${name}=${(sum / this._ticks).toFixed(2)}`);
    const report =
      `ticks=${this._ticks} sim.total=${(this._totalSum / this._ticks).toFixed(2)}ms/tick | ` +
      parts.join(' ');

    this._sums.clear();
    this._ticks = 0;
    this._totalSum = 0;
    return report;
  }
}
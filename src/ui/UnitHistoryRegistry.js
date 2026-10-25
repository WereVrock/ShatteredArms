// ===== UnitHistoryRegistry.js =====
// Battle-wide manager for per-unit history trackers. Owns one
// UnitHistoryTracker per Unit, feeds all of them on every sim tick once
// logging is enabled, and exposes per-unit lookups for the view.
//
// ENABLE LIFECYCLE (this is the whole point):
//   - Starts disabled. No trackers, no per-tick work, no sim-side cost.
//   - enable() is called the first time debug mode is engaged in a
//     battle — a G+click selection that produces a debug target.
//   - Once enabled, it stays enabled for the rest of the battle. Turning
//     debug mode off does NOT disable it, and does NOT drop any tracker.
//     Reinspecting a unit later shows its full history since enable().
//   - enable() is idempotent.
//
// The registry does NOT reset itself when the debug target changes — each
// tracker is permanently bound to its unit. Only HudView's view decides
// which tracker's log to display; the others keep accumulating.
//
// Frame counter is owned by the registry, not the trackers, so all
// trackers' events carry the same frame id for a given sim tick. This is
// what makes cross-unit event correlation possible later.
import { UnitHistoryTracker } from './UnitHistoryTracker.js';

export class UnitHistoryRegistry {
  constructor() {
    this._enabled = false;
    this._frame = 0;
    this._trackers = new Map();
  }

  get enabled() {
    return this._enabled;
  }

  // Idempotent. Called by main.js the first time a debug target is set.
  enable() {
    if (this._enabled) return;
    this._enabled = true;
  }

  // Called once per SIM TICK by HudView, with all units in the battle.
  // No-op while disabled. Lazily creates a tracker for each unit the
  // first time it is seen — all trackers created in the same call share
  // the same starting frame.
  update(units, meleeEvents, rangedEvents, allSoldiersById) {
    if (!this._enabled) return;
    this._frame++;
    for (const unit of units) {
      let tracker = this._trackers.get(unit.id);
      if (!tracker) {
        tracker = new UnitHistoryTracker(unit.id);
        this._trackers.set(unit.id, tracker);
      }
      tracker.update(this._frame, unit, meleeEvents, rangedEvents, allSoldiersById);
    }
  }

  // Returns the tracker for a unit, or null if the unit was never seen
  // (only possible if the registry is disabled or the unit is new).
  get(unitId) {
    if (unitId === null || unitId === undefined) return null;
    return this._trackers.get(unitId) || null;
  }

  // Full reset. Called when a battle ends, so a fresh battle starts
  // disabled. Not called on a simple debug-target change.
  reset() {
    this._enabled = false;
    this._frame = 0;
    this._trackers.clear();
  }
}
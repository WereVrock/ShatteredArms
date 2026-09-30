// B2 — Pin detector. A pure read: given an enemy unit, is it pinned?
//
// "Pinned" means:
//   (a) a threshold fraction of the unit's living soldiers are engaged or
//       staggered, AND
//   (b) the unit's center of mass has moved less than a threshold distance
//       over the last N ticks.
//
// Thresholds are per unit-type (line / ranged / cavalry), read from
// AIConfig.pinDetector — a single global constant reads a 5-wide spear
// block and a 3-wide archer unit identically, which they are not.
//
// Exploit-resistance (Best-possible tier): a human player can fake a pin
// by holding a unit in apparent engagement without committing, baiting a
// hammer charge. Rather than hiding the thresholds (a hidden constant is
// still a constant), we require the pin condition to hold continuously for
// a minimum duration before it's trusted. Faking costs the player real
// time. Set minHoldTicks = 0 to disable.
import { AIConfig } from '../config/AIConfig.js';
import { isCavalry, isRanged } from '../config/UnitClasses.js';
import { unitTypeOf } from './behaviorUtils.js';

const _HISTORY_PRUNE_MULT = 3; // keep samples 3x window length

export class PinDetector {
  constructor() {
    this._history = new Map();      // unitId -> [{ tick, x, z }]
    this._pinnedSince = new Map();  // unitId -> tick when pin condition first held
  }

  // Called each decision cycle from PlanScheduler (and only there — pin
  // detection is a plan-layer read, not a per-tick system).
  record(allUnits, tick) {
    const maxAge = this._maxHistoryTicks();
    const seen = new Set();
    for (const unit of allUnits) {
      if (!unit || unit.isDefeated()) continue;
      seen.add(unit.id);
      const c = unit.getCenter();
      let hist = this._history.get(unit.id);
      if (!hist) { hist = []; this._history.set(unit.id, hist); }
      hist.push({ tick, x: c.x, z: c.z });
      while (hist.length > 0 && tick - hist[0].tick > maxAge) hist.shift();
    }
    // Prune history for units that no longer exist.
    for (const id of this._history.keys()) {
      if (!seen.has(id)) {
        this._history.delete(id);
        this._pinnedSince.delete(id);
      }
    }
  }

  // Returns { pinned: boolean, confidence: 0..1, holding: boolean }.
  // `holding` true means the raw condition held but minHoldTicks hasn't
  // elapsed yet — callers may want to log this distinctly.
  assess(unit, tick, minHoldTicks) {
    const raw = this._assessRaw(unit);
    if (!raw.pinned) {
      this._pinnedSince.delete(unit.id);
      return { pinned: false, confidence: 0, holding: false };
    }
    const hold = Math.max(0, minHoldTicks || 0);
    if (hold === 0) return raw;

    let since = this._pinnedSince.get(unit.id);
    if (since === undefined) {
      this._pinnedSince.set(unit.id, tick);
      since = tick;
    }
    if (tick - since < hold) {
      return { pinned: false, confidence: raw.confidence, holding: true };
    }
    return raw;
  }

  _assessRaw(unit) {
    const alive = unit.getAliveSoldiers();
    if (alive.length === 0) return { pinned: false, confidence: 0, holding: false };

    const engaged = alive.filter(s => s.state === 'engaged' || s.state === 'staggered').length;
    const engagedFraction = engaged / alive.length;

    const th = this._thresholdsFor(unit);
    if (engagedFraction < th.engagedFraction) {
      return { pinned: false, confidence: 0, holding: false };
    }

    const hist = this._history.get(unit.id);
    if (!hist || hist.length < 2) {
      return { pinned: false, confidence: 0, holding: false };
    }

    const now = hist[hist.length - 1];
    let ref = hist[0];
    for (let i = hist.length - 1; i >= 0; i--) {
      if (now.tick - hist[i].tick >= th.windowTicks) {
        ref = hist[i];
        break;
      }
    }
    const dx = now.x - ref.x;
    const dz = now.z - ref.z;
    const drift = Math.sqrt(dx * dx + dz * dz);
    if (drift > th.driftThreshold) {
      return { pinned: false, confidence: 0, holding: false };
    }

    // Confidence: how far above both thresholds the observed state is.
    const fracConf = th.engagedFraction < 1
      ? (engagedFraction - th.engagedFraction) / (1 - th.engagedFraction)
      : 1;
    const driftConf = th.driftThreshold > 0
      ? (th.driftThreshold - drift) / th.driftThreshold
      : 1;
    const confidence = Math.max(0, Math.min(1, Math.min(fracConf, driftConf)));

    return { pinned: true, confidence, holding: false };
  }

  _thresholdsFor(unit) {
    const cfg = AIConfig.pinDetector;
    const type = unitTypeOf(unit);
    let key = 'line';
    if (type) {
      if (isCavalry(type)) key = 'cavalry';
      else if (isRanged(type)) key = 'ranged';
    }
    return cfg.thresholdsByUnitType[key] || cfg.thresholdsByUnitType.default;
  }

  _maxHistoryTicks() {
    const cfg = AIConfig.pinDetector;
    let maxWindow = 0;
    for (const t of Object.values(cfg.thresholdsByUnitType)) {
      if (t.windowTicks > maxWindow) maxWindow = t.windowTicks;
    }
    return Math.max(1, maxWindow) * _HISTORY_PRUNE_MULT;
  }
}
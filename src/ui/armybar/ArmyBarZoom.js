// Card size multiplier for one army bar. Pure logic plus a tiny
// localStorage persistence; no DOM. The view multiplies its fitted layout by
// `value` (see ArmyBarView._applyLayout).

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;

function clamp(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

export class ArmyBarZoom {
  constructor(storageKey) {
    this.storageKey = storageKey;
    this.value = this._load();
  }

  // direction is +1 or -1. Returns true if the zoom changed.
  step(direction) {
    const next = clamp(Math.round((this.value + direction * ZOOM_STEP) * 100) / 100);
    if (next === this.value) return false;
    this.value = next;
    this._save();
    return true;
  }

  _load() {
    try {
      const n = parseFloat(localStorage.getItem(this.storageKey));
      if (isFinite(n)) return clamp(n);
    } catch (e) { /* storage unavailable: use the default */ }
    return 1;
  }

  _save() {
    try {
      localStorage.setItem(this.storageKey, String(this.value));
    } catch (e) { /* storage unavailable: zoom just is not remembered */ }
  }
}
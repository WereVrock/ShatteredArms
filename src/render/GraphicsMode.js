// ===== src/render/GraphicsMode.js =====
// Fast accessor for graphics-quality flags driven by SettingsStore.
// Builders and views read these on hot paths, so a direct
// SettingsStore.get() lookup is wrapped here once.
//
// All flags are read LIVE (no cached snapshot): toggling one in the
// settings panel takes effect immediately for anything that reads it after
// the toggle.
import { SettingsStore } from '../ui/settings/SettingsStore.js';
import { tierForDistance, tierForDistanceWithHysteresis } from './LodConfig.js';

export class GraphicsMode {
  static get disableAnimations() {
    return !!SettingsStore.get().disableAnimations;
  }

  // Optional detail-distance multiplier from the Graphics page. 1 (the
  // default) is the authored LOD thresholds; smaller values pull every
  // detail zone closer to the camera.
  static _distanceScale(s) {
    const v = parseFloat(s.lodDistanceScale);
    return v > 0 ? v : 1;
  }

  static get lodEnabled() {
    return !!SettingsStore.get().lodEnabled;
  }

  // The most detailed tier the player allows. 1 = Detailed. Lower number =
  // more detail. When LOD is off, this is the fixed tier for every soldier.
  static get modelDetail() {
    return SettingsStore.get().modelDetail;
  }

  // The most simplified tier the player allows. 4 = Abstracted. Higher
  // number = less detail. Only consulted when LOD is enabled.
  static get minModelDetail() {
    return SettingsStore.get().minModelDetail;
  }

  // Resolve the LOD tier for a soldier at the given XZ distance from the
  // camera, without hysteresis. Used by anything that has no current tier
  // to compare against (one-off placement, icon composition, tests).
  static tierForDistance(distanceXZ) {
    const s = SettingsStore.get();
    if (!s.lodEnabled) return s.modelDetail;
    return tierForDistance(
      distanceXZ, s.modelDetail, s.minModelDetail,
      GraphicsMode._distanceScale(s));
  }

  // Resolve the LOD tier for a per-frame soldier that already has a
  // current tier. Uses hysteresis (see LodConfig) so a soldier oscillating
  // across a threshold does not rebuild its model repeatedly. This is the
  // resolver SoldierView uses.
  static tierForDistanceWithHysteresis(distanceXZ, currentTier) {
    const s = SettingsStore.get();
    if (!s.lodEnabled) return s.modelDetail;
    return tierForDistanceWithHysteresis(
      distanceXZ, currentTier, s.modelDetail, s.minModelDetail,
      GraphicsMode._distanceScale(s));
  }
}
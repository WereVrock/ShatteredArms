import { CombatConfig } from '../config/CombatConfig.js';

// Defaults used when CombatConfig.spearHandling does not declare the key.
// Half-width of the forward cone in which a friendly counts as "touched"
// by the spear. Narrow on purpose: side neighbours at formation spacing
// (~90 degrees off-axis) and front-diagonal neighbours (~45 degrees) are
// not in the line of the shaft.
const DEFAULT_FRONT_CONTACT_HALF_ARC_DEG = 25;
// Extra margin added to both ends of a turn's swept arc so friendlies
// just outside the exact arc (spear thickness, turn overshoot) still
// trigger a raise.
const DEFAULT_SWEEP_PADDING_DEG = 10;

const DEG_TO_RAD = Math.PI / 180;

// Pure geometry: decides whether a spear-armed soldier's shaft is touching,
// or is about to sweep through, a friendly soldier. No state, no mutation.
// FacingSystem owns the raise/lower state machine and calls into this.
//
// `nearby` is the candidate list from SpatialGrid.queryNearby, supplied by
// the caller so one grid query serves both checks each tick.
export class SpearFriendlyContact {
  // Is a living friendly inside the spear's reach and forward cone?
  static isTouchingFriendly(soldier, nearby) {
    const cfg = CombatConfig.spearHandling;
    const reachSq = cfg.friendlyClipReach * cfg.friendlyClipReach;
    const halfArc =
      (cfg.frontContactHalfArcDeg ?? DEFAULT_FRONT_CONTACT_HALF_ARC_DEG) * DEG_TO_RAD;

    for (const other of nearby) {
      if (!this._isFriendlyCandidate(soldier, other)) continue;

      const dx = other.pos.x - soldier.pos.x;
      const dz = other.pos.z - soldier.pos.z;
      const dSq = dx * dx + dz * dz;
      if (dSq > reachSq) continue;

      // Co-located friendly: the shaft is certainly touching it.
      if (dSq < 0.0001) return true;

      const rel = this._normalizeAngle(Math.atan2(dx, dz) - soldier.facing);
      if (Math.abs(rel) <= halfArc) return true;
    }
    return false;
  }

  // Would rotating from the current facing by `diff` radians sweep the
  // shaft through a friendly within reach? The swept arc is padded at both
  // ends (see DEFAULT_SWEEP_PADDING_DEG).
  static wouldSweepThroughFriendly(soldier, diff, nearby) {
    const cfg = CombatConfig.spearHandling;
    const reachSq = cfg.friendlyClipReach * cfg.friendlyClipReach;
    const pad = (cfg.sweepPaddingDeg ?? DEFAULT_SWEEP_PADDING_DEG) * DEG_TO_RAD;

    let arcMin;
    let arcMax;
    if (diff >= 0) {
      arcMin = -pad;
      arcMax = diff + pad;
    } else {
      arcMin = diff - pad;
      arcMax = pad;
    }

    for (const other of nearby) {
      if (!this._isFriendlyCandidate(soldier, other)) continue;

      const dx = other.pos.x - soldier.pos.x;
      const dz = other.pos.z - soldier.pos.z;
      const dSq = dx * dx + dz * dz;
      if (dSq > reachSq) continue;

      if (dSq < 0.0001) return true;

      const rel = this._normalizeAngle(Math.atan2(dx, dz) - soldier.facing);
      if (rel >= arcMin && rel <= arcMax) return true;
    }
    return false;
  }

  static _isFriendlyCandidate(soldier, other) {
    if (other === soldier) return false;
    if (!other.isAlive()) return false;
    return other.teamId === soldier.teamId;
  }

  static _normalizeAngle(a) {
    return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  }
}
// Shared parabolic-trajectory math for arrows. ProjectileView uses this to
// fly the arrow; SoldierView uses it to pitch the bow to the same angle the
// arrow will leave at, so the two always agree by construction.
//
// The flight model is: horizontal position lerps linearly from the shooter
// to the target; height follows a parabola layered on top of that line,
//   y(t) = START_Y + (END_Y - START_Y) * t + arcHeight * 4 * t * (1 - t)
// so the arrow leaves with a substantial upward velocity and settles onto
// the target. launchVerticalSpeed() is the derivative of that at t = 0.
//
// BOW-HAND OFFSET constants live here (rather than in SoldierModelComposer
// or Projectile) because they are the shared truth between the two layers:
// the model uses them to place the bow mesh, the sim uses them to spawn
// the arrow. Keeping them in one place is what makes "spawn at the bow"
// mean the same thing in both layers.
import { CombatConfig } from '../config/CombatConfig.js';

export const ArrowArc = {
  MIN_DURATION: 0.6,
  SPEED: 8,
  // Launch height. Kept for compatibility; Projectile now reads BOW_HAND_Y
  // directly. Set to the same value so nothing that still reads START_Y
  // drifts.
  START_Y: 0.68,
  END_Y: 0.8,

  // Foot-archer bow-hand offset in body-local space. Matches the blob and
  // skeleton entries in SoldierModelComposer.BOW_ARM_ANCHORS
  // (handX 0.20, handY 0.68, handZ 0.28).
  //
  // FORWARD: distance ahead of the body centre to the bow hand.
  // LATERAL: sideways offset (positive = the bow-arm side, which is +X in
  //          body-local space at facing = 0).
  // Y:       world height of the bow hand on a foot archer.
  //
  // Goblins (0.14, 0.42, 0.22) and mounted archers (rider raised ~0.50)
  // will spawn slightly off from their bow until the sim carries
  // per-soldier offsets through — see the note on Projectile's launch
  // position.
  BOW_HAND_FORWARD: 0.28,
  BOW_HAND_LATERAL: 0.20,
  BOW_HAND_Y:       0.68,

  duration(dist) {
    return Math.max(this.MIN_DURATION, dist / this.SPEED);
  },

arcHeight(dist) {
    const base = Math.min(0.5 + dist * 0.18, 4.0);
    return base * this.arcMult(dist);
  },

  // Distance-scaled arc fraction, 0..1. 0 = flat shot (arrow travels
  // straight along the bow-to-target line, no loft, no dropping into
  // the target from above), 1 = full parabola. Linear interp between
  // CombatConfig.arrow.arcFlatMaxDist (return 0) and arcFullDist
  // (return 1), clamped at both ends.
  //
  // Everything downstream that reads arcHeight — Projectile's flight
  // integration, ProjectileView's rendered arc, and
  // launchVerticalSpeed (which drives computeAim's pitch, and
  // therefore SoldierView's bow angle) — scales together by
  // construction. Adding a distance-aware bow pose anywhere later
  // needs no extra wiring: read this.
  arcMult(dist) {
    const flat = CombatConfig.arrow.arcFlatMaxDist;
    const full = CombatConfig.arrow.arcFullDist;
    if (full <= flat) return 1;
    if (dist <= flat) return 0;
    if (dist >= full) return 1;
    return (dist - flat) / (full - flat);
  },

  launchVerticalSpeed(dist) {
    return (this.END_Y - this.START_Y) + 4 * this.arcHeight(dist);
  },

  // Aim angles from a shooter to a target, matching the flight model above.
  // `yaw` follows the codebase convention (0 = +Z, positive toward +X).
  // `pitch` is elevation above horizontal, in radians.
  computeAim(fromX, fromZ, toX, toZ) {
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) {
      return { yaw: 0, pitch: 0, dist: 0 };
    }
    return {
      yaw: Math.atan2(dx, dz),
      pitch: Math.atan2(this.launchVerticalSpeed(dist), dist),
      dist
    };
  }
};
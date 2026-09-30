// Shared parabolic-trajectory math for arrows. ProjectileView uses this to
// fly the arrow; SoldierView uses it to pitch the bow to the same angle the
// arrow will leave at, so the two always agree by construction.
//
// The flight model is: horizontal position lerps linearly from the shooter
// to the target; height follows a parabola layered on top of that line,
//   y(t) = START_Y + (END_Y - START_Y) * t + arcHeight * 4 * t * (1 - t)
// so the arrow leaves with a substantial upward velocity and settles onto
// the target. launchVerticalSpeed() is the derivative of that at t = 0.
export const ArrowArc = {
  MIN_DURATION: 0.6,
  SPEED: 8,
  START_Y: 1.0,
  END_Y: 0.8,

  duration(dist) {
    return Math.max(this.MIN_DURATION, dist / this.SPEED);
  },

  arcHeight(dist) {
    return Math.min(0.5 + dist * 0.18, 4.0);
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
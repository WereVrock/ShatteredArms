import { CombatConfig } from '../config/CombatConfig.js';

// Rate-limited turning of chargob beasts. Nothing about a beast turns
// instantly: every system that wants a beast to face somewhere goes through
// turn(), which rotates the beast's facing by at most rate (rad/s) this tick.
// desiredFacing and moveFacing are kept equal to the new facing so that
// FacingSystem does not turn the beast a second time.

const TWO_PI = Math.PI * 2;

function norm(a) {
  return ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
}

export const ChargobTurn = {
  norm,

  // Angle one step of at most maxStep closer to target.
  step(current, target, maxStep) {
    const d = norm(target - current);
    if (Math.abs(d) <= maxStep) return current + d;
    return current + (d > 0 ? maxStep : -maxStep);
  },

  // Turns the beast towards `target` (radians) at `rate` rad/s.
  // Returns the angle (radians, absolute) still to turn.
  turn(b, target, rate) {
    const a = ChargobTurn.step(b.facing, target, rate / CombatConfig.tickRateHz);
    b.facing = a;
    b.desiredFacing = a;
    b.moveFacing = a;
    return Math.abs(norm(target - a));
  }
};
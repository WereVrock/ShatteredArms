// ===== Projectile.js =====
// One in-flight arrow. Pure data + advance step; owns no collision logic
// and emits no events. ProjectileSystem advances every projectile each
// tick and then runs collision checks — see ProjectileSystem.update().
//
// Trajectory follows the same parabolic model the renderer's ArrowArc
// uses (imported here rather than duplicated so sim and visual can never
// disagree about where an arrow is). Horizontal position lerps linearly
// from launch to the shot's target point; height follows
//   y(t) = START_Y + (END_Y - START_Y) * t + arcHeight * 4 * t * (1 - t)
//
// prevX / prevZ / prevY are the position at the end of the PREVIOUS
// advance step, so collision checks can sweep the segment between the
// last position and the current one instead of testing a single point —
// a single-point test would let a fast arrow tunnel straight through a
// soldier between two ticks.
//
// Layering note: importing from ../render/ is a cross-layer dependency,
// but ArrowArc is pure math with zero dependencies, and duplicating it
// here would let sim and visual drift. If it needs to move to a shared
// folder later, it is a 3-import rename.
import { ArrowArc } from '../render/ArrowArc.js';

export class Projectile {
  constructor({ id, teamId, shooterUnitId, shooterSoldierId, weaponType,
                fromX, fromZ, toX, toZ }) {
    this.id = id;
    this.teamId = teamId;
    this.shooterUnitId = shooterUnitId;
    this.shooterSoldierId = shooterSoldierId;
    this.weaponType = weaponType;

    this.fromX = fromX;
    this.fromZ = fromZ;
    this.toX = toX;
    this.toZ = toZ;

    const dx = toX - fromX;
    const dz = toZ - fromZ;
    this.dist = Math.hypot(dx, dz);

    this.duration = ArrowArc.duration(this.dist);
    this.arcHeight = ArrowArc.arcHeight(this.dist);

    // Launch yaw/pitch. Recorded here so the view can orient the arrowhead
    // on the first frame it sees this projectile — at spawn prev == current,
    // so there is no per-tick delta to derive a heading from yet.
    const aim = ArrowArc.computeAim(fromX, fromZ, toX, toZ);
    this.yaw = aim.yaw;
    this.launchPitch = aim.pitch;

    this.elapsed = 0;

    // Launch position — also the "previous" position for the first tick.
    this.x = fromX;
    this.y = ArrowArc.START_Y;
    this.z = fromZ;
    this.prevX = fromX;
    this.prevY = ArrowArc.START_Y;
    this.prevZ = fromZ;
  }

  // Advance by one tick. Returns false once the arrow has reached (or
  // passed) its target point and should be considered landed.
  advance(dt) {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;

    this.elapsed += dt;
    const t = Math.min(1, this.elapsed / this.duration);

    this.x = this.fromX + (this.toX - this.fromX) * t;
    this.z = this.fromZ + (this.toZ - this.fromZ) * t;
    this.y = ArrowArc.START_Y
           + (ArrowArc.END_Y - ArrowArc.START_Y) * t
           + this.arcHeight * 4 * t * (1 - t);

    return t < 1;
  }

  get landed() {
    return this.elapsed >= this.duration;
  }
}
// One in-flight arrow. Pure data + advance step; owns no collision logic
// and emits no events. ProjectileSystem advances every projectile each
// tick and then runs collision checks — see ProjectileSystem.update().
//
// Trajectory follows the same parabolic model the renderer's ArrowArc
// uses (imported here rather than duplicated so sim and visual can never
// disagree about where an arrow is). Horizontal position lerps linearly
// from launch to the shot's target point; height follows
//   y(t) = launchY + (END_Y - launchY) * t + arcHeight * 4 * t * (1 - t)
//
// LAUNCH POSITION IS AT THE BOW, NOT AT THE ARCHER'S BODY CENTRE. The
// archer's body-local bow-hand offset (forward + lateral, from
// ArrowArc.BOW_HAND_*) is rotated by the launch yaw using the same
// rotation convention as Unit._applyFormationAt, so the arrow appears
// exactly where the bow mesh is when the archer is settled on its target.
// Without this, the arrow visibly spawns from inside the archer's chest.
//
// The yaw used to rotate the offset is the AIM direction, not the archer's
// current body facing. For an archer still mid-turn (FacingSystem turns at
// a bounded rate), the spawn point is therefore off the actual bow by a
// fraction of a unit — imperceptible at battle zoom, and self-corrects on
// the next shot once the archer is settled. If this ever needs to be
// exact, RangedCombatSystem can pass the archer's current facing alongside
// fromX/fromZ and this constructor can prefer it.
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
import { ArrowArc } from './ArrowArc.js';

export class Projectile {
  constructor({ id, teamId, shooterUnitId, shooterSoldierId, weaponType,
                fromX, fromZ, toX, toZ }) {
    this.id = id;
    this.teamId = teamId;
    this.shooterUnitId = shooterUnitId;
    this.shooterSoldierId = shooterSoldierId;
    this.weaponType = weaponType;

    // Archer body-centre position. Kept for the duration/arcHeight
    // computation (which measures shooter-to-target distance, not
    // launch-to-target distance — a fraction-of-a-unit difference that
    // does not matter for either the flight time or the arc peak).
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

    // Launch position — at the bow hand, not at the archer's centre. The
    // bow-hand offset is (lateral, forward) in body-local space; rotating
    // it by the launch yaw uses the same formula as Unit._applyFormationAt
    // so the world offset matches the mesh's body-local offset whenever
    // the archer is facing its target. See the file header for the caveat
    // about archers that are still mid-turn.
    const cosYaw = Math.cos(this.yaw);
    const sinYaw = Math.sin(this.yaw);
    this.launchX = fromX + ArrowArc.BOW_HAND_LATERAL * cosYaw
                        + ArrowArc.BOW_HAND_FORWARD * sinYaw;
    this.launchZ = fromZ - ArrowArc.BOW_HAND_LATERAL * sinYaw
                        + ArrowArc.BOW_HAND_FORWARD * cosYaw;
    this.launchY = ArrowArc.BOW_HAND_Y;

    this.x = this.launchX;
    this.y = this.launchY;
    this.z = this.launchZ;
    this.prevX = this.launchX;
    this.prevY = this.launchY;
    this.prevZ = this.launchZ;
  }

  // Advance by one tick. Returns false once the arrow has reached (or
  // passed) its target point and should be considered landed.
  //
  // Horizontal lerp runs from the LAUNCH position (the bow) to the target
  // point, not from the archer's body centre — so the arrow's flight line
  // begins where the arrow visually begins, and does not appear to curve
  // sideways on its first frame.
  advance(dt) {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;

    this.elapsed += dt;
    const t = Math.min(1, this.elapsed / this.duration);

    this.x = this.launchX + (this.toX - this.launchX) * t;
    this.z = this.launchZ + (this.toZ - this.launchZ) * t;
    this.y = this.launchY
           + (ArrowArc.END_Y - this.launchY) * t
           + this.arcHeight * 4 * t * (1 - t);

    return t < 1;
  }

  get landed() {
    return this.elapsed >= this.duration;
  }
}
// A4 fallback behavior: what a "fragile" unit (average morale below
// AIConfig.fragileMoraleThreshold) does instead of standing idle or
// continuing to be assigned plan/concentration roles it can no longer be
// trusted with.
//
// A fragile unit falls back to a rally point behind the team's own current
// line anchor and holds there, facing the enemy, until TeamAI's per-cycle
// fragile check finds its average morale has recovered above the threshold
// (at which point TeamAI simply stops routing it here and it resumes normal
// UnitBehaviorRegistry-driven behavior next decision cycle — no special
// "recovered" transition needed on this side).
//
// Deliberately stateless and small: this is a fallback, not a tactic. It
// does not fight, does not chase, does not re-evaluate the enemy. It picks
// a point and holds it.
import { AIConfig } from '../config/AIConfig.js';

export class ReserveBehavior {
  // context: the unit's BattleLineFormation context, if any (used only for
  // the forward/right axis so the rally point sits behind OUR line using
  // the same axis convention as everything else — not required).
  // teamAnchor: {x, z} — team's own mean alive-unit center, supplied by
  // TeamAI so this stays a pure function of inputs rather than reaching
  // into team state itself.
  decide(unit, context, teamAnchor) {
    if (!teamAnchor) return null;

    let backX, backZ;
    if (context) {
      backX = -context.forward.x;
      backZ = -context.forward.z;
    } else {
      backX = -Math.sin(unit.formationFacing);
      backZ = -Math.cos(unit.formationFacing);
    }

    const goalX = teamAnchor.x + backX * AIConfig.fragileRallyDepth;
    const goalZ = teamAnchor.z + backZ * AIConfig.fragileRallyDepth;

    const center = unit.getCenter();
    const dgx = goalX - center.x;
    const dgz = goalZ - center.z;
    if (Math.sqrt(dgx * dgx + dgz * dgz) < AIConfig.slotArrivalRadius) return null;

    // Face back toward the enemy (opposite of the retreat direction) so a
    // fragile unit holding in reserve isn't visibly facing away from the
    // fight it just left.
    const facing = Math.atan2(-backX, -backZ);

    return { x: goalX, z: goalZ, facing };
  }
}
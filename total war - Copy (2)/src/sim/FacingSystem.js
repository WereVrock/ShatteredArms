// ===== FacingSystem.js =====
// Facing rule, now turn-rate-limited (see CombatConfig.turning):
// - `facing` is the soldier's actual current facing and changes ONLY here,
//   gradually, rotating toward `desiredFacing` at effectiveTurnRateRadPerSec.
// - engaged/ranged with a target -> desiredFacing = angle to target
//   (highest priority; overrides whatever ThreatFacingSystem set this tick)
// - actively moving (moveFacing set this tick) -> desiredFacing = moveFacing
// - otherwise -> desiredFacing = unit's formationFacing, UNLESS
//   ThreatFacingSystem already set a more urgent desiredFacing this tick
//   (checked by priority order below, not overwritten blindly)
//
// This is the single place that reconciles "what do I want to face" against
// "how fast can I actually turn" — no other system is allowed to write
// `facing` directly anymore, only `desiredFacing`.
//
// Spear handling: a spear-armed soldier executing a large reorientation
// raises their spear first if the swept arc would clip a nearby friendly,
// rotates while raised, and lowers once the new facing is reached. See
// CombatConfig.spearHandling for the tuning and the state machine docs in
// _updateSpearHandling below.
import { CombatConfig } from '../config/CombatConfig.js';
import { SpearFriendlyContact } from './SpearFriendlyContact.js';

export class FacingSystem {
  constructor(deltaSeconds, spatialGrid) {
    this.deltaSeconds = deltaSeconds;
    this.spatialGrid = spatialGrid;
  }

  update(allSoldiers, unitsById) {
    const byId = new Map(allSoldiers.map(s => [s.id, s]));

    for (const soldier of allSoldiers) {
      if (!soldier.isAlive()) continue;

      this._resolveDesiredFacing(soldier, byId, unitsById);
      this._updateSpearHandling(soldier);
      this._rotateTowardDesired(soldier);
    }
  }

  _resolveDesiredFacing(soldier, byId, unitsById) {
    // Highest priority: actively fighting / shooting — face the target.
    if ((soldier.state === 'engaged' || soldier.state === 'ranged') && soldier.targetId) {
      const target = byId.get(soldier.targetId);
      if (target && target.isAlive()) {
        soldier.desiredFacing = this._angleTo(soldier.pos, target.pos);
        return;
      }
    }

    // Next: actually translating this tick — face the walked direction.
    // This intentionally overrides any desiredFacing ThreatFacingSystem set
    // earlier this same tick UNLESS the soldier is holding position (not
    // moving), so a soldier who is still marching toward their slot keeps
    // marching-facing, but a soldier who has ARRIVED and is standing still
    // keeps whatever threat-facing was set instead of snapping back to
    // formation facing while danger is still nearby.
    if (soldier.movedThisTick) {
      soldier.desiredFacing = soldier.moveFacing;
      return;
    }

    // Stopped, not in melee: ThreatFacingSystem may already have set a
    // desiredFacing this tick (a nearby charge). If so, leave it — don't
    // overwrite with formation facing. ThreatFacingSystem runs BEFORE this
    // system each tick and is the sole owner of _threatFacingSetThisTick.
    const unit = unitsById.get(soldier.unitId);
    if (unit && !soldier._threatFacingSetThisTick) {
      soldier.desiredFacing = unit.formationFacing;
    }
  }

  // Spear-handling state machine. Runs after desiredFacing is set for this
  // tick and before rotation. Only affects spear-armed soldiers; other
  // weapons short-circuit out on the weaponType check.
  //
  // States:
  //   lowered  — at rest. Rotates freely at effectiveTurnRateRadPerSec
  //              (which already factors spearTurnRateMult). Enters
  //              'raising' when a large reorientation would sweep the
  //              shaft through a nearby friendly.
  //   raising  — spear rising, no rotation. Advances every tick.
  //   raised   — spear up, rotating. Transitions to 'lowering' when the
  //              desired facing is reached (needsRotation becomes false).
  //   lowering — spear descending, no rotation. Advances every tick.
  //
  // Engaged and staggered soldiers skip the cycle entirely and are force-
  // reset to 'lowered' — melee facing is dominated by target-tracking and
  // the ceremony would fire on every small target adjustment. Snapping to
  // lowered on entry prevents a mid-raise soldier from being stuck holding
  // the spear up through an entire fight if they engage during a raise.
_updateSpearHandling(soldier) {
    if (!soldier.unitTypeDef.raisesPolearmOnTurn) return;

    if (soldier.state === 'engaged' || soldier.state === 'staggered') {
      soldier.spearRaiseState = 'lowered';
      soldier.spearRaiseTicksLeft = 0;
      soldier.spearRaiseAmount = 0;
      return;
    }

    const cfg = CombatConfig.spearHandling;
    const diff = this._normalizeAngle(soldier.desiredFacing - soldier.facing);
    const diffDeg = Math.abs(diff) * 180 / Math.PI;
    const needsRotation = diffDeg >= cfg.minRotationDegForRaise;

    // One grid query per soldier per tick, shared by the contact check and
    // the sweep check.
    const nearby = this.spatialGrid.queryNearby(
      soldier.pos.x, soldier.pos.z, 1
    );
    // Contact is independent of rotation: a friendly in front of the
    // shaft forces the spear up whether or not the soldier is turning.
    const touching = SpearFriendlyContact.isTouchingFriendly(soldier, nearby);

    switch (soldier.spearRaiseState) {
      case 'lowered': {
        soldier.spearRaiseAmount = 0;
        const sweepRisk = needsRotation && this._wouldClipFriendly(soldier, diff, nearby);
        if (touching || sweepRisk) {
          soldier.spearRaiseState = 'raising';
          soldier.spearRaiseTicksLeft = cfg.raiseDurationTicks;
        }
        return;
      }
      case 'raising': {
        soldier.spearRaiseTicksLeft--;
        const t = 1 - soldier.spearRaiseTicksLeft / cfg.raiseDurationTicks;
        soldier.spearRaiseAmount = Math.max(0, Math.min(1, t));
        if (soldier.spearRaiseTicksLeft <= 0) {
          soldier.spearRaiseAmount = 1;
          soldier.spearRaiseState = 'raised';
        }
        return;
      }
      case 'raised': {
        soldier.spearRaiseAmount = 1;
        // Stay up while turning OR while a friendly is still in front.
        if (!needsRotation && !touching) {
          soldier.spearRaiseState = 'lowering';
          soldier.spearRaiseTicksLeft = cfg.lowerDurationTicks;
        }
        return;
      }
      case 'lowering': {
        if (touching) {
          // A friendly is in the shaft's path again: resume raising from
          // the current height instead of finishing the lowering.
          soldier.spearRaiseState = 'raising';
          soldier.spearRaiseTicksLeft = Math.max(
            1,
            Math.ceil((1 - soldier.spearRaiseAmount) * cfg.raiseDurationTicks)
          );
          return;
        }
        soldier.spearRaiseTicksLeft--;
        const t = soldier.spearRaiseTicksLeft / cfg.lowerDurationTicks;
        soldier.spearRaiseAmount = Math.max(0, Math.min(1, t));
        if (soldier.spearRaiseTicksLeft <= 0) {
          soldier.spearRaiseAmount = 0;
          soldier.spearRaiseState = 'lowered';
        }
        return;
      }
    }
  }

  // Does the spear shaft's sweep from `soldier.facing` by `diff` radians
  // pass within clip-reach of any friendly soldier?
  //
  // Practical approximation: any friendly whose position is both
  //   (a) within friendlyClipReach of the soldier, and
  //   (b) at an angular offset from current facing that lies inside the
  //       swept arc [0, diff] (or [diff, 0] for negative diff)
  // counts as a clip risk. This triggers reliably for formation
  // reorientations (friendlies packed at 0.6-unit spacing, well inside the
  // default 1.2 reach) and stays quiet in open ground where there is
  // nothing nearby to sweep through.
_wouldClipFriendly(soldier, diff, nearby) {
    return SpearFriendlyContact.wouldSweepThroughFriendly(soldier, diff, nearby);
  }

  _normalizeAngle(a) {
    return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  }

  _rotateTowardDesired(soldier) {
    // Soldiers in the raise/lower phases of spear handling hold facing —
    // the ceremony must complete before rotation resumes.
    if (soldier.unitTypeDef.raisesPolearmOnTurn) {
      if (soldier.spearRaiseState === 'raising' ||
          soldier.spearRaiseState === 'lowering') {
        return;
      }
    }

    const maxStep = soldier.effectiveTurnRateRadPerSec * this.deltaSeconds;
    let diff = this._normalizeAngle(soldier.desiredFacing - soldier.facing);

    if (Math.abs(diff) <= maxStep) {
      soldier.facing = soldier.desiredFacing;
    } else {
      soldier.facing += Math.sign(diff) * maxStep;
    }

    // Normalize stored facing to [-PI, PI] to avoid unbounded growth.
    soldier.facing = this._normalizeAngle(soldier.facing);
  }

  _angleTo(from, to) {
    return Math.atan2(to.x - from.x, to.z - from.z);
  }
}
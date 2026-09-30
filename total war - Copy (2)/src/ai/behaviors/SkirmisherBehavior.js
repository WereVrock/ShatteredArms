// ===== SkirmisherBehavior.js =====
// Archer behavior: standoff/kite as before, but target ACQUISITION for
// firing is now driven by FocusFireCoordinator at the team level (it sets
// unit.aiFocusTargetUnitId directly, consumed by the focus-target branch of
// TargetingSystem) rather than SkirmisherBehavior picking its own
// nearest-enemy target for intent purposes. This file now only decides
// POSITIONING (where to stand / kite to), not who to shoot.
//
// Cavalry-cover awareness: when BattleAssessment reports that our cavalry
// is decisively weaker than the enemy's, archers stop advancing to
// archerStandoffDist from the enemy (which exposes them to being swept up
// by superior enemy horse in open ground) and instead hold just forward of
// our own melee line. Kiting away from a threat then curves them back INTO
// the infantry formation rather than out into open field. See
// _hugInfantryLine below. This hug rule only fires on DEFENSIVE stance —
// an attacking team pushes archers forward with the line even at the risk
// of being caught.
//
// Unleash rule: hug is not a static crouch. If the archer's current
// focus-fire target sits inside an "engagement bubble"
// (AIConfig.skirmisherUnleashRangeMult × CombatConfig.rangedRange around
// ANY single melee-line unit), the archer advances to a firing position on
// that target and shoots it. Once in range it holds and fires; when the
// focus target leaves the bubble or dies, the archer returns to the hug
// position. The bubble bounds how far the archer will chase — the whole
// point of the hug rule is not to leave the line's protective envelope.
//
// Firing-position awareness (this revision): the unit-center-to-target-
// center distance does NOT answer "can my soldiers actually shoot?" A
// 2x8 archer formation is ~5.6 units wide; archers on the far edge of
// that formation sit up to ~2.8 units further from the enemy than the
// unit's center. `TargetingSystem` assigns each archer its own personal
// nearest-enemy target, and `RangedCombatSystem` fires per-soldier only
// when that soldier's own distance is within rangedRange. So the unit
// can be at a nominal standoff that LOOKS in range while the far-edge
// half of the formation is out of range and silent — the observed
// "archers shoot partly" symptom.
//
// `_firingFraction` measures the actual share of this unit's living
// archers whose personal nearest enemy is inside the firing band, and
// `decide()` uses it as the true "am I in a firing position?" gate. When
// the fraction drops below the floor, the standoff target is tightened
// so the whole formation advances and the far-edge archers come into
// range.
import { AIConfig } from '../../config/AIConfig.js';
import { CombatConfig } from '../../config/CombatConfig.js';
import { toSimSpeed } from '../../config/SpeedScale.js';
import { isCavalry } from '../../config/UnitClasses.js';
import { nearestUnit, centerTowardUnit } from '../behaviorUtils.js';
import { AIDebugLog } from '../AIDebugLog.js';

// Share of this unit's living archers that must have a personal target in
// range for the unit to count as "in a firing position." Below this the
// unit advances regardless of what the center-to-center distance says.
// 0.9 keeps a bit of slack (occasional stragglers behind the formation
// shouldn't force an advance) while still insisting that essentially the
// whole block can shoot.
const FIRING_FRACTION_FLOOR = 0.9;

// Multiplier applied to the standoff goal when firing fraction is below
// the floor. 0.65 shaves a meaningful chunk off the nominal standoff
// without walking the archers into melee range — enough that one advance
// cycle brings the far-edge archers back inside rangedRange.
const TIGHTENED_STANDOFF_MULT = 0.65;

// (RANGE_EDGE_BUFFER was removed — it existed only to shrink the "hold
// band" upper bound in the old band-management logic. That logic is
// gone: archers now hold unconditionally whenever firingGood is true,
// so no edge buffer is needed.)

export class SkirmisherBehavior {
  // worldCtx: shared per-decision-cycle context from TeamAI. Read here for
  // infantryLineAnchor (hug reference point) and infantryLineUnits (unleash
  // bubble test). May be null/absent on the very first cycle or when TeamAI
  // was constructed without a formation; both fallbacks handle that by
  // falling through to normal behavior.
  decide(unit, enemyUnits, context, intent, assessment, worldCtx) {
    // Tick stamp for logging. worldCtx.currentTick is populated by TeamAI
    // every decision cycle, so the log lines here correlate with the rest
    // of the AI trace (posture, plan, charge categories). Fallback 0 is
    // kept for safety in case a caller ever passes a stripped worldCtx.
    const tick = (worldCtx && typeof worldCtx.currentTick === 'number')
      ? worldCtx.currentTick
      : 0;

    const chargeThreat = this._findChargeThreat(unit, enemyUnits);
    if (chargeThreat) {
      intent.threatUnitId = chargeThreat.id; // read by TeamAI for intercept routing
      const order = this._kiteFrom(unit, chargeThreat, context);
      if (order) {
        AIDebugLog.log('skirmish', tick,
          `unit=${unit.id} KITE threat=${chargeThreat.id} ` +
          `goal=(${order.x.toFixed(2)},${order.z.toFixed(2)})`);
      } else {
        AIDebugLog.log('skirmish', tick,
          `unit=${unit.id} KITE-NULL threat=${chargeThreat.id}`);
      }
      return order;
    }
    intent.threatUnitId = null;

    // Cavalry-cover fallback. Runs AFTER the charge-threat kite (an
    // immediate charger is a problem regardless of where our line is) and
    // BEFORE the target-standoff logic (which is what we're overriding).
    //
    // Gated on DEFENSIVE stance only. The hug-the-line rule is the right
    // answer when the team has committed to holding ground and letting
    // the enemy come to it — archers without cavalry cover need to stay
    // near the melee line so a kite doesn't pull them into open field.
    // When the team is on OFFENCE, it has already decided to press
    // forward; the archers' job is to advance with the line and add
    // missile pressure, even at the risk of being caught by superior
    // enemy horse. The stance is committed once at battle start and only
    // ever flips defence->offence (via archer-pressure or envelopment
    // re-checks in TeamAI._decide), so a team that flips to offence
    // mid-battle stops hugging the line from that point — which matches
    // the "we're attacking now, push everything" intent of the flip.
    //
    // The flag is computed team-wide by BattleAssessment and is false on
    // weakened tier — weakened archers advance normally and get punished.
    // worldCtx.stance is always populated by TeamAI before worldCtx is
    // handed to behaviors, so no null-check fallback is needed for the
    // normal path; a missing worldCtx or missing stance falls through to
    // the pre-existing standoff logic, which is the safe default.
    if (assessment && assessment.skirmishersWithoutCavalryCover &&
        worldCtx && worldCtx.stance === 'defence') {
      // Unleash pass first — an archer that can shoot something SHOULD
      // shoot it, even while nominally in hug mode. If the focus-fire
      // target is inside the engagement bubble and out of range, this
      // returns an advance order; if it's inside the bubble and already
      // in range, it returns a hold order (position == current, no-op).
      // Only when the focus target is outside the bubble (or missing)
      // does this return null and let the hug logic run.
      const unleashOrder = this._tryUnleash(unit, enemyUnits, worldCtx);
      if (unleashOrder) return unleashOrder;

      // Distinguish "cannot compute a hug position" (fall through is
      // correct — there is no line to hide behind, so standing still is
      // worse than advancing) from "already AT the hug position" (fall
      // through is a BUG — the archer would immediately re-enter standoff
      // and walk back out toward the enemy, defeating the entire rule).
      const canHug = !!(context && worldCtx && worldCtx.infantryLineAnchor);
      if (canHug) {
        const hugOrder = this._hugInfantryLine(unit, context, worldCtx);
        if (hugOrder) {
          AIDebugLog.log('skirmish', tick,
            `unit=${unit.id} NO_CAV_COVER hug-line ` +
            `goal=(${hugOrder.x.toFixed(2)},${hugOrder.z.toFixed(2)}) ` +
            `ownCav=${assessment.ownCavalryCount} enemyCav=${assessment.enemyCavalryCount}`);
          return hugOrder;
        }
        // Already at the hug position — HOLD. Returning null here keeps
        // the archer tucked in front of the melee line on subsequent
        // cycles instead of letting it drift back out to archerStandoffDist.
        return null;
      }
      // No formation context, or no living melee line to hug (anchor is
      // null). Fall through to normal standoff — freezing in the open
      // with no formation would be strictly worse than advancing.
    }

    // Positioning still uses nearest-enemy-formation as the anchor for
    // standoff distance — this is a spacing decision (how far back from the
    // general fight), independent of WHICH specific enemy unit is being
    // fired at (that's FocusFireCoordinator's job now).
    const target = nearestUnit(unit, enemyUnits);
    if (!target) {
      AIDebugLog.log('skirmish', tick, `unit=${unit.id} NO_TARGET`);
      return null;
    }

    const myCenter = unit.getCenter();
    const { dx, dz, dist, facing } = centerTowardUnit(unit, target);
    if (dist <= 0.0001) {
      AIDebugLog.log('skirmish', tick,
        `unit=${unit.id} DEGENERATE dist=${dist.toFixed(4)} tgt=${target.id}`);
      return null;
    }

    // --- Firing-position read ---
    // True "can my soldiers shoot?" measurement. Uses per-archer
    // nearest-enemy distance against the same band RangedCombatSystem
    // uses ([rangedMinRange, rangedRange]) — NOT the unit-center-to-
    // target-center distance above. A unit whose firing fraction is
    // good has essentially the whole block able to shoot, which is the
    // only condition that matters for the question "should I be moving
    // right now?"
    const firingFraction = this._firingFraction(unit, enemyUnits);
    const firingGood = firingFraction >= FIRING_FRACTION_FLOOR;

    // Simple rule: if the whole formation can shoot, HOLD AND SHOOT.
    //
    // `firingGood` already guarantees that nearly every archer's
    // personal nearest enemy sits inside the firing band
    // [rangedMinRange, rangedRange], so the unit is definitionally in
    // a firing position. Repositioning from that state — even toward a
    // "preferred" standoff distance — is pure waste: it burns a
    // decision cycle's worth of movement for no firing-time benefit,
    // and it briefly pulls the formation OUT of its own firing
    // envelope while it walks. Every cycle the archers can shoot, they
    // shoot from wherever they're standing.
    //
    // Advancing is only correct when firing is NOT good — i.e. the
    // formation's far edge can't actually shoot. That case is handled
    // by the target-based path below, which tightens the standoff
    // until the whole block is inside range.
    if (firingGood) {
      AIDebugLog.log('skirmish', tick,
        `unit=${unit.id} FIRING_HOLD dist=${dist.toFixed(2)} ` +
        `frac=${firingFraction.toFixed(2)} tgt=${target.id}`);
      return { x: myCenter.x, z: myCenter.z, facing: unit.formationFacing };
    }

    // Firing is not good — advance to bring the far-edge archers into
    // range. `desired` is the tightened standoff distance the archer
    // walks toward; `tolerance` is the goal-arrival slack. There is no
    // "hold inside a standoff band" case anymore — a firing-good unit
    // never reaches this code, so every call here is a genuine advance.
    const baseDesired = AIConfig.archerStandoffDist +
      (context ? context.depthOffset : 0);
    const desired = baseDesired * TIGHTENED_STANDOFF_MULT;
    const tolerance = AIConfig.archerStandoffTolerance;

    if (context) {
      const tgtCenter = target.getCenter();
      const fwdX = dx / dist;
      const fwdZ = dz / dist;

      const goalX = tgtCenter.x - fwdX * desired + context.right.x * context.lateralOffset;
      const goalZ = tgtCenter.z - fwdZ * desired + context.right.z * context.lateralOffset;

      const dgx = goalX - myCenter.x;
      const dgz = goalZ - myCenter.z;
      const dg = Math.sqrt(dgx * dgx + dgz * dgz);

      // At the goal — only a valid hold if firing is actually good.
      // Returning null when firing is poor would leave the unit parked
      // at a position where its far-edge archers can't shoot; instead
      // fall through and issue a tighter goal that forces an advance.
      if (dg < tolerance && firingGood) {
        AIDebugLog.log('skirmish', tick,
          `unit=${unit.id} CTX_HOLD dg=${dg.toFixed(3)} tol=${tolerance} ` +
          `my=(${myCenter.x.toFixed(2)},${myCenter.z.toFixed(2)}) ` +
          `goal=(${goalX.toFixed(2)},${goalZ.toFixed(2)}) ` +
          `tgt=${target.id} frac=${firingFraction.toFixed(2)}`);
        return null;
      }

      // Firing poor and already at the (already-tightened) goal: push
      // one step tighter so the formation keeps closing until its far-
      // edge archers come into range. Clamped above rangedMinRange + a
      // small buffer so the unit can't be walked into melee range by a
      // persistent firing-fraction deficit.
      let finalGoalX = goalX;
      let finalGoalZ = goalZ;
      if (dg < tolerance && !firingGood) {
        const emergencyDist = Math.max(
          CombatConfig.rangedMinRange + 2.0,
          desired * 0.7
        );
        finalGoalX = tgtCenter.x - fwdX * emergencyDist +
          context.right.x * context.lateralOffset;
        finalGoalZ = tgtCenter.z - fwdZ * emergencyDist +
          context.right.z * context.lateralOffset;
      }

      AIDebugLog.log('skirmish', tick,
        `unit=${unit.id} CTX_MOVE dg=${dg.toFixed(3)} tol=${tolerance} ` +
        `my=(${myCenter.x.toFixed(2)},${myCenter.z.toFixed(2)}) ` +
        `goal=(${finalGoalX.toFixed(2)},${finalGoalZ.toFixed(2)}) ` +
        `tgt=${target.id} frac=${firingFraction.toFixed(2)} ` +
        `lat=${context.lateralOffset.toFixed(2)} depth=${context.depthOffset.toFixed(2)} ` +
        `desired=${desired.toFixed(2)}`);

      return { x: finalGoalX, z: finalGoalZ, facing };
    }

    if (Math.abs(dist - desired) <= tolerance && firingGood) {
      AIDebugLog.log('skirmish', tick,
        `unit=${unit.id} NOCTX_HOLD dist=${dist.toFixed(3)} desired=${desired.toFixed(3)} tol=${tolerance} ` +
        `my=(${myCenter.x.toFixed(2)},${myCenter.z.toFixed(2)}) tgt=${target.id} frac=${firingFraction.toFixed(2)}`);
      return null;
    }

    const tgtCenter = target.getCenter();
    const fwdX = dx / dist;
    const fwdZ = dz / dist;

    if (dist < desired) {
      const back = Math.min(desired - dist + 0.5, 2.5);
      AIDebugLog.log('skirmish', tick,
        `unit=${unit.id} NOCTX_BACK dist=${dist.toFixed(3)} desired=${desired.toFixed(3)} back=${back.toFixed(2)} ` +
        `my=(${myCenter.x.toFixed(2)},${myCenter.z.toFixed(2)}) tgt=${target.id} frac=${firingFraction.toFixed(2)}`);
      return {
        x: myCenter.x - fwdX * back,
        z: myCenter.z - fwdZ * back,
        facing
      };
    }

    AIDebugLog.log('skirmish', tick,
      `unit=${unit.id} NOCTX_ADVANCE dist=${dist.toFixed(3)} desired=${desired.toFixed(3)} ` +
      `my=(${myCenter.x.toFixed(2)},${myCenter.z.toFixed(2)}) ` +
      `goal=(${(tgtCenter.x - fwdX * desired).toFixed(2)},${(tgtCenter.z - fwdZ * desired).toFixed(2)}) ` +
      `tgt=${target.id} frac=${firingFraction.toFixed(2)}`);

    return {
      x: tgtCenter.x - fwdX * desired,
      z: tgtCenter.z - fwdZ * desired,
      facing
    };
  }

  // Fraction of this unit's living archers whose personal nearest enemy
  // sits inside the firing band [rangedMinRange, rangedRange] in XZ.
  //
  // Uses the same band RangedCombatSystem uses per-soldier to decide
  // whether to fire (and the same nearest-enemy convention TargetingSystem
  // uses to assign each archer its target), so the answer here matches
  // what will actually happen on the next combat tick. A soldier whose
  // nearest enemy is too far (out of rangedRange) or too close (below
  // rangedMinRange) cannot fire and does not count.
  //
  // Called once per decision cycle per archer unit. Cost is
  // O(ownArchers × enemySoldiers) — cheap on the cadence this runs at
  // (AIConfig.decisionIntervalTicks).
  _firingFraction(unit, enemyUnits) {
    const mine = unit.getAliveSoldiers();
    if (mine.length === 0) return 1; // nothing to fire; treat as "fine"

    const enemySoldiers = [];
    for (const eu of enemyUnits) {
      if (eu.isDefeated()) continue;
      enemySoldiers.push(...eu.getAliveSoldiers());
    }
    if (enemySoldiers.length === 0) return 1;

    const minSq = CombatConfig.rangedMinRange * CombatConfig.rangedMinRange;
    const maxSq = CombatConfig.rangedRange * CombatConfig.rangedRange;

    let inRange = 0;
    for (const s of mine) {
      let nearestSq = Infinity;
      for (const e of enemySoldiers) {
        const dx = e.pos.x - s.pos.x;
        const dz = e.pos.z - s.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < nearestSq) nearestSq = dSq;
      }
      if (nearestSq >= minSq && nearestSq <= maxSq) inRange++;
    }
    return inRange / mine.length;
  }

  // Unleash rule. Given the archer's current focus-fire target (set by
  // FocusFireCoordinator and read by TargetingSystem), if the target is
  // inside the engagement bubble and out of the archer's firing range,
  // return a move order to a firing position on it. If already in range
  // of the focus target (which implies it's close to the line and thus
  // inside the bubble), return a no-move order — the archer holds where
  // it is and RangedCombatSystem fires. If the focus target is outside
  // the bubble (or missing), return null so the hug rule runs.
  //
  // No-move orders (position == current) are used rather than null for
  // the in-range case, because returning null would let the hug rule
  // pull the archer back out of range — producing an advance/hug
  // oscillation on every decision cycle. The no-op guard in
  // Unit.issueMoveOrder (dist < 0.5) means issuing a no-move order does
  // NOT clear the archer's 'ranged' state, so firing continues
  // uninterrupted.
  //
  // Only the focus target can trigger an unleash — arbitrary enemies in
  // the bubble are ignored, because picking a target here would fight
  // FocusFireCoordinator's team-wide assignment. The bubble bounds how
  // far the archer will advance; focus fire decides who it advances for.
  _tryUnleash(unit, enemyUnits, worldCtx) {
    if (!worldCtx || !worldCtx.infantryLineUnits ||
        worldCtx.infantryLineUnits.length === 0) {
      return null;
    }

    const focusId = unit.aiFocusTargetUnitId;
    if (!focusId) return null;

    const focusUnit = enemyUnits.find(u => u.id === focusId);
    if (!focusUnit || focusUnit.isDefeated()) return null;

    const rangedRange = CombatConfig.rangedRange;
    const unleashRadius = rangedRange * AIConfig.skirmisherUnleashRangeMult;
    const unleashRadiusSq = unleashRadius * unleashRadius;

    // Bubble test: is the focus target within unleashRadius of ANY single
    // melee-line unit? Only one line unit needs to be inside that radius
    // for the target to qualify — the bubble is a union of per-line-unit
    // circles, not a single circle around the line's mean. Using the mean
    // would over-extend the bubble on a spread line and under-extend it
    // on a concentrated one.
    const tc = focusUnit.getCenter();
    let inBubble = false;
    for (const lineUnit of worldCtx.infantryLineUnits) {
      if (lineUnit.isDefeated()) continue;
      const lc = lineUnit.getCenter();
      const dx = tc.x - lc.x;
      const dz = tc.z - lc.z;
      if (dx * dx + dz * dz <= unleashRadiusSq) {
        inBubble = true;
        break;
      }
    }
    if (!inBubble) return null;

    const myCenter = unit.getCenter();
    const dx = tc.x - myCenter.x;
    const dz = tc.z - myCenter.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Already in firing range of the focus target — hold and let
    // RangedCombatSystem fire. Returned as a no-op move order rather than
    // null so the caller does NOT fall through to the hug rule and pull
    // the archer back out of range. See method header for why this
    // matters for oscillation.
    if (dist <= rangedRange) {
      return { x: myCenter.x, z: myCenter.z, facing: unit.formationFacing };
    }

    // Out of range — advance along the archer's own line-of-sight to the
    // target, parking at (rangedRange * fireFraction). Using the archer's
    // CURRENT position as the reference direction (rather than the line
    // anchor or the target's own facing) keeps the advance direct for
    // flank targets without routing the archer past or around the enemy.
    // The fireFraction leaves a small buffer inside max range so the shot
    // does not flicker in and out as both units shuffle by a few tenths
    // of a unit each tick.
    if (dist < 0.001) return null;
    const ux = (myCenter.x - tc.x) / dist;
    const uz = (myCenter.z - tc.z) / dist;
    const fireDist = rangedRange * AIConfig.skirmisherUnleashFireFraction;
    const goalX = tc.x + ux * fireDist;
    const goalZ = tc.z + uz * fireDist;
    const facing = Math.atan2(tc.x - goalX, tc.z - goalZ);

    AIDebugLog.log('skirmish', tickForLog(worldCtx),
      `unit=${unit.id} UNLEASH target=${focusId} dist=${dist.toFixed(2)} ` +
      `goal=(${goalX.toFixed(2)},${goalZ.toFixed(2)})`);

    return { x: goalX, z: goalZ, facing };
  }

  // Cavalry-cover fallback position: `skirmisherForwardHugOffset` in front
  // of the infantry line's mean center, keeping the archer's assigned
  // lateral slot from the formation context. Under this rule archers never
  // advance to archerStandoffDist from the enemy — they stay tucked just
  // forward of the melee formation, so a kite away from any threat passes
  // back through the infantry rather than out into open ground.
  //
  // Returns null when already at the hug position (within standoff
  // tolerance) or when the anchor/context needed to compute it is missing.
  _hugInfantryLine(unit, context, worldCtx) {
    if (!context || !context.forward || !worldCtx) return null;
    const anchor = worldCtx.infantryLineAnchor;
    if (!anchor) return null;

    const hugOffset = AIConfig.skirmisherForwardHugOffset;
    const lateral = context.lateralOffset || 0;

    const goalX = anchor.x
      + context.forward.x * hugOffset
      + context.right.x * lateral;
    const goalZ = anchor.z
      + context.forward.z * hugOffset
      + context.right.z * lateral;

    const myCenter = unit.getCenter();
    const dx = goalX - myCenter.x;
    const dz = goalZ - myCenter.z;
    const dg = Math.sqrt(dx * dx + dz * dz);
    if (dg < AIConfig.archerStandoffTolerance) return null;

    // Face along the line's forward axis — the enemy side. The archer
    // holds in place facing the fight it's about to fall back into.
    const facing = Math.atan2(context.forward.x, context.forward.z);
    return { x: goalX, z: goalZ, facing };
  }

  _findChargeThreat(unit, enemyUnits) {
    const myCenter = unit.getCenter();
    let closest = null;
    let closestDist = Infinity;

    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      const alive = enemy.getAliveSoldiers();
      if (alive.length === 0) continue;
      const sample = alive[0];
      if (!isCavalry(sample.unitTypeDef)) continue;

      let speedSum = 0;
      for (const s of alive) speedSum += s.currentSpeed;
      const avgSpeed = speedSum / alive.length;
      if (avgSpeed < toSimSpeed(AIConfig.archerChargeThreatSpeed)) continue;

      const enemyCenter = enemy.getCenter();
      const dx = enemyCenter.x - myCenter.x;
      const dz = enemyCenter.z - myCenter.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AIConfig.archerKiteTriggerDist) continue;

      if (dist < closestDist) {
        closestDist = dist;
        closest = enemy;
      }
    }

    return closest;
  }

  _kiteFrom(unit, threatUnit, context) {
    const myCenter = unit.getCenter();
    const threatCenter = threatUnit.getCenter();

    const dx = myCenter.x - threatCenter.x;
    const dz = myCenter.z - threatCenter.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.001) {
      const backX = context ? -context.forward.x : 0;
      const backZ = context ? -context.forward.z : 1;
      return {
        x: myCenter.x + backX * AIConfig.archerKiteTriggerDist,
        z: myCenter.z + backZ * AIConfig.archerKiteTriggerDist,
        facing: Math.atan2(-backX, -backZ)
      };
    }

    const awayX = dx / dist;
    const awayZ = dz / dist;
    const kiteDist = AIConfig.archerKiteTriggerDist * 0.75;

    return {
      x: myCenter.x + awayX * kiteDist,
      z: myCenter.z + awayZ * kiteDist,
      facing: Math.atan2(-awayX, -awayZ)
    };
  }
}

// Small helper for _tryUnleash's log line — pulls the tick from worldCtx
// if available, falls back to 0. Kept as a module function rather than a
// method so it has no `this` dependency and can be reasoned about in
// isolation.
function tickForLog(worldCtx) {
  return (worldCtx && typeof worldCtx.currentTick === 'number')
    ? worldCtx.currentTick
    : 0;
}
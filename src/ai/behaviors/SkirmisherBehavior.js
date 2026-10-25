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
import { isCavalry, isRanged, getRangedRange } from '../../config/UnitClasses.js';
import { nearestUnit, centerTowardUnit, unitTypeOf } from '../behaviorUtils.js';
import { AIDebugLog } from '../AIDebugLog.js';

// Standoff buffer (world units) subtracted from the archer's own effective
// range when computing the desired distance to the nearest enemy soldier.
// The archer tries to be at (own range - this) from the enemy at all
// times, so a short-ranged variant (goblin, 12) sits at ~11 and a full
// human archer (21, but capped at the configured standoff) sits at its
// configured 13. The buffer leaves headroom inside the envelope so the
// shot does not flicker in and out of range as both formations shuffle by
// a fraction of a unit each tick.
const ARCHER_STANDOFF_BUFFER = 1.0;

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

// Fraction of this unit's own max range the nominal standoff is capped at.
// AIConfig.archerStandoffDist (13.0) is tuned against the human archer's
// 21-unit max range, so it sits comfortably inside range for that unit.
// A short-ranged variant (goblin archer, 12) would inherit a standoff
// OUTSIDE its own max range and spend the whole battle unable to fire.
// Capping at 0.9 × own-range keeps the goal inside the unit's own envelope
// regardless of which variant is asking, while leaving the human archer's
// standoff at 13.0 (13 < 21 * 0.9 = 18.9, so the min() passes through).
const STANDOFF_RANGE_FRACTION = 0.9;

// Melee enemies whose nearest soldier gets this close to an archer unit's
// center trigger the kite path. Cavalry charge threats are detected at the
// (longer) AIConfig.archerKiteTriggerDist because cavalry close faster and
// warrant earlier kiting; melee infantry close slower but become a capture
// threat inside this band. The pre-fix code never kited from melee at all
// (see _findCloseThreat), which is why archers walked into skeletons
// instead of backing off.
const MELEE_KITE_TRIGGER_DIST = 14.0;

// Distance the archer's kite goal is placed ahead of its current position,
// in the away-from-threat direction. This MUST be substantially larger
// than the movement system's "approach the goal, slow down" band. Prior
// value (archerKiteTriggerDist * 0.75, ~6-7 units) kept the archer
// permanently inside that band, so it crept along at a fraction of its
// max speed while the pursuer closed at full speed — the observed
// "archers run but still get caught" behaviour. 25 units comfortably
// exceeds any reasonable arrival radius while keeping the goal near the
// battlefield, so the archer actually flees at full pace.
const KITE_FLEE_DISTANCE = 25.0;

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

    // Engaged archers do not reposition. A reposition order on an
    // engaged unit calls Unit._clearEngagedState, which pulls the
    // soldiers out of melee with a disengage grace; the next cycle
    // they re-engage and the cycle repeats. The visible result was the
    // archer unit standing perfectly still for dozens of ticks giving
    // a fresh standoff order every decision cycle — "double ordered
    // and staggering" in playtest. The move would be a no-op anyway
    // (MovementSystem skips engaged soldiers), so the correct action
    // is to return a hold and let the melee resolve.
    for (const s of unit.getAliveSoldiers()) {
      if (s.state === 'engaged' || s.state === 'staggered') {
        return { type: 'hold' };
      }
    }

    // Defensive skirmish gate. On defence, archers do not reposition
    // until an enemy is closing on the melee line. Measured from the
    // LINE's anchor, not from the archer: the archers' job on defence
    // is to protect the line, and until the line is threatened there
    // is nothing to protect. A distant enemy walking toward the
    // archers but not the line does not trigger an advance; the
    // archers wait.
    //
    // skirmishLineRange (default 30) is well outside the human
    // archer's 21-unit reach, giving the archers a couple of seconds
    // to close to standoff while the enemy crosses the gap. On
    // offence, no gate — archers advance with the line.
    if (worldCtx && worldCtx.stance === 'defence') {
      const lineAnchor = worldCtx.infantryLineAnchor;
      if (lineAnchor &&
          !this._enemyWithinLineSkirmishRange(lineAnchor, enemyUnits)) {
        return { type: 'hold' };
      }
    }

    // Decision shape. This method returns one of:
    //
    //   { type: 'focus', targetUnitId }         — focus a specific enemy
    //                                             unit. TeamAI routes this
    //                                             through the same entry
    //                                             point the player's
    //                                             right-click uses, which
    //                                             lets the unit derive its
    //                                             own standoff from the
    //                                             enemy's live position
    //                                             and formation depth. The
    //                                             sim does not touch
    //                                             soldier combat state on
    //                                             this path, so archers
    //                                             keep firing through it.
    //
    //   { type: 'move', subKind, x, z, facing } — reposition. TeamAI issues
    //                                             this as a move order if
    //                                             the archers are between
    //                                             draws, or queues it on
    //                                             the intent if they are
    //                                             mid-draw. The queued
    //                                             order applies the
    //                                             instant the current
    //                                             volley releases.
    //
    //   { type: 'hold' }                        — no order, keep doing
    //                                             whatever the unit is
    //                                             already doing.
    //
    //   null                                    — nothing to do this
    //                                             cycle.
    //
    // The focus-vs-position split is deliberate: "advance to standoff and
    // shoot that enemy" is exactly what the player's target order does,
    // and the unit already implements it correctly — including its own
    // depth-aware standoff, which the previous hand-rolled AI standoff
    // did not. "Kite west" and "hold just forward of the line" are
    // genuinely positions and stay as move orders.

    // Escort gate. Archers advance to standoff only when covered.
    // ArcherSupportCoordinator runs before this behaviour each cycle and
    // sets intent.hasEscort according to the team's cavalry situation:
    // true when the enemy has no cavalry at all, when this archer's
    // cluster has a friendly cav assigned, or when no enemy cavalry is
    // within threat range; false otherwise. When false, the archer hugs
    // the melee line instead of advancing — it holds just forward of
    // the infantry line and lets the enemy come to it, rather than
    // walking into open ground where fast units can run it down.
    // Tether state. Two sources ORed together:
    //
    //   1. worldCtx.rangedUnderFire — team-wide. Fires when ANY friendly
    //      archer is being outranged. This is the release-everyone path:
    //      the enemy's reach advantage is a formation-level fact, so
    //      unleashing archers one at a time just gets them shot one at a
    //      time. Read first so a team that has been hit anywhere releases
    //      everyone in one decision cycle.
    //
    //   2. _isBeingOutranged(unit, ...) — per-archer fallback. Kept for
    //      callers that don't supply worldCtx (tests, direct invocation),
    //      and to guard against a stale team flag going false on the same
    //      cycle the local archer is genuinely being hit.
    //
    // The combined `beingOutranged` gates both the escort release below
    // AND the standoff hug-clamp further down, so a sallying archer
    // cannot be re-clamped back behind the line by the cavalry-cover
    // logic it just escaped.
    const teamOutranged = !!(worldCtx && worldCtx.rangedUnderFire);
    const beingOutranged = teamOutranged || this._isBeingOutranged(unit, enemyUnits);

    if (intent.hasEscort === false) {
      const canHug = !!(context && worldCtx && worldCtx.infantryLineAnchor);
      // Hug is a DEFENSIVE-stance rule — see the class docstring. An
      // attacking team pushes archers forward with the line even at the
      // risk of being caught, so on offence a no-escort archer falls
      // through to the standoff logic below rather than pinning to the
      // line. Without this gate the escort-driven hug fired on every
      // stance, which is the "archers hang back on offence" symptom:
      // ArcherSupportCoordinator revoked hasEscort (out-cav'd team),
      // and the early branch returned a hug order before the later,
      // correctly-stance-gated hugMode clamp could ever run.
      const onDefence = !!(worldCtx && worldCtx.stance === 'defence');

      if (!canHug) {
        // No formation context to hug — hold in place rather than
        // walking forward unprotected.
        return { type: 'hold' };
      }

      if (onDefence && !beingOutranged) {
        const hugOrder = this._hugInfantryLine(unit, context, worldCtx);
        if (hugOrder) {
          AIDebugLog.log('skirmish', tick,
            `unit=${unit.id} HUG no-cover goal=(${hugOrder.x.toFixed(2)},${hugOrder.z.toFixed(2)})`);
          return {
            type: 'move',
            subKind: 'hug',
            x: hugOrder.x,
            z: hugOrder.z,
            facing: hugOrder.facing
          };
        }
        return { type: 'hold' };
      }

      // Either the archers are being outranged and need to close to
      // return fire, or the team is on offence and the archers push
      // forward with the line. Both cases fall through to the standoff
      // logic below.
      if (beingOutranged) {
        AIDebugLog.log('skirmish', tick,
          `unit=${unit.id} TETHER-RELEASE outranged — sallying to return fire`);
      }
    }

    // Single positioning rule: maintain distance = own effective range
    // minus a small buffer from the nearest enemy SOLDIER. Shoot the
    // entire time.
    //
    // There is no separate "kite" trigger and no separate "standoff"
    // decision. Backing off when the enemy closes and advancing when the
    // enemy retreats are the same behavior observed from different enemy
    // positions — the archer is continuously maintaining the distance
    // that makes its shot work. A stationary enemy is treated identically
    // to an advancing one, because the archer's job is to be at a
    // specific distance from wherever the enemy currently is, regardless
    // of what the enemy intends.
    //
    // This replaces the previous two-trigger design (a close-threat kite
    // at 14 units overriding a standoff at 13 units), which oscillated on
    // the boundary: an archer standing at its own preferred standoff was
    // inside the flee radius, so every cycle it stepped back, exited the
    // radius, stepped forward, and re-entered it.
    intent.threatUnitId = null;

    const target = nearestUnit(unit, enemyUnits);
    if (!target) {
      AIDebugLog.log('skirmish', tick, `unit=${unit.id} NO_TARGET`);
      return null;
    }

    // Distance is measured to the nearest SOLDIER of the target unit,
    // not to its center. A wide melee block can have its center 13+
    // units behind its leading rank, so a center-referenced distance
    // computes goals relative to a point that has no bearing on whether
    // the shot can actually reach the enemy's front line.
    const nearestSoldier = this._nearestSoldierOf(unit, target);
    const anchorX = nearestSoldier ? nearestSoldier.pos.x : target.getCenter().x;
    const anchorZ = nearestSoldier ? nearestSoldier.pos.z : target.getCenter().z;

    const myCenter = unit.getCenter();
    const dx = myCenter.x - anchorX;
    const dz = myCenter.z - anchorZ;
    const currentDist = Math.max(0.001, Math.sqrt(dx * dx + dz * dz));
    const awayX = dx / currentDist;
    const awayZ = dz / currentDist;

    // Desired standoff: the configured archer standoff, capped below the
    // unit's own maximum range so a shorter-ranged variant (goblin
    // archer, range 12) does not inherit a standoff it cannot shoot
    // from. For goblins this gives ~11; for humans the configured 13
    // wins and the cap does not bind.
    const unitMaxRange = getRangedRange(unitTypeOf(unit));
    const standoffCap = Math.max(
      CombatConfig.rangedMinRange + 1.0,
      unitMaxRange - ARCHER_STANDOFF_BUFFER
    );
    const desired = Math.min(AIConfig.archerStandoffDist, standoffCap);

    // Position at the desired distance from the enemy soldier, along the
    // current archer-to-enemy bearing.
    let goalX = anchorX + awayX * desired;
    let goalZ = anchorZ + awayZ * desired;

    // Cavalry-cover clamp. When the assessment says our cavalry is
    // outmatched, the archer's desired position is additionally clamped
    // so it never sits forward of the melee line: the archer backs off
    // toward the line rather than out into the open. This is the same
    // defensive intent the previous "hug" mode implemented, expressed as
    // a clamp on the computed position so it composes with the distance
    // rule instead of overriding it.
    //
    // Read on DEFENSIVE stance only — the same gate the previous hug
    // branch used. An attacking team pushes archers forward with the
    // line even at the risk of being caught.
    // Suppress the forward clamp while the archer is sallying: a unit
    // released by the tether-escape above must not be re-clamped behind
    // the line by the same cavalry-cover logic it just escaped, or the
    // release is a no-op and the archer resumes hugging under fire.
    const hugMode = !beingOutranged &&
                    !!(assessment && assessment.skirmishersWithoutCavalryCover &&
                       worldCtx && worldCtx.stance === 'defence');
    if (hugMode && context && worldCtx.infantryLineAnchor) {
      const lineAnchor = worldCtx.infantryLineAnchor;
      const lateral = context.lateralOffset || 0;
      const lineX = lineAnchor.x + context.right.x * lateral;
      const lineZ = lineAnchor.z + context.right.z * lateral;
      const relX = goalX - lineX;
      const relZ = goalZ - lineZ;
      const forward = relX * context.forward.x + relZ * context.forward.z;
      const hugForwardLimit = AIConfig.skirmisherForwardHugOffset;
      if (forward > hugForwardLimit) {
        goalX = lineX + context.forward.x * hugForwardLimit;
        goalZ = lineZ + context.forward.z * hugForwardLimit;
      }
    }

    // Already at the goal: hold and shoot. A hold is a no-order — the
    // unit keeps whatever it is doing (drawing, firing) and does not
    // reset its combat state.
    const dgx = goalX - myCenter.x;
    const dgz = goalZ - myCenter.z;
    const dg = Math.sqrt(dgx * dgx + dgz * dgz);
    if (dg < AIConfig.archerStandoffTolerance) {
      return { type: 'hold' };
    }

    // Move toward the goal. Facing is toward the enemy — the archer
    // backs off without turning its back, so the front rank continues to
    // present bows to the threat and TargetingSystem keeps archers in
    // the correct firing arc.
    const facing = Math.atan2(-awayX, -awayZ);
    AIDebugLog.log('skirmish', tick,
      `unit=${unit.id} ${hugMode ? 'HUG' : 'STAND'} ` +
      `dist=${currentDist.toFixed(2)} desired=${desired.toFixed(2)} ` +
      `my=(${myCenter.x.toFixed(2)},${myCenter.z.toFixed(2)}) ` +
      `goal=(${goalX.toFixed(2)},${goalZ.toFixed(2)}) ` +
      `anchor=(${anchorX.toFixed(2)},${anchorZ.toFixed(2)}) tgt=${target.id}`);

    return {
      type: 'move',
      subKind: hugMode ? 'hug' : 'standoff',
      x: goalX,
      z: goalZ,
      facing
    };
  }

  // Fraction of this unit's living archers whose personal nearest enemy
  // sits inside the firing band [rangedMinRange, own max range] in XZ.
  //
  // Uses the same band RangedCombatSystem uses per-soldier to decide
  // whether to fire (and the same nearest-enemy convention TargetingSystem
  // uses to assign each archer its target), so the answer here matches
  // what will actually happen on the next combat tick. A soldier whose
  // nearest enemy is too far (out of own range) or too close (below
  // rangedMinRange) cannot fire and does not count.
  //
  // Max range is read through getRangedRange, NOT CombatConfig.rangedRange
  // directly — a short-ranged unit type (goblin archer) would otherwise
  // read every far-edge archer as "in range" against a threshold it cannot
  // actually fire at, hold its position, and never advance.
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

    const unitMaxRange = getRangedRange(unitTypeOf(unit));
    const minSq = CombatConfig.rangedMinRange * CombatConfig.rangedMinRange;
    const maxSq = unitMaxRange * unitMaxRange;

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

  // Nearest living soldier of `enemyUnit` to `unit`'s center, or null if
  // none. Used by both the standoff anchor and the kite direction, because
  // a wide enemy formation's unit-center position is a poor proxy for
  // "where the enemy actually is relative to me" — a 5-wide spear block
  // can have its center 13+ units behind its own leading rank.
  _nearestSoldierOf(unit, enemyUnit) {
    const my = unit.getCenter();
    let best = null;
    let bestSq = Infinity;
    for (const s of enemyUnit.getAliveSoldiers()) {
      const dx = s.pos.x - my.x;
      const dz = s.pos.z - my.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = s; }
    }
    return best;
  }

  // True when any living enemy soldier is within
  // AIConfig.skirmishLineRange of the melee line's anchor. Measures
  // against the enemy unit's nearest living SOLDIER, not its centre —
  // a wide formation's centre can be 30+ units away while its leading
  // rank is well inside the threshold, and the archer cares about the
  // rank, not the centroid.
  //
  // The anchor comes from worldCtx.infantryLineAnchor, which TeamAI
  // recomputes every decision cycle from the living melee line's mean.
  // Same value SkirmisherBehavior already reads for the hug position —
  // no new state, no separate tracking.
  //
  // Called once per decision cycle per archer unit on defence. Cost is
  // O(ownArchers × enemySoldiers), same order as _firingFraction which
  // runs on the same cadence.
  _enemyWithinLineSkirmishRange(lineAnchor, enemyUnits) {
    const range = AIConfig.skirmishLineRange ?? 30.0;
    const rangeSq = range * range;
    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      for (const s of enemy.getAliveSoldiers()) {
        const dx = s.pos.x - lineAnchor.x;
        const dz = s.pos.z - lineAnchor.z;
        if (dx * dx + dz * dz <= rangeSq) return true;
      }
    }
    return false;
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

    // Per-unit range, not the global. The unleash bubble's RADIUS scales
    // with the archer's own reach — a short-ranged variant has a smaller
    // bubble because a target further out than its own range is not a
    // target it can advance on and shoot anyway.
    const unitMaxRange = getRangedRange(unitTypeOf(unit));
    const unleashRadius = unitMaxRange * AIConfig.skirmisherUnleashRangeMult;
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

    // Already in firing range of the focus target: hold where we are and
    // shoot. Returned as a hold decision — not a move order, not null —
    // so the caller does NOT fall through to the hug rule and pull the
    // archers back out of range. That fall-through was the advance/hug
    // oscillation the previous no-op move order was written to prevent.
    if (dist <= unitMaxRange) {
      return { type: 'hold' };
    }

    // Out of range, but inside the bubble: focus the target and let the
    // unit's own standoff logic march the formation into range. This is
    // the same code path the player's right-click uses, and unlike the
    // previous hand-rolled firing position it correctly accounts for the
    // archer formation's own depth — a wide formation's back rank is
    // further from the enemy than its front rank, and the unit's standoff
    // math is the only thing that knows to compensate.
    AIDebugLog.log('skirmish', tickForLog(worldCtx),
      `unit=${unit.id} UNLEASH target=${focusId} dist=${dist.toFixed(2)} ` +
      `(deferring to focus order)`);
    return { type: 'focus', targetUnitId: focusId };
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

// True when at least one enemy ranged unit can hit this archer's
  // position from beyond this archer's own reach. This is the predicate
  // that drives the tether release: the archer is under fire it cannot
  // answer, so the no-cover hug must yield to a return-fire advance.
  //
  // Uses the same nearest-soldier measurement the standoff logic uses
  // (see _nearestSoldierOf), so "can they reach us" and "can we reach
  // them" are answered against the same geometry the archer will
  // actually shoot from next combat tick.
  //
  // Returns false when the archer has no ranged capability of its own,
  // when no enemy is ranged, or when any enemy ranged unit is inside
  // our own range (in which case the archer is already able to trade
  // and does not need a special advance).
  _isBeingOutranged(unit, enemyUnits) {
    const type = unitTypeOf(unit);
    if (!type) return false;
    const myRange = getRangedRange(type);
    if (myRange <= 0) return false;

    const myCenter = unit.getCenter();

    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      const et = unitTypeOf(enemy);
      if (!et || !isRanged(et)) continue;
      const enemyRange = getRangedRange(et);

      const nearest = this._nearestSoldierOf(unit, enemy);
      if (!nearest) continue;

      const dx = nearest.pos.x - myCenter.x;
      const dz = nearest.pos.z - myCenter.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      // Enemy can reach us; we cannot reach them. Outranged.
      if (dist > myRange && dist <= enemyRange) return true;
    }
    return false;
  }

// Returns the nearest enemy unit that currently constitutes a close
  // threat to this archer unit, or null. Two threat classes:
  //
  //   - CAVALRY: moving fast (>= archerChargeThreatSpeed) and within the
  //     longer AIConfig.archerKiteTriggerDist. Unchanged from the previous
  //     _findChargeThreat — cavalry close fast and must be kited early.
  //
  //   - MELEE: not cavalry, not ranged, not mostly routing, and its
  //     NEAREST SOLDIER is within MELEE_KITE_TRIGGER_DIST. New. The old
  //     code returned null for these units entirely, so archers sat in
  //     FIRING_HOLD while a skeleton block walked on top of them — see
  //     the archer-capture bug.
  //
  // Distance is measured to the enemy unit's NEAREST SOLDIER, not its
  // center. A wide melee block can have its center 13+ units away while
  // its leading rank is 4 units away; a center-distance check misses the
  // threat until the archers are already in melee range.
  //
  // Enemy ranged units are deliberately skipped: trading volleys with
  // opposing archers is the archer's job, not a reason to kite.
  _findCloseThreat(unit, enemyUnits) {
    const myCenter = unit.getCenter();
    let closest = null;
    let closestDistSq = Infinity;

    const cavTriggerSq = AIConfig.archerKiteTriggerDist * AIConfig.archerKiteTriggerDist;
    const meleeTriggerSq = MELEE_KITE_TRIGGER_DIST * MELEE_KITE_TRIGGER_DIST;

    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      const alive = enemy.getAliveSoldiers();
      if (alive.length === 0) continue;

      const sample = alive[0];
      const typeDef = sample.unitTypeDef;
      if (!typeDef) continue;

      // Skip enemy ranged units — archers trade volleys with archers.
      if (isRanged(typeDef)) continue;

      // Skip mostly-routing enemies: a fleeing soldier is not a threat.
      let routingCount = 0;
      for (const s of alive) if (s.isRouting) routingCount++;
      if (routingCount / alive.length >= 0.5) continue;

      // Nearest soldier of this enemy unit to the archer unit's center.
      let nearestSq = Infinity;
      for (const s of alive) {
        const dx = s.pos.x - myCenter.x;
        const dz = s.pos.z - myCenter.z;
        const d = dx * dx + dz * dz;
        if (d < nearestSq) nearestSq = d;
      }

      if (isCavalry(typeDef)) {
        let speedSum = 0;
        for (const s of alive) speedSum += s.currentSpeed;
        const avgSpeed = speedSum / alive.length;
        if (avgSpeed < toSimSpeed(AIConfig.archerChargeThreatSpeed)) continue;
        if (nearestSq > cavTriggerSq) continue;
      } else {
        // Melee (or non-standard) threat — check the (shorter) melee band.
        if (nearestSq > meleeTriggerSq) continue;
      }

      if (nearestSq < closestDistSq) {
        closestDistSq = nearestSq;
        closest = enemy;
      }
    }

    return closest;
  }

// Returns a no-op move order if any of this unit's living archers are
  // currently mid-volley ('ranged' state), or null if none are. Used by
  // decide() to gate kiting: an archer that has started drawing should
  // finish that draw and loose before running.
  //
  // "No-op" is deliberate: an order whose destination is the unit's
  // current position (distance 0 < the Unit.issueMoveOrder no-op
  // threshold of 0.5) does NOT clear the 'ranged' state, so firing
  // continues uninterrupted. Returning null here would let the kite
  // path run and cancel the draw.
  //
  // The check is per-soldier: an archer unit is a formation of
  // individual shooters, and RangedCombatSystem fires each soldier on
  // its own cooldown. If ANY soldier is drawing, the whole unit holds
  // this cycle. If NO soldier is drawing (all are between shots, or
  // none has a target), the caller may proceed to kite.
  _holdIfMidVolley(unit) {
    for (const s of unit.getAliveSoldiers()) {
      if (s.state === 'ranged') {
        const c = unit.getCenter();
        return { x: c.x, z: c.z, facing: unit.formationFacing };
      }
    }
    return null;
  }

// Kite directly away from the threat's NEAREST SOLDIER, not its unit
  // center. Same reason as the standoff anchor (see _nearestSoldierOf):
  // a wide enemy block's center can be 13+ units from us while its
  // leading rank is 4 units away, so a center-referenced "away" vector
  // bears no relation to where the threatening soldiers actually are.
  //
  // The goal is placed FAR ahead (KITE_FLEE_DISTANCE), not at the
  // archer's current position + a short offset. The movement system
  // decelerates a unit approaching its goal — a goal only a few units
  // ahead keeps the archer in that slowdown band, so it creeps along at
  // a fraction of max speed while the pursuer closes at full pace.
  // Anchoring the goal to the archer's own current position made this
  // permanent: the goal moved with the archer, the gap never grew, and
  // the archer never accelerated. Fleeing to a distant point removes
  // the deceleration entirely; the goal is re-issued every decision
  // cycle, so as long as the close-threat trigger is firing, the archer
  // keeps running at full speed.
  _kiteFrom(unit, threatUnit, context) {
    const myCenter = unit.getCenter();

    const nearest = this._nearestSoldierOf(unit, threatUnit);
    const tx = nearest ? nearest.pos.x : threatUnit.getCenter().x;
    const tz = nearest ? nearest.pos.z : threatUnit.getCenter().z;

    const dx = myCenter.x - tx;
    const dz = myCenter.z - tz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.001) {
      const backX = context ? -context.forward.x : 0;
      const backZ = context ? -context.forward.z : 1;
      return {
        x: myCenter.x + backX * KITE_FLEE_DISTANCE,
        z: myCenter.z + backZ * KITE_FLEE_DISTANCE,
        facing: Math.atan2(-backX, -backZ)
      };
    }

    const awayX = dx / dist;
    const awayZ = dz / dist;

    return {
      x: myCenter.x + awayX * KITE_FLEE_DISTANCE,
      z: myCenter.z + awayZ * KITE_FLEE_DISTANCE,
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
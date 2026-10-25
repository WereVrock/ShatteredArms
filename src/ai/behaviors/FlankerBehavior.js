// ===== src/ai/behaviors/FlankerBehavior.js =====
// Cavalry behavior.
//
// Charge philosophy: cavalry charges from any distance (a far charge
// disrupts archers and lines and punishes mistakes). When the charge target
// turns out to be protected (corridor / brace refusal), the cav looks at
// EVERY other legal target for a clean opportunity right now; if there is
// none it goes back to its flank position and waits there. Every abort path
// returns an order immediately — returning null from an abort leaves the
// unit coasting on its previous charge order into the spears.
//
// Routing-aware: a routing enemy unit within cavalryRoutingChaseRadius is
// preferred over normal soft-target scoring entirely — these are the
// cheapest kills on the field.
//
// A3: sibling coordination is GROUP-based. TeamAI builds one CavalryGroup
// per flank cluster (see CavalryGroup.js) and passes THIS unit's group in.
// A follower defers to its group leader's target unless it has a strictly
// better local option.
import { AIConfig } from '../../config/AIConfig.js';
import { CombatConfig } from '../../config/CombatConfig.js';
import { toSimSpeed } from '../../config/SpeedScale.js';
import { isCavalry, isRanged, getRangedRange } from '../../config/UnitClasses.js';
import { centerTowardUnit, unitTypeOf } from '../behaviorUtils.js';
import { ChargeReadiness } from '../ChargeReadiness.js';
import { AIDebugLog } from '../AIDebugLog.js';
import { WeightedSelect } from '../WeightedSelect.js';

// Convergence radius for the pure-cavalry mass charge. When the team has
// no melee line and no ranged units, all cavalry converge to within this
// distance of their shared centroid before committing to a charge. Keeps
// a spread formation from arriving piecemeal and being defeated in
// detail by a stationary defender. Overridable via
// AIConfig.massChargeConvergenceRadius — the fallback matches the
// typical width of a 3-unit cavalry wing.
const MASS_CHARGE_CONVERGENCE_RADIUS_FALLBACK = 6.0;

// A target that survived this many failed charge attempts is skipped...
const MAX_SOLO_ATTEMPTS = 2;
// ...but only until this long after the most recent regroup (~30s at 15Hz),
// so a target that becomes genuinely open later is not blacklisted forever.
const ATTEMPT_FORGIVE_TICKS = 450;
// After an approach-abort, the protected target is off-limits this long.
// Overridable via AIConfig.cavalryAbortedTargetCooldownTicks.
const DEFAULT_BLOCK_COOLDOWN_TICKS = 300;
// How many alternative targets get a ChargeReadiness assessment per
// "look for another opportunity" pass. Overridable via
// AIConfig.cavalryMaxAlternativesAssessed.
const DEFAULT_MAX_ALTERNATIVES = 4;

export class FlankerBehavior {
  // group: this unit's CavalryGroup (always contains at least this unit).
  // objectiveUnit: WinPlanner's current shared team objective, or null.
  decide(unit, enemyUnits, context, intent, assessment, worldCtx, group, objectiveUnit) {
    // C3: posture leniency for ChargeReadiness. assessment may be null very
    // early (before first _updateAssessment); leniency 0 there reproduces
    // pre-C3 behavior exactly.
    const leniency = (assessment && assessment.posture === 'press')
      ? (worldCtx.postureChargeLeniency || 0)
      : 0;

    switch (intent.phase) {
      case 'committed':
        return this._decideCommitted(unit, enemyUnits, intent, worldCtx, leniency, context);
      case 'regrouping':
        return this._decideRegrouping(unit, intent, worldCtx, context);
      case 'seeking':
      default:
        return this._decideSeeking(unit, enemyUnits, context, intent, worldCtx, group, objectiveUnit, leniency);
    }
  }

  _decideSeeking(unit, enemyUnits, context, intent, worldCtx, group, objectiveUnit, leniency) {
    const tick = worldCtx.currentTick;

    // Router-chase priority. Runs before the melee check and the normal
    // target selection so routers bypass the friendly-support gate in
    // _isValidCavalryTarget — routers flee away from the line by
    // definition, and the support gate would exclude exactly the units
    // cav should run down. Tiers differ on the depth of the check:
    // weakened tier uses the corridor check alone, best-possible runs
    // the full seven-check gate. See _tryRouterChase.
    const chaseResult = this._tryRouterChase(unit, enemyUnits, intent, worldCtx);
    if (chaseResult && chaseResult.order) return chaseResult.order;
    // A rejected router must be excluded from the normal candidate pool
    // below — otherwise _nearestRouting picks the same router back up
    // and the gate's refusal is silently undone by the general picker.
    const rejectedRouterId = chaseResult ? chaseResult.rejectedRouterId : null;

    // A cavalry unit that has entered melee while in seeking phase — usually
    // because a commit timeout released it from a charge that had already
    // closed to contact — cannot meaningfully seek a new target: the nearest
    // enemy is the one currently hitting it. Regroup, and issue the retreat
    // order in the same cycle.
    if (unit.getAliveSoldiers().some(s => s.isInMelee())) {
      AIDebugLog.regroup(tick, unit.id, 'seeking-in-melee-forcing-regroup');
      return this._enterRegroup(unit, intent, worldCtx, context, intent.targetUnitId);
    }

    // Pure-cavalry teams mass-charge and ignore the blocked-target logic
    // (there is no better moment to wait for).
    const massCharge = this._shouldMassCharge(worldCtx);
    const excluded = massCharge ? new Set() : this._excludedTargetIds(intent, tick, worldCtx);
    // Router rejected by the gate this cycle: exclude it from every
    // downstream candidate path (objective check, _nearestRouting,
    // _pickFlankTarget, _findCleanAlternative). It becomes eligible
    // again next cycle, when _tryRouterChase re-evaluates it from
    // scratch — a fresh roll of the seven-check gate against fresh
    // power ratios, not an inherited rejection.
    if (rejectedRouterId) excluded.add(rejectedRouterId);
    const pool = excluded.size > 0
      ? enemyUnits.filter(e => !excluded.has(e.id))
      : enemyUnits;

    // Primary candidate. Priority order:
    //   1. Routing chase — the cheapest kill on the field.
    //   2. WinPlanner's shared objective if it passes the validity filter.
    //   3. Independent soft-target scoring.
    let candidate = null;
    const routingCandidate = this._nearestRouting(unit, pool);
    if (routingCandidate &&
        this._isValidCavalryTarget(routingCandidate, unit, worldCtx)) {
      candidate = routingCandidate;
    } else if (objectiveUnit && !objectiveUnit.isDefeated() &&
        !excluded.has(objectiveUnit.id) &&
        this._isValidCavalryTarget(objectiveUnit, unit, worldCtx)) {
      candidate = objectiveUnit;
    } else {
      candidate = this._pickFlankTarget(unit, pool, group, null, worldCtx);
    }

    // Nothing to attack right now. If this cav has been assigned to
    // protect an archer cluster by ArcherSupportCoordinator, do escort
    // duty instead of walking back to the flank slot. The escort is a
    // fallback: it only runs when normal seeking found nothing to
    // commit to. The moment a target presents itself above, that target
    // wins and the escort is effectively dropped for this cycle — the
    // coordinator will notice the cav is now busy and reassign cover
    // next cycle if needed.
    if (!candidate) {
      if (intent.escortArcherUnitIds && intent.escortThreatUnitId) {
        const escortOrder = this._decideEscort(unit, intent, worldCtx);
        if (escortOrder) return escortOrder;
      }
      return this._waitAtPosition(unit, context, worldCtx);
    }

    // Note: there is NO seek-to-commit range gate here. The cav commits
    // to whatever target the seeking phase selected, regardless of
    // distance. The previous gate refused the commit and walked to the
    // flank slot instead — but the flank slot only closes at the LINE's
    // speed (it is computed from the team anchor, which advances with
    // the infantry), so a cav parked there closes on a stationary
    // archer at ~infantry speed, spending many multiples of the travel
    // time the cav would have taken on its own. See the playtest log
    // showing cav stuck at "walking to flank slot" from t0 to t810.
    //
    // The "don't commit to a target that's too far to reach" concern is
    // instead handled on the COMMITTED path: _decideCommitted
    // re-evaluates a committed target still beyond
    // cavalryMaxCommitRange and re-commits to a strictly closer clean
    // target if one exists. This preserves the "long march during which
    // the situation changes" safety without freezing cav at the flank
    // slot whenever a distant target is open.
    //
    // ChargeReadiness still caps its own projection horizon at 90 ticks
    // (for the brace-in-time question it answers), so a distant target
    // still reads as clean — that is fine now: the cav closes, and the
    // committed-phase re-check (see below) catches any target that
    // stays out of range.

    // Mass-charge branch: skip ChargeReadiness entirely, converge on the
    // group centroid, then commit. See _shouldMassCharge for why.
    if (massCharge) {
      const staging = this._massChargeStaging(unit, worldCtx);
      if (staging) return staging;

      const { dist } = centerTowardUnit(unit, candidate);
      AIDebugLog.chargeCommit(tick, unit.id, candidate.id, dist);
      intent.commitTo(candidate.id, tick, 0, dist);
      return this._approachOrCharge(unit, candidate, intent, worldCtx);
    }

    // --- Escort-aware commit gate ---
    // When this cav has been assigned to protect an archer cluster, the
    // bar for abandoning that duty is high. Escort is the assignment,
    // not a fallback — a marginal charge is not a reason to walk off
    // and get killed while the archers go uncovered. Two checks, in
    // cost order:
    //   1. If our ranged power dominates the enemy, our archers ARE the
    //      win condition, so the cav's value is protecting them, not
    //      trading itself for a soft target.
    //   2. If unengaged enemy spears/cavalry can reach the target
    //      before we do, the charge will hit a wall the corridor check
    //      doesn't see — a wall that isn't there yet.
    // Either failing → stay on escort.
    if (intent.escortArcherUnitIds && candidate) {
      const verdict = this._escortCommitGate(unit, candidate, enemyUnits, worldCtx);
      if (!verdict.allow) {
        // Primary blocked. Before falling back to escort standby, look
        // for an alternative that DOES pass the escort gate — most
        // importantly an exposed archer unit the cav can punish
        // without abandoning its cluster for long. The alternative
        // finder runs the same escort gate on each candidate, so an
        // alternative only wins if it satisfies the same strictness.
        const tried = new Set([candidate.id]);
        const alt = this._findEscortCleanAlternative(unit, enemyUnits, tried, worldCtx);
        if (alt) {
          AIDebugLog.log('charge', tick,
            `cav=${unit.id} ESCORT-SWITCH ${candidate.id} → ${alt.target.id} (blocked: ${verdict.reason})`);
          candidate = alt.target;
        } else {
          AIDebugLog.log('charge', tick,
            `cav=${unit.id} ESCORT-HOLD target=${candidate.id} reason="${verdict.reason}"`);
          const escortOrder = this._decideEscort(unit, intent, worldCtx);
          if (escortOrder) return escortOrder;
          return this._waitAtPosition(unit, context, worldCtx);
        }
      }
    }

    // --- Defensive commit range ---
    // On defensive stance, the cav does not wander far from the line.
    // Base cap is _effectiveSeekCommitRange (half the offence cap,
    // lifted only for close threats or when the line is dead).
    //
    // Extended range: on defence, a target beyond the base cap can
    // still be charged up to cavalryDefensiveExtendedRange (30), but
    // ONLY if the time-window check passes — the same check the escort
    // gate uses. "There is a window between me and the target where
    // no unengaged spear or cav arrives before I do" is a real
    // opportunity, and refusing it just because the stance is
    // defensive is the SKIP-TOO-FAR spam in the log. Beyond 30 units
    // the cav holds regardless — at that distance the target has too
    // much time to change shape for the window estimate to mean
    // anything.
    //
    // Seeking has no range gate on OFFENCE — the cav commits to
    // whatever the seeking phase selected, regardless of distance, as
    // it did before the range gate existed. Distant targets close at
    // cav speed instead of line speed, and the committed-phase re-check
    // (see _decideCommitted's max-commit-range re-target) handles the
    // "spent a whole fight walking there" case without freezing the
    // unit at the flank slot.
    //
    // On DEFENCE the cav is capped: base defensive range (half the
    // offence cap) for normal charges, extended range (30) if the
    // time-window check is clean. The cap is a defensive-posture rule,
    // not a targeting rule — it says "don't wander far from the line
    // while on defence", not "this target is too far to charge".
    //
    // Extended-range charges are not gated on escort — the time window
    // is the gate. An exposed target 25 units away being chargeable
    // does not make the escort cluster less safe than it was before.
    if (worldCtx && worldCtx.stance === 'defence') {
      const { dist: seekDist } = centerTowardUnit(unit, candidate);
      const baseRange = this._effectiveSeekCommitRange(unit, candidate, worldCtx);
      const extendedRange = AIConfig.cavalryDefensiveExtendedRange ?? 30;

      let allow = seekDist <= baseRange;
      if (!allow && seekDist <= extendedRange) {
        const window = this._commitTimeWindow(unit, candidate, enemyUnits, worldCtx);
        if (window.clean) {
          allow = true;
          AIDebugLog.log('charge', tick,
            `cav=${unit.id} DEF-EXT-RANGE target=${candidate.id} dist=${seekDist.toFixed(1)} window clean — committing`);
        } else {
          AIDebugLog.log('charge', tick,
            `cav=${unit.id} SKIP-TOO-FAR target=${candidate.id} dist=${seekDist.toFixed(1)} window="${window.reason}"`);
        }
      } else if (!allow) {
        AIDebugLog.log('charge', tick,
          `cav=${unit.id} SKIP-TOO-FAR target=${candidate.id} dist=${seekDist.toFixed(1)}>${extendedRange.toFixed(1)}`);
      }

      if (!allow) {
        if (intent.escortArcherUnitIds) {
          const escortOrder = this._decideEscort(unit, intent, worldCtx);
          if (escortOrder) return escortOrder;
        }
        return this._waitAtPosition(unit, context, worldCtx);
      }
    }

    let target = candidate;
    let bracedCount = 0;

    if (AIConfig.cavalryRequireCleanCharge) {
      const readiness = ChargeReadiness.assess(unit, candidate, enemyUnits, leniency, worldCtx);
      AIDebugLog.chargeDecision(tick, unit.id, candidate.id, readiness.willLandClean, readiness.reason);

      if (readiness.willLandClean) {
        bracedCount = readiness.bracedCount;
      } else {
        // Protected. Check EVERY other legal target (routing > ranged >
        // other, nearest first) and take the first one that is clean.
        const tried = new Set(excluded);
        tried.add(candidate.id);
        const alt = this._findCleanAlternative(unit, enemyUnits, tried, worldCtx, leniency);
        if (!alt) {
          AIDebugLog.chargeAbort(tick, unit.id,
            `no clean charge on ${candidate.id} or any alternative — waiting at position`);
          return this._waitAtPosition(unit, context, worldCtx);
        }
        AIDebugLog.log('charge', tick,
          `cav=${unit.id} switching to alternative target=${alt.target.id} (blocked on ${candidate.id}, reason="${readiness.reason}")`);
        target = alt.target;
        bracedCount = alt.readiness.bracedCount;
      }
    } else {
      bracedCount = ChargeReadiness.assess(unit, target, enemyUnits, 0, worldCtx).bracedCount;
    }

    const { dist } = centerTowardUnit(unit, target);
    if (dist <= 0.0001) return null;
    AIDebugLog.chargeCommit(tick, unit.id, target.id, dist);
    intent.commitTo(target.id, tick, bracedCount, dist);
    return this._approachOrCharge(unit, target, intent, worldCtx);
  }

// Escort commit gate. Called only when this cav has an escort
  // assignment and is about to commit to a charge. Returns
  // { allow: bool, reason: string }. Reason is for the debug log only —
  // no caller branches on it.
  //
  // Two checks, in cheapest-first order:
  //
  //   1. Team ranged dominance. If our archers out-shoot the enemy's
  //      by escortRangedPowerDominanceRatio (default 2.0), the archers
  //      are the win condition. The cav's value is keeping them alive,
  //      not trading itself for a soft target. Standing order: stay.
  //
  //   2. Time-window analysis. Will unengaged enemy spears or cavalry
  //      reach the target before or around when we do? If yes, the
  //      charge walks into reinforcements the corridor check can't
  //      see (they aren't on the path yet). See _commitTimeWindow.
  //      If no meaningful window exists, stay on escort.
  //
  // Both fail-closed: any doubt → escort. The whole point is that this
  // cav is doing something else when the checks fire, and the archers
  // it was protecting pay the price if it makes a bad call.
  _escortCommitGate(unit, candidate, enemyUnits, worldCtx) {
    if (this._teamRangedPowerDominant(worldCtx)) {
      return { allow: false, reason: 'team-ranged-dominant' };
    }
    // Exposed-ranged bypass. A naked archer unit — one with no living
    // melee unit within escortExposedArcherClearRadius — cannot brace,
    // cannot be covered in time, and cannot present a wall. The
    // time-window analysis is the wrong question for it: there is no
    // wall to arrive. Charging it is a strike-and-bounce, and holding
    // the cav in escort standby while an archer unit walks around
    // unsupported is exactly the "cav doing nothing" failure the user
    // has been seeing.
    if (this._isExposedRangedTarget(candidate, enemyUnits)) {
      return { allow: true, reason: 'exposed-ranged' };
    }
    const window = this._commitTimeWindow(unit, candidate, enemyUnits, worldCtx);
    if (!window.clean) {
      return { allow: false, reason: window.reason };
    }
    return { allow: true, reason: 'ok' };
  }

  // True when the candidate is a ranged unit with no non-routing
  // melee-class enemy within escortExposedArcherClearRadius of it.
  // Other ranged units do NOT count as cover — they cannot brace a
  // charge and don't stop the cav from landing one. Only melee
  // units (spears and swords) count.
  _isExposedRangedTarget(candidate, enemyUnits) {
    const t = unitTypeOf(candidate);
    if (!t || !isRanged(t)) return false;
    const clearRadius = AIConfig.escortExposedArcherClearRadius ?? 8;
    const clearSq = clearRadius * clearRadius;
    const cc = candidate.getCenter();
    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      if (enemy.id === candidate.id) continue;
      const et = unitTypeOf(enemy);
      if (!et) continue;
      if (isRanged(et)) continue;   // archers don't brace charges
      if (isCavalry(et)) continue;  // cav counter-charge is covered by time window
      const alive = enemy.getAliveSoldiers().filter(s => !s.isRouting);
      if (alive.length === 0) continue;
      const ec = enemy.getCenter();
      const dx = ec.x - cc.x;
      const dz = ec.z - cc.z;
      if (dx * dx + dz * dz <= clearSq) return false;
    }
    return true;
  }

  // Is our ranged power at least escortRangedPowerDominanceRatio times
  // the enemy's? Empty enemy ranged → trivially true (no one to shoot
  // back). Zero own ranged → false: if we have no archers, there is no
  // "team ranged dominance" to protect.
  //
  // Reads getRangedPower, same method TeamAI and RangedPressureDetector
  // use, so the definition of "ranged power" is consistent across the
  // codebase by construction.
  _teamRangedPowerDominant(worldCtx) {
    if (!worldCtx ||
        !Array.isArray(worldCtx.teamUnits) ||
        !Array.isArray(worldCtx.enemyUnits)) {
      return false;
    }
    let own = 0, enemy = 0;
    for (const u of worldCtx.teamUnits) {
      if (u.isDefeated()) continue;
      own += u.getRangedPower();
    }
    if (own <= 0) return false;
    for (const u of worldCtx.enemyUnits) {
      if (u.isDefeated()) continue;
      enemy += u.getRangedPower();
    }
    if (enemy <= 0) return true;
    const ratio = AIConfig.escortRangedPowerDominanceRatio ?? 2.0;
    return own >= enemy * ratio;
  }

  // Time-window analysis. Answers: is there a window in which this cav
  // can reach its target and finish the charge before unengaged enemy
  // spears or cavalry arrive at the same spot?
  //
  // Returns { clean: bool, reason: string, cavTime?: number }.
  //   clean — true when no threat beats us there (with margin).
  //   reason — the first threat that failed us, or 'window-open' /
  //            'no-speed' / etc. For the debug log only.
  //
  // Measures straight-line travel time for both sides using baseMoveSpeed
  // through toSimSpeed, the same sim-space conversion used everywhere
  // else. Does NOT model intervening terrain, formations, or the actual
  // path shape — the question is a coarse "is there room for this?" not
  // a precise prediction.
  //
  // Threat scope: unengaged spears (they can brace a charge) and
  // cavalry (they can counter-charge or intercept). Swords and archers
  // are excluded — swords don't beat a charge the way spears do, and
  // archers are already accounted for by ChargeReadiness.
  //
  // Margin: the threat must arrive at least (1 - margin) later than us
  // to be tolerated. With margin 0.8, a threat arriving in 8s against
  // our 10s is refused (8 <= 10 * 0.8 = 8), a threat arriving in 9s is
  // allowed (9 > 8). This gives us a real head start, not a photo
  // finish, because the charge itself takes additional time after the
  // cav arrives.
  // Time-window analysis, with a pessimistic assumption about the
  // target's behaviour: the target is assumed to RUN TOWARD the
  // defender. This is the worst case for the cav — it stretches the
  // cav's effective chase (target flees away from cav, so closing
  // speed drops) and shortens the defender's effective approach
  // (target closes on defender, so combined speed rises). If the
  // window still reads clean under this assumption, it's clean in
  // reality too. If it reads dirty, the cav holds — a false negative
  // costs one cycle of hesitation, a false positive costs the unit.
  //
  // Effective speeds:
  //   cav → target closing:  cavSpeed - targetSpeed   (target flees)
  //   defender → target:     defSpeed + targetSpeed   (target approaches)
  //
  // The target's speed is read from its own typeDef via toSimSpeed,
  // the same conversion every other speed read in this file uses.
  // Routing targets are not special-cased — a routing unit still has a
  // typeDef speed, and the "assume it runs" pessimism applies whether
  // it runs from fear or from manoeuvre.
  //
  // Degenerate: if the target is faster than the cav (cav closing
  // speed <= 0), the cav never catches. Not-clean, always.
  // Average effective move speed of a unit's living non-routing
  // soldiers, converted to SIM space. This is the speed the unit is
  // actually capable of in the current battle — it already includes the
  // per-type modifier, the equipment modifier, and the race multiplier,
  // and is then scaled by movement.globalSpeedScale to match what the
  // MovementSystem will deliver this tick.
  //
  // THE globalSpeedScale MULTIPLICATION IS THE WHOLE POINT. The previous
  // code used toSimSpeed(typeDef.baseMoveSpeed), which reads the type's
  // raw design speed and converts units — but does NOT apply the sim's
  // global speed scale. Every sim movement is scaled down by that
  // factor; the previous formula assumed the cav moved at ~1.67x its
  // real pace, and the time-window check therefore approved charges the
  // unit could not physically complete in the forecast time.
  //
  // Falls back to the type's raw sim speed when no living soldiers are
  // available (a defeated unit should not be issuing this call, but the
  // fallback keeps the function total).
  _effectiveUnitSpeed(unit) {
    const typeDef = unitTypeOf(unit);
    const fallback = typeDef ? toSimSpeed(typeDef.baseMoveSpeed) : 2.6;
    const alive = unit.getAliveSoldiers().filter(s => !s.isRouting);
    if (alive.length === 0) return fallback;
    let speedSum = 0;
    for (const s of alive) speedSum += s.effectiveMoveSpeed;
    const avg = speedSum / alive.length;
    return avg * CombatConfig.movement.globalSpeedScale;
  }

  _commitTimeWindow(unit, target, enemyUnits, worldCtx) {
    if (!Array.isArray(enemyUnits) || enemyUnits.length === 0) {
      return { clean: true, reason: 'no-enemies' };
    }
    const cavSpeed = this._effectiveUnitSpeed(unit);
    if (!(cavSpeed > 0)) return { clean: false, reason: 'no-speed' };

    // Target's assumed flee speed, in the same SIM-space units as the
    // cav's. Uses the same helper so target, cav, and defenders are all
    // measured on the same ruler — the earlier code mixed raw design
    // speed (cav) with nothing (target), which produced an apples-to-
    // oranges comparison in the cav's favour.
    const targetSpeed = this._effectiveUnitSpeed(target);

    const cavCenter = unit.getCenter();
    const tgtCenter = target.getCenter();
    const cavDist = Math.sqrt(
      (tgtCenter.x - cavCenter.x) ** 2 +
      (tgtCenter.z - cavCenter.z) ** 2
    );
    if (cavDist < 0.001) return { clean: true, reason: 'degenerate' };

    const cavClosing = cavSpeed - targetSpeed;
    if (!(cavClosing > 0)) {
      return {
        clean: false,
        reason: `target-faster-than-cav(${cavSpeed.toFixed(2)}-${targetSpeed.toFixed(2)}<=0)`
      };
    }
    const cavTimeToTarget = cavDist / cavClosing;

    // No threat-radius filter. A fixed radius around the TARGET was the
    // bug: a spear 23 units from the target was skipped even though it
    // would arrive 16 seconds before a cav 30 units out (see t255 in the
    // reference log — DEF-EXT-RANGE commit into a spear that was already
    // closing on the target). Every spear/cav on the field is now
    // evaluated by the arithmetic below; a far threat produces a large
    // threatTime and clears the lead check on its own, so no prefilter
    // is needed. Cost is bounded by enemyUnits size, which is small.
    //
    // Flat lead-time buffer, in seconds. The cav must arrive at least
    // this many sim-seconds before any defender threat. A multiplier
    // margin scaled proportionally with distance — a 40-second charge
    // demanded an 8-second lead, a 4-second charge demanded 0.8s, which
    // is the wrong shape. The point of the buffer is to cover charge
    // commitment + impact resolution, which take roughly fixed time
    // regardless of how far the approach was.
    const leadSeconds = AIConfig.escortCommitLeadSeconds ?? 5;

    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;
      if (enemy.id === target.id) continue;
      const et = unitTypeOf(enemy);
      if (!et) continue;

      const isSpear = et.weaponType === 'spear';
      const isCav = !!isCavalry(et);
      if (!isSpear && !isCav) continue;

      // Unengaged, non-routing. An engaged spear can't turn; a routing
      // one isn't a threat.
      const alive = enemy.getAliveSoldiers().filter(s => !s.isRouting);
      if (alive.length === 0) continue;
      let engaged = false;
      for (const s of alive) {
        if (s.isInMelee()) { engaged = true; break; }
      }
      if (engaged) continue;

      const ec = enemy.getCenter();
      const dx = ec.x - tgtCenter.x;
      const dz = ec.z - tgtCenter.z;
      const threatDist = Math.sqrt(dx * dx + dz * dz);

      const threatSpeed = this._effectiveUnitSpeed(enemy);
      if (!(threatSpeed > 0)) continue;
      // Defender closes on the target, and the target closes on the
      // defender — combined speed.
      const threatClosing = threatSpeed + targetSpeed;
      const threatTime = threatDist / threatClosing;

      // Cav must beat the defender by at least leadSeconds. Expressed
      // directly: (defender's time) - (cav's time) >= leadSeconds. If
      // the defender is going to arrive at 8s and the cav at 4s, the
      // lead is 4s — refused. If defender at 12s and cav at 4s, lead is
      // 8s — allowed.
      const lead = threatTime - cavTimeToTarget;
      if (lead < leadSeconds) {
        return {
          clean: false,
          reason: `${isSpear ? 'spear' : 'cav'}-${enemy.id}-lead-only-${lead.toFixed(1)}s(${leadSeconds}s required, defender=${threatTime.toFixed(1)}s cav=${cavTimeToTarget.toFixed(1)}s)`
        };
      }
    }

    return { clean: true, reason: 'window-open', cavTime: cavTimeToTarget };
  }

  // Effective max commit distance for this cav toward this target under
  // the current stance. On defence, capped at
  // AIConfig.cavalryDefensiveCommitRange (default = half base commit
  // range). The cap is lifted in three cases:
  //
  //   1. Not on defence (offence / no stance) — no cap.
  //   2. No living friendly line units — the late-battle case. If the
  //      line is dead, capping the range would strand the cav with no
  //      valid target: it would sit at the flank slot forever watching
  //      a battle it could have won. Nothing to protect, no reason to
  //      hold back.
  //   3. Target is close to any living friendly unit — an enemy that's
  //      already in front of us is worth committing to regardless of
  //      stance. This is the "close enemy flips defensive to offensive"
  //      case, expressed locally rather than as a whole-team stance
  //      flip (a team-level flip for one close enemy would over-commit
  //      the whole line).
  _effectiveSeekCommitRange(unit, target, worldCtx) {
    const base = AIConfig.cavalryMaxCommitRange;
    if (!worldCtx || worldCtx.stance !== 'defence') return base;

    const lineUnits = Array.isArray(worldCtx.infantryLineUnits)
      ? worldCtx.infantryLineUnits
      : null;
    if (lineUnits) {
      let hasLiving = false;
      for (const lu of lineUnits) {
        if (!lu.isDefeated()) { hasLiving = true; break; }
      }
      if (!hasLiving) return base;
    }

    const tc = target.getCenter();
    const proxRange = AIConfig.cavalryDefensiveCloseThreatRange ?? 15;
    const proxRangeSq = proxRange * proxRange;
    const teamUnits = Array.isArray(worldCtx.teamUnits) ? worldCtx.teamUnits : [];
    for (const ally of teamUnits) {
      if (ally.isDefeated()) continue;
      const ac = ally.getCenter();
      const dx = tc.x - ac.x;
      const dz = tc.z - ac.z;
      if (dx * dx + dz * dz <= proxRangeSq) return base;
    }

    return AIConfig.cavalryDefensiveCommitRange ?? (base * 0.5);
  }

_decideCommitted(unit, enemyUnits, intent, worldCtx, leniency, context) {
    const tick = worldCtx.currentTick;
    const target = enemyUnits.find(u => u.id === intent.targetUnitId);

    // Target dead: chain to any clean opportunity (a second archer unit, a
    // routing enemy, an interceptable cavalry unit), else go back to
    // position. `_isValidCavalryTarget` enforces support, so re-picking is
    // safe: the cav will not select a lone spear unit.
    if (!target || target.isDefeated()) {
      const excluded = this._excludedTargetIds(intent, tick, worldCtx);
      if (intent.targetUnitId) excluded.add(intent.targetUnitId);
      const next = this._findCleanAlternative(unit, enemyUnits, excluded, worldCtx, leniency);
      if (next) {
        AIDebugLog.log('charge', tick,
          `cav=${unit.id} RETARGET after kill → ${next.target.id} (clean charge)`);
        const { dist: nextDist } = centerTowardUnit(unit, next.target);
        intent.commitTo(next.target.id, tick, next.readiness.bracedCount, nextDist);
        return this._approachOrCharge(unit, next.target, intent, worldCtx);
      }
      AIDebugLog.regroup(tick, unit.id, 'target-defeated-forcing-regroup');
      return this._enterRegroup(unit, intent, worldCtx, context, intent.targetUnitId);
    }

    // Melee-regroup is threat-based and lives entirely in
    // TeamAI._shouldStartRegroup. When that check returns true, the
    // intent's phase has already transitioned to 'regrouping' by the
    // time this method would run — this method is not reached at all.
    // When it returns false (no threat, or still inside the minimum
    // melee window) the unit should keep fighting.
    //
    // The previous version had an unconditional guard here that
    // regrouped on ANY melee observation, bypassing TeamAI's logic
    // entirely. That guard was the direct cause of the "cav touches
    // archers, leaves next decision cycle" behavior: TeamAI said "keep
    // fighting" (ticksInMelee < 10), the guard ignored that, and the
    // cav regrouped anyway. Removed; TeamAI is now the single source of
    // truth for the transition.

    const { dist: distToTarget } = centerTowardUnit(unit, target);

    // Router-chase continuation check. If the current target is a
    // routing unit, the chase is only continued while team power stays
    // above the continue-ratio. Dropping below releases to seeking;
    // the router is not blacklisted — it will be re-evaluated next
    // cycle from scratch against the start-ratio bar, which is higher,
    // so a chase that aborts because power dipped will not immediately
    // re-trigger on the same target.
    if (this._isRoutingUnit(target)) {
      const own = worldCtx.ownEffectiveCount || 0;
      const enemy = worldCtx.enemyEffectiveCount || 0;
      const ratio = enemy > 0 ? own / enemy : Infinity;
      if (ratio < AIConfig.routerChaseContinuePowerRatio) {
        AIDebugLog.log('routerchase', tick,
          `cav=${unit.id} ABORT-CHASE power=${ratio.toFixed(2)}<` +
          `${AIConfig.routerChaseContinuePowerRatio}`);
        intent.releaseToSeeking(tick);
        return null;
      }
    }

    // Committed-phase range re-check. There is no seek-to-commit range
    // gate (see _decideSeeking) — the cav commits to whatever target
    // the seeking phase picked, at any distance, so it can close at cav
    // speed rather than line speed. This is where the "don't spend a
    // whole fight marching after a target that never quite arrives"
    // concern is enforced: if the committed target is still beyond
    // cavalryMaxCommitRange, look for a strictly closer clean target
    // and re-commit to it. If nothing strictly closer is open, keep
    // the current commit and keep closing — switching to an
    // equal-or-farther target only wastes a decision cycle and resets
    // the commit timer.
    //
    // Routing targets are exempt. A fleeing router moving away from us
    // is exactly the target the cav should keep chasing (that is the
    // whole point of the router-chase path above); its distance growing
    // past cavalryMaxCommitRange is the definition of a chase, not a
    // reason to give up.
    if (!this._isRoutingUnit(target) && distToTarget > AIConfig.cavalryMaxCommitRange) {
      const excluded = this._excludedTargetIds(intent, tick, worldCtx);
      excluded.add(target.id);
      const alt = this._findCleanAlternative(unit, enemyUnits, excluded, worldCtx, leniency);
      if (alt) {
        const { dist: altDist } = centerTowardUnit(unit, alt.target);
        if (altDist < distToTarget) {
          AIDebugLog.log('charge', tick,
            `cav=${unit.id} RE-COMMIT committed=${target.id} dist=${distToTarget.toFixed(1)} > max (${AIConfig.cavalryMaxCommitRange}) → closer target=${alt.target.id} dist=${altDist.toFixed(1)}`);
          intent.commitTo(alt.target.id, tick, alt.readiness.bracedCount, altDist);
          return this._approachOrCharge(unit, alt.target, intent, worldCtx);
        }
      }
      // No strictly closer clean target — keep the current commit and
      // keep closing. The check re-runs next cycle against fresh
      // geometry, so a window opening later is caught then.
    }

    // Distance-scaled commit timeout. Uses the COMMIT-TIME distance
    // (stored on the intent at commit), not the live distance. A
    // live-distance timeout shrinks as the cav closes, and once
    // ticksSinceFormed exceeds the shrunken threshold the unit is
    // released to seeking mid-charge. It then re-commits to the same
    // target on the same tick with a fresh timer — the release/recommit
    // loop visible in the playtest log at t315 and t435 as repeated
    // COMMIT lines mid-approach. Using commit distance holds the
    // timeout fixed for the duration of that commitment.
    //
    // Fallback to live distance when the field is missing (older intent
    // shapes, non-cav callers) so behaviour is unchanged where the new
    // field hasn't been populated.
    // Distance-scaled commit timeout. Uses the COMMIT-TIME distance
    // (stored on the intent at commit), not the live distance, so the
    // timeout does not shrink as the cav closes.
    //
    // The theoretical sim speed (`toSimSpeed(baseSpeed)`) is usually
    // HIGHER than the cav's actual closing rate — the cav has to drag
    // its formation, and the target is usually walking away. A 2x
    // margin was empirically too tight: in the reference log the cav
    // closed at ~0.67 u/s against a theoretical ~2.16 u/s, so the
    // timeout fired while the cav was still 8+ units out, released it
    // to seeking, and the cav never reached contact. Two changes:
    //
    //   1. A 0.45 fudge factor on the theoretical speed, giving the
    //      timeout budget for a cav closing at ~45% of its stated pace.
    //      Faster cavs still finish early (the timeout just doesn't
    //      fire); slower cavs get the time they actually need.
    //
    //   2. NO timeout at all while within closeInRange of the target.
    //      A cav that has nearly arrived should be allowed to finish
    //      however long it took to get there. The close-in threshold
    //      is 3x chargeSpotRange, i.e. well inside striking distance.
    //
    // Routing targets are exempt from this timeout entirely — the
    // router-chase power ratio above is the real gate for a chase.
    const typeDef = unitTypeOf(unit);
    const baseSpeed = typeDef ? typeDef.baseMoveSpeed : 2.6;
    const simSpeed = toSimSpeed(baseSpeed);
    const measuredDist = (intent.commitDistance != null) ? intent.commitDistance : distToTarget;
    // Conservative closing rate assumption: 45% of the theoretical sim
    // speed. Empirically the cav in the reference log closed at ~30% of
    // theory; 45% gives some margin without being pathologically long.
    const assumedClosingSpeed = simSpeed > 0 ? simSpeed * 0.45 : 0;
    const ticksNeeded = assumedClosingSpeed > 0
      ? (measuredDist / assumedClosingSpeed) * CombatConfig.tickRateHz
      : AIConfig.commitTimeoutTicks;
    const commitTimeout = Math.max(AIConfig.commitTimeoutTicks, ticksNeeded * 2);

    // Close-in grace: once the cav is inside 3x chargeSpotRange, drop
    // the timeout entirely. A cav this close is going to arrive; timing
    // it out is exactly the "it got here but the AI blinked" failure
    // the log showed.
    const closeInRange = CombatConfig.chargeSpotRange * 3;
    const insideCloseIn = distToTarget <= closeInRange;

    if (!insideCloseIn && intent.ticksSinceFormed(tick) > commitTimeout) {
      intent.releaseToSeeking(tick);
      // TeamAI re-runs decide() immediately for a freshly-seeking unit.
      return null;
    }

    // Re-check charge readiness during the approach. A charge committed
    // against archers at long range can arrive at a spear screen that
    // stepped in front of it. Only checked outside chargeSpotRange: once
    // inside it, aborting makes the unit fly past the target.
    //
    // Mass-charge bypass: the whole point of that branch is to carry the
    // charge through to contact.
    if (!this._shouldMassCharge(worldCtx) && distToTarget > CombatConfig.chargeSpotRange) {
      const current = ChargeReadiness.assess(unit, target, enemyUnits, leniency, worldCtx);
      if (!current.willLandClean) {
        AIDebugLog.log('charge', tick,
          `cav=${unit.id} ABORT-ON-APPROACH target=${target.id} braced=${current.bracedCount}/${current.sampledDefenders} reason="${current.reason}"`);

        const failedId = target.id;
        // Per-target abort cooldown, measured from THIS abort. The tier's
        // cavalryAttemptForgiveTicks is repurposed as the cooldown length
        // (weakened: 60 ticks, best-possible: undefined -> falls through
        // to the 300-tick default), matching the tier's stated intent that
        // weakened cav retries refused targets more eagerly.
        const cooldown = worldCtx?.tierCfg?.cavalryAttemptForgiveTicks
          ?? AIConfig.cavalryAbortedTargetCooldownTicks
          ?? DEFAULT_BLOCK_COOLDOWN_TICKS;
        intent.blockTarget(failedId, tick + cooldown);

        // The target is protected: is anything else open RIGHT NOW?
        const excluded = this._excludedTargetIds(intent, tick);
        const alt = this._findCleanAlternative(unit, enemyUnits, excluded, worldCtx, leniency);
        if (alt) {
          AIDebugLog.log('charge', tick,
            `cav=${unit.id} RETARGET-ON-APPROACH ${failedId} → ${alt.target.id}`);
          const { dist: altDist } = centerTowardUnit(unit, alt.target);
          intent.commitTo(alt.target.id, tick, alt.readiness.bracedCount, altDist);
          return this._approachOrCharge(unit, alt.target, intent, worldCtx);
        }

        // Nothing open: turn around THIS cycle (no stale charge order).
        return this._enterRegroup(unit, intent, worldCtx, context, failedId);
      }
    }

    return this._approachOrCharge(unit, target, intent, worldCtx);
  }

  // Escort duty. Called from _decideSeeking as a fallback when normal
  // seeking found nothing to commit to, and this cav has been assigned
  // to protect a cluster of archers by ArcherSupportCoordinator.
  //
  // Two modes, chosen by the threat's distance to the cluster mean:
  //
  //   Standby — the threat is outside intercept range. The cav holds
  //     a small offset from the cluster's mean centre, perpendicular to
  //     the direction from cluster to threat. The perpendicular offset
  //     keeps the cav out of the archers' firing line and means the cav
  //     never has to charge through the archers to reach the threat.
  //
  //   Intercept — the threat has entered intercept range. The cav
  //     charges it directly. Goes through the standard charge path
  //     (_approachOrCharge + intent.commitTo) so readiness re-checks,
  //     corridor checks, and disengage timeouts all apply uniformly.
  //
  // Returns an order or null. Null means "no new order this cycle" —
  // either the cav is already at standby and holding, or the cluster
  // or threat is gone. In the "gone" case the coordinator will clear
  // the assignment on its next cycle; returning null here avoids
  // freezing the cav in place while it waits for that.
  _decideEscort(unit, intent, worldCtx) {
    const archerIds = intent.escortArcherUnitIds;
    const threatId = intent.escortThreatUnitId;
    if (!Array.isArray(archerIds) || archerIds.length === 0) return null;
    if (!threatId) return null;

    // Resolve every archer still alive in the cluster, and the threat.
    const teamUnits = worldCtx.teamUnits || [];
    const enemyUnits = worldCtx.enemyUnits || [];

    const liveArchers = [];
    for (const id of archerIds) {
      const u = teamUnits.find(t => t.id === id);
      if (u && !u.isDefeated()) liveArchers.push(u);
    }
    if (liveArchers.length === 0) return null;

    const threat = enemyUnits.find(e => e.id === threatId && !e.isDefeated());
    if (!threat) return null;

    // Cluster mean: the point the cav protects.
    let sx = 0, sz = 0;
    for (const a of liveArchers) {
      const c = a.getCenter();
      sx += c.x; sz += c.z;
    }
    const clusterX = sx / liveArchers.length;
    const clusterZ = sz / liveArchers.length;

    // Distance from cluster to threat.
    const threatCenter = threat.getCenter();
    const dxCT = threatCenter.x - clusterX;
    const dzCT = threatCenter.z - clusterZ;
    const distCT = Math.sqrt(dxCT * dxCT + dzCT * dzCT);

    // Intercept: threat is close enough to reach the cluster soon.
    // Charge it directly.
    if (distCT <= AIConfig.archerSupportInterceptRange) {
      const { dist: cavToThreat } = centerTowardUnit(unit, threat);
      intent.commitTo(threat.id, worldCtx.currentTick, 0, cavToThreat);
      AIDebugLog.chargeCommit(worldCtx.currentTick, unit.id, threat.id, cavToThreat);
      return this._approachOrCharge(unit, threat, intent, worldCtx);
    }

    // Standby. Hold a few units BEHIND the archer cluster's current
    // mean position — on the far side of the archers from the threat —
    // so the cav sits outside the archers' firing line and tracks the
    // cluster as it advances or falls back.
    //
    // "Behind" is relative to the threat bearing. dxCT/dzCT is the
    // vector from the cluster to the threat; negating it points back
    // through the cluster and away from the fight, which is exactly
    // where a rear-guard escort belongs while the threat is still
    // distant. The perpendicular offset that used to live here put
    // the cav beside the archer frontage rather than in front of it;
    // behind is simpler and satisfies the same goal (cav is not in
    // the archers' way) while also keeping the cav between the
    // archers and any non-threat-direction approach the escort might
    // need to react to.
    //
    // The standby point is recomputed from the cluster's CURRENT mean
    // every cycle. The cav is not ordered to a fixed spot: it follows
    // the archers as they advance, drift laterally, or fall back. Once
    // the cluster has moved more than the arrival radius the cav
    // re-issues a move order to the new standby point; below that the
    // cav holds and keeps looking at the threat.
    if (distCT < 0.001) return null;
    const ux = dxCT / distCT;
    const uz = dzCT / distCT;

    const standbyX = clusterX - ux * AIConfig.archerSupportStandbyOffset;
    const standbyZ = clusterZ - uz * AIConfig.archerSupportStandbyOffset;

    const myCenter = unit.getCenter();
    const dx = standbyX - myCenter.x;
    const dz = standbyZ - myCenter.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Face the threat in both branches. The cav is a rear guard: it
    // holds looking at the fight, not looking at its own standby
    // point, so the moment the threat enters intercept range the
    // charge can commit without a turn.
    const threatFacing = Math.atan2(ux, uz);

    if (dist < AIConfig.slotArrivalRadius) {
      // Already at standby. Hold with a refreshed facing toward the
      // threat so the cav does not drift on a stale order and keeps
      // watching the threat it was assigned to intercept.
      return {
        x: myCenter.x,
        z: myCenter.z,
        facing: threatFacing
      };
    }

    AIDebugLog.log('charge', worldCtx.currentTick,
      `cav=${unit.id} ESCORT-standby cluster=(${clusterX.toFixed(1)},${clusterZ.toFixed(1)}) ` +
      `threat=${threatId} distCT=${distCT.toFixed(1)} ` +
      `goal=(${standbyX.toFixed(1)},${standbyZ.toFixed(1)})`);

    return {
      x: standbyX,
      z: standbyZ,
      facing: threatFacing
    };
  }

  _approachOrCharge(unit, target, intent, worldCtx) {
    const { dist, facing } = centerTowardUnit(unit, target);
    if (dist <= 0.0001) return null;

    const tgtCenter = target.getCenter();
    intent.setGoal(tgtCenter.x, tgtCenter.z);
    return { x: tgtCenter.x, z: tgtCenter.z, facing };
  }

  // Begin regroup AND return the retreat order in the same cycle. Returning
  // null here is what left the cav running its old charge order into spears.
  _enterRegroup(unit, intent, worldCtx, context, failedTargetId) {
    intent.beginRegroup(worldCtx.currentTick, failedTargetId);
    return this._decideRegrouping(unit, intent, worldCtx, context);
  }

  _decideRegrouping(unit, intent, worldCtx, context) {
    const tick = worldCtx.currentTick;

    // Router-chase from a regrouping cav. A cav that just survived a
    // fight and is walking back to its flank slot can divert onto a
    // chaseable router if the tier's checks pass. Failing the checks
    // returns null, and the normal regroup logic below runs unchanged.
    // The router list comes from worldCtx (this method historically did
    // not take enemyUnits — see TeamAI's worldCtx setup).
    // Regroup path has no candidate picker to leak a rejected router
    // through — the unit continues to its flank slot. The unwrap is
    // still required because _tryRouterChase now returns a wrapper
    // object, not the order directly.
    const chaseResult = this._tryRouterChase(
      unit, worldCtx.enemyUnits || [], intent, worldCtx
    );
    if (chaseResult && chaseResult.order) return chaseResult.order;

    // Opportunistic retarget from regroup. The cav bounced off a fight
    // and is now walking home — but if a clean charge exists RIGHT NOW
    // (typically archers that walked into range while the cav was
    // fighting), take it. Without this, the only path back to seeking
    // is arriving at the flank slot or hitting the regroup hard cap,
    // so a cav that just disengaged next to two exposed archer units
    // walks away from them without ever re-assessing the field.
    //
    // Mirrors the retarget-on-kill path in _decideCommitted: the
    // situation changed, so re-ask "is there something worth charging?"
    // before committing to the walk home. This is a fresh assessment,
    // not a continuation of the previous charge — a cav that bounced
    // under a corridor refusal may find the corridor has cleared, and
    // a cav that bounced off melee (the common case) simply gets a new
    // look at the field it just disengaged into.
    //
    // Gated on !inMelee: a still-surrounded cav needs to actually break
    // contact first. Re-committing mid-fight would just walk into
    // another melee while pinned. Once the disengage lands (a few ticks
    // later — CombatConfig.disengage.graceTicks), this check starts
    // running every cycle and catches any window where a clean target
    // is available.
    if (!unit.getAliveSoldiers().some(s => s.isInMelee())) {
      const excluded = this._excludedTargetIds(intent, tick, worldCtx);
      // Don't immediately re-target whatever we just left. beginRegroup
      // stored it as lastFailedTargetUnitId; adding it here stops the
      // "bounce, re-commit to the same unit, bounce again" loop.
      if (intent.lastFailedTargetUnitId) {
        excluded.add(intent.lastFailedTargetUnitId);
      }
      const alt = this._findCleanAlternative(
        unit, worldCtx.enemyUnits || [], excluded, worldCtx, 0
      );
      if (alt) {
        AIDebugLog.log('charge', tick,
          `cav=${unit.id} RETARGET-FROM-REGROUP → ${alt.target.id} (clean charge available)`);
        const { dist: altDist } = centerTowardUnit(unit, alt.target);
        intent.commitTo(alt.target.id, tick, alt.readiness.bracedCount, altDist);
        return this._approachOrCharge(unit, alt.target, intent, worldCtx);
      }
    }

    const elapsed = intent.ticksSinceFormed(tick);

    // Destination preference:
    //   1. Formation flank slot — near the line, where cavalry is useful.
    //   2. ownFallbackPoint (deep, behind the team) — only when no
    //      formation context exists.
    const slot = this._flankSlotPoint(context, worldCtx);
    const dest = slot || worldCtx.ownFallbackPoint || null;
    const center = unit.getCenter();

    if (!dest) {
      if (elapsed > 0 && elapsed >= AIConfig.regroupHoldTicks) intent.releaseToSeeking(tick);
      return null;
    }

    const dx = dest.x - center.x;
    const dz = dest.z - center.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Release on ARRIVAL (after the minimum hold), or if the unit has
    // stalled (blocked / pinned) for twice the straight-line travel time.
    // The old release was hold-time only, which put the cav back into
    // seeking mid-field, still ~11 units from the spears.
    const arrived = dist < AIConfig.slotArrivalRadius * 2;
    const typeDef = unitTypeOf(unit);
    const simSpeed = toSimSpeed(typeDef ? typeDef.baseMoveSpeed : 2.6);
    const ticksNeeded = simSpeed > 0 ? (dist / simSpeed) * CombatConfig.tickRateHz : 0;
    const stalled = elapsed > Math.max(AIConfig.regroupHoldTicks, ticksNeeded * 2);

    // Hard cap. If we've been regrouping longer than regroupMaxTicks,
    // release unconditionally, regardless of whether arrived or stalled
    // has fired. The normal release conditions both depend on the
    // destination being a fixed point; when the flank slot moves with a
    // collapsing team anchor, neither can ever be satisfied and the cav
    // can sit in 'regrouping' indefinitely. The cap breaks that loop.
    if (elapsed > 0 && elapsed >= AIConfig.regroupMaxTicks) {
      AIDebugLog.log('charge', tick,
        `cav=${unit.id} regroup HARD-CAP at ${elapsed} ticks — releasing to seeking (dest still ${dist.toFixed(1)} away)`);
      intent.releaseToSeeking(tick);
      return null;
    }

    if (elapsed > 0 && elapsed >= AIConfig.regroupHoldTicks && (arrived || stalled)) {
      intent.releaseToSeeking(tick);
      return null;
    }

    // Already at the destination: refresh a hold order so the unit doesn't
    // drift on a stale move order.
    if (dist < AIConfig.slotArrivalRadius) {
      return { x: center.x, z: center.z, facing: context ? context.lineFacing : unit.formationFacing };
    }
    return {
      x: dest.x,
      z: dest.z,
      facing: slot && context ? context.lineFacing : Math.atan2(dx, dz)
    };
  }

// Router-chase entry point. Called from _decideSeeking and
  // _decideRegrouping before normal logic runs. Returns a chase order
  // if one is starting, or null to fall through.
  //
  // Tier gate: worldCtx.routerChaseMode === 'simple' uses the corridor
  // check alone, and only fires when there is no other valid non-routing
  // target (weakened cav only chases routers when it has nothing else
  // to do). 'smart' runs the seven-check _canChaseRouter gate.
  //
  // A cav already committed (mid-chase or mid-charge) is not eligible —
  // mid-chase power-abort is handled in _decideCommitted.
// Router-chase entry point. Called from _decideSeeking and
  // _decideRegrouping before normal logic runs.
  //
  // Returns one of:
  //   { order }            — a chase started; the caller must return
  //                          `order` from the current decision cycle.
  //   { rejectedRouterId } — a router was found but the gate refused it.
  //                          The caller must exclude this id from normal
  //                          target selection for the rest of the cycle,
  //                          otherwise the general candidate picker
  //                          (_nearestRouting + _isValidCavalryTarget,
  //                          which treats routing units as valid) will
  //                          re-select the same router the gate just
  //                          refused — the release/recommit loop this
  //                          shape exists to break.
  //   null                 — no router in range at all; nothing to exclude.
  //
  // Tier gate: worldCtx.routerChaseMode === 'simple' uses the corridor
  // check alone, and only fires when there is no other valid non-routing
  // target (weakened cav only chases routers when it has nothing else
  // to do). 'smart' runs the seven-check _canChaseRouter gate.
  //
  // A cav already committed (mid-chase or mid-charge) is not eligible —
  // mid-chase power-abort is handled in _decideCommitted.
  _tryRouterChase(unit, enemyUnits, intent, worldCtx) {
    if (intent.phase === 'committed') return null;

    const router = this._nearestRouting(unit, enemyUnits);
    if (!router) return null;

    const tick = worldCtx.currentTick;
    const mode = worldCtx.routerChaseMode || 'smart';

    if (mode === 'simple') {
      // Weakened: no valid non-routing target is the only precondition.
      const hasOtherTarget = enemyUnits.some(e =>
        !this._isRoutingUnit(e) && this._isValidCavalryTarget(e, unit, worldCtx)
      );
      if (hasOtherTarget) return { rejectedRouterId: router.id };

      const c = unit.getCenter();
      const rc = router.getCenter();
      const dist = Math.sqrt((rc.x - c.x) ** 2 + (rc.z - c.z) ** 2);
      if (dist < 0.001) return { rejectedRouterId: router.id };

      if (this._pathBlockedBySpears(unit, rc.x, rc.z, dist, worldCtx)) {
        AIDebugLog.log('routerchase', tick,
          `cav=${unit.id} router=${router.id} REJECT corridor (simple)`);
        return { rejectedRouterId: router.id };
      }

      AIDebugLog.log('routerchase', tick,
        `cav=${unit.id} router=${router.id} CHASE (simple)`);
      intent.commitTo(router.id, tick, 0);
      return { order: this._approachOrCharge(unit, router, intent, worldCtx) };
    }

    const verdict = this._canChaseRouter(unit, router, worldCtx, intent);
    if (!verdict.ok) {
      AIDebugLog.log('routerchase', tick,
        `cav=${unit.id} router=${router.id} REJECT ${verdict.reason}`);
      return { rejectedRouterId: router.id };
    }

    AIDebugLog.log('routerchase', tick,
      `cav=${unit.id} router=${router.id} CHASE`);
    intent.commitTo(router.id, tick, 0);
    return { order: this._approachOrCharge(unit, router, intent, worldCtx) };
  }

  // Seven-check gate for best-possible tier. Order is cheap-first
  // (speed, single-pass enemy cav scan, power, cooldown, corridor,
  // archer range), with the roll last — the roll is deliberately the
  // final filter so a failed roll only costs one random draw on chases
  // that would otherwise have started.
  //
  // Returns { ok: true } or { ok: false, reason: string }. Reason is
  // for the debug log only — no logic branches on it.
  _canChaseRouter(unit, router, worldCtx, intent) {
    const tick = worldCtx.currentTick;
    const cavCenter = unit.getCenter();
    const routerCenter = router.getCenter();
    const dist = Math.sqrt(
      (routerCenter.x - cavCenter.x) ** 2 +
      (routerCenter.z - cavCenter.z) ** 2
    );
    if (dist < 0.001) return { ok: false, reason: 'degenerate' };

    // 1) Speed / catchability. Absolute threshold, not map-relative.
    const cavSample = unit.soldiers.find(s => s.isAlive() && !s.isRouting);
    const routerSample = router.soldiers.find(s => s.isAlive() && s.isRouting);
    const cavSpeed = cavSample ? cavSample.effectiveMoveSpeed : 0;
    const routerSpeed = routerSample ? routerSample.effectiveMoveSpeed : 0;
    const closing = cavSpeed - routerSpeed;
    if (closing <= 0.01) return { ok: false, reason: 'speed-no-close' };
    const secondsToCatch = dist / closing;
    if (secondsToCatch > AIConfig.routerChaseMaxCatchSeconds) {
      return {
        ok: false,
        reason: `speed-too-far(${secondsToCatch.toFixed(1)}s>${AIConfig.routerChaseMaxCatchSeconds}s)`
      };
    }

    // 2) Enemy cav count, total size, and skeleton-vs-human check, in
    //    one pass. All counts exclude routing/shattered soldiers on both
    //    sides — a routing enemy cav is not a cav threat any more.
    const myAliveNonRouting = unit.getAliveSoldiers().filter(s => !s.isRouting).length;
    if (myAliveNonRouting === 0) return { ok: false, reason: 'no-cav-alive' };
    const myIsUndead = unit.soldiers[0]?.isUndead === true;

    let enemyCavUnitCount = 0;
    let enemyTotalCavSoldiers = 0;
    let enemyHumanCavSoldiers = 0;
    for (const eu of worldCtx.enemyUnits || []) {
      if (eu.isDefeated()) continue;
      const t = unitTypeOf(eu);
      if (!t || !isCavalry(t)) continue;
      const aliveNonRouting = eu.getAliveSoldiers().filter(s => !s.isRouting).length;
      if (aliveNonRouting === 0) continue;
      enemyCavUnitCount++;
      enemyTotalCavSoldiers += aliveNonRouting;
      if (!eu.isUndead) enemyHumanCavSoldiers += aliveNonRouting;
    }

    // 3) Skeleton-vs-human cav guard. Only fires on undead AI cav.
    if (myIsUndead &&
        enemyHumanCavSoldiers > myAliveNonRouting * AIConfig.routerChaseSkeletonHumanCavRatio) {
      return { ok: false, reason: 'skeleton-vs-human-cav' };
    }

    // 4) Enemy cav unit count and total size.
    if (enemyCavUnitCount > 1) return { ok: false, reason: 'multiple-enemy-cav-units' };
    if (enemyTotalCavSoldiers > myAliveNonRouting) {
      return { ok: false, reason: 'enemy-cav-larger' };
    }

    // 5) Power ratio, with hysteresis. If the cav is already mid-chase
    //    (committed against a still-routing target) the easier 1.5:1
    //    bar applies; starting fresh requires 2:1.
    const ownPower = worldCtx.ownEffectiveCount || 0;
    const enemyPower = worldCtx.enemyEffectiveCount || 0;
    if (enemyPower <= 0) return { ok: false, reason: 'no-enemy-power' };
    const powerRatio = ownPower / enemyPower;

    const isContinuing = intent.phase === 'committed' &&
      intent.targetUnitId &&
      this._isRouterTarget(intent.targetUnitId, worldCtx);
    const minRatio = isContinuing
      ? AIConfig.routerChaseContinuePowerRatio
      : AIConfig.routerChaseStartPowerRatio;
    if (powerRatio < minRatio) {
      return {
        ok: false,
        reason: `power-${powerRatio.toFixed(2)}-below-${minRatio}`
      };
    }

    // 6) Cooldown, unless power reaches the override ratio.
    if (tick < (worldCtx.routerChaseCooldownUntil ?? -Infinity)) {
      if (powerRatio < AIConfig.routerChaseOverridePowerRatio) {
        return { ok: false, reason: 'cooldown' };
      }
    }

    // 7) Spear corridor on the chase path.
    if (this._pathBlockedBySpears(unit, routerCenter.x, routerCenter.z, dist, worldCtx)) {
      return { ok: false, reason: 'corridor' };
    }

    // 8) Archer-range path. Any sizeable enemy archer whose own firing
    //    range envelopes the cav-to-router segment blocks the chase.
    if (this._pathThroughArcherRange(unit, router, worldCtx)) {
      return { ok: false, reason: 'archer-range' };
    }

    // 9) Roll. Last so a failed roll only costs one draw on chases that
    //    would otherwise have started.
    if (Math.random() < AIConfig.routerChaseFailProbability) {
      if (worldCtx.setRouterChaseCooldown) {
        worldCtx.setRouterChaseCooldown(tick + AIConfig.routerChaseCooldownTicks);
      }
      return { ok: false, reason: 'roll-failed' };
    }

    return { ok: true };
  }

  // Is this unit routing (>=50% of alive soldiers on routing state)?
  // Matches the predicate _nearestRouting already uses.
  _isRoutingUnit(unit) {
    if (!unit || unit.isDefeated()) return false;
    const alive = unit.getAliveSoldiers();
    if (alive.length === 0) return false;
    let routing = 0;
    for (const s of alive) if (s.isRouting) routing++;
    return routing / alive.length >= 0.5;
  }

  // Is a live unit id, resolved through worldCtx.enemyUnits, currently
  // routing? Used for the mid-chase hysteresis check.
  _isRouterTarget(targetId, worldCtx) {
    const target = (worldCtx.enemyUnits || []).find(u => u.id === targetId);
    if (!target || target.isDefeated()) return false;
    return this._isRoutingUnit(target);
  }

  // Spear corridor on a move-to-point path. Same half-width and
  // perpendicular-band test as TeamAI._isCavPathBlockedBySpears, inlined
  // here because FlankerBehavior has no reference to TeamAI. Returns
  // true if any non-routing spear soldier sits inside the corridor from
  // unit's center to (toX, toZ) within dist. The overwhelming-ratio
  // shortcut is deliberately not applied here — a router chase goes
  // through whatever spears are in the way, and the corridor check's
  // job is to veto that outright.
  _pathBlockedBySpears(unit, toX, toZ, dist, worldCtx) {
    if (dist < 0.001) return false;
    const c = unit.getCenter();
    const dirX = (toX - c.x) / dist;
    const dirZ = (toZ - c.z) / dist;
    const halfWidth = CombatConfig.charge.corridorHalfWidth *
                      (AIConfig.corridorWidthMultiplier ?? 2.0);
    const halfWidthSq = halfWidth * halfWidth;

    for (const eu of worldCtx.enemyUnits || []) {
      if (eu.isDefeated()) continue;
      for (const s of eu.getAliveSoldiers()) {
        if (s.unitTypeDef.weaponType !== 'spear') continue;
        if (s.isRouting) continue;
        // Engaged spearmen cannot brace; they are not a wall on the
        // chase path, they are a fight someone else is already in.
        if (s.isInMelee()) continue;
        const sx = s.pos.x - c.x;
        const sz = s.pos.z - c.z;
        const along = sx * dirX + sz * dirZ;
        if (along <= 0 || along >= dist) continue;
        const perpX = sx - along * dirX;
        const perpZ = sz - along * dirZ;
        if (perpX * perpX + perpZ * perpZ > halfWidthSq) continue;
        return true;
      }
    }
    return false;
  }

  // Does the cav-to-router straight line pass within any sizeable enemy
  // archer's own firing range? "Sizeable" = the archer's alive (non-
  // routing) soldier count exceeds routerChaseArcherSizeFraction of the
  // cav's own alive (non-routing) count. Uses getRangedRange, so a
  // goblin archer's 12-unit envelope is checked, not the global 21.
  _pathThroughArcherRange(unit, router, worldCtx) {
    const myAlive = unit.getAliveSoldiers().filter(s => !s.isRouting).length;
    if (myAlive === 0) return false;
    const sizeFloor = myAlive * AIConfig.routerChaseArcherSizeFraction;

    const cavC = unit.getCenter();
    const routerC = router.getCenter();
    const segX = routerC.x - cavC.x;
    const segZ = routerC.z - cavC.z;
    const segLenSq = segX * segX + segZ * segZ;
    if (segLenSq < 1e-6) return false;

    for (const eu of worldCtx.enemyUnits || []) {
      if (eu.isDefeated()) continue;
      const t = unitTypeOf(eu);
      if (!t || !isRanged(t)) continue;
      const aliveArchers = eu.getAliveSoldiers().filter(s => !s.isRouting).length;
      if (aliveArchers <= sizeFloor) continue;

      const range = getRangedRange(t);
      const archerC = eu.getCenter();
      const toArcherX = archerC.x - cavC.x;
      const toArcherZ = archerC.z - cavC.z;

      let tProj = (toArcherX * segX + toArcherZ * segZ) / segLenSq;
      if (tProj < 0) tProj = 0;
      else if (tProj > 1) tProj = 1;

      const projX = cavC.x + segX * tProj;
      const projZ = cavC.z + segZ * tProj;
      const dx = archerC.x - projX;
      const dz = archerC.z - projZ;
      if (dx * dx + dz * dz <= range * range) return true;
    }
    return false;
  }

// Go to (or stay at) the flank slot. Always returns an order, never null,
  // so the cav can't coast on a stale order.
  _waitAtPosition(unit, context, worldCtx) {
    const slot = this._flankSlotPoint(context, worldCtx);
    const c = unit.getCenter();
    if (slot) {
      const dx = slot.x - c.x;
      const dz = slot.z - c.z;
      if (Math.sqrt(dx * dx + dz * dz) >= AIConfig.slotArrivalRadius) {
        return { x: slot.x, z: slot.z, facing: context.lineFacing };
      }
    }
    return { x: c.x, z: c.z, facing: context ? context.lineFacing : unit.formationFacing };
  }

  // The unit's flank slot in world space:
  // (teamAnchor + right * lateralOffset - forward * depthOffset), using the
  // same axes and offsets BattleLineFormation supplied for the 'flank' role.
  // Null when no formation context / team anchor exists.
  _flankSlotPoint(context, worldCtx) {
    if (!context || !worldCtx || !worldCtx.teamAnchor) return null;
    const a = worldCtx.teamAnchor;
    return {
      x: a.x + context.right.x * context.lateralOffset - context.forward.x * context.depthOffset,
      z: a.z + context.right.z * context.lateralOffset - context.forward.z * context.depthOffset
    };
  }

  // Formation-relative hold: a move order to the flank slot, or null if
  // already within arrival radius.
  _holdFlankSlot(unit, context, worldCtx) {
    const slot = this._flankSlotPoint(context, worldCtx);
    if (!slot) return null;
    const c = unit.getCenter();
    const dx = slot.x - c.x;
    const dz = slot.z - c.z;
    if (Math.sqrt(dx * dx + dz * dz) < AIConfig.slotArrivalRadius) return null;
    return { x: slot.x, z: slot.z, facing: context.lineFacing };
  }

  // Targets the cav should not re-commit to right now. Single source: the
  // per-target abort cooldown — a target that just refused a charge is
  // off-limits to this unit for a fixed window, measured from the abort
  // itself, self-pruning on read via blockedTargetIds().
  //
  // This used to have a second, count-based blacklist on top of it. It was
  // removed because it did not expire: its forgive window anchored on
  // intent.lastRegroupTick, which every regroup sets — and a cav regroups
  // constantly in a real fight (kill, bounce, target lost), so the 450-tick
  // window was never reached and entries stayed forever. In the reference
  // log a cav that had just finished off one archer unit from a shattered
  // formation refused to finish the neighbouring archer unit of the same
  // formation, because two aborts hundreds of ticks earlier still sat on
  // the list. A stale blacklist is worse than none.
  //
  // Routing targets are exempted: a unit whose soldiers are fleeing cannot
  // brace, cannot present a spear wall, and cannot produce the geometric
  // refusal that put it on the list. Any surviving cooldown entry against
  // a routing target is stripped before the set is returned.
  _excludedTargetIds(intent, tick, worldCtx) {
    const excluded = intent.blockedTargetIds(tick);
    if (excluded.size === 0) return excluded;

    const enemyUnits = (worldCtx && worldCtx.enemyUnits) || [];
    for (const id of Array.from(excluded)) {
      const u = enemyUnits.find(e => e.id === id);
      if (u && this._isRoutingUnit(u)) excluded.delete(id);
    }
    return excluded;
  }

  // "Check for another opportunity": rank every legal target (routing in
  // chase range > ranged > anything else, nearest first), assess up to N,
  // and return the first that would land clean. null = nothing open.
  // Returns { target, readiness } or null.
  _findCleanAlternative(unit, enemyUnits, excluded, worldCtx, leniency) {
    const myCenter = unit.getCenter();
    const ranked = [];

    for (const enemy of enemyUnits) {
      if (excluded.has(enemy.id)) continue;
      if (!this._isValidCavalryTarget(enemy, unit, worldCtx)) continue;
      const soldiers = enemy.getAliveSoldiers();
      if (soldiers.length === 0) continue;

      const ec = enemy.getCenter();
      const dist = Math.hypot(ec.x - myCenter.x, ec.z - myCenter.z);
      const routing =
        soldiers.filter(s => s.isRouting).length / soldiers.length >= 0.5 &&
        dist <= AIConfig.cavalryRoutingChaseRadius;
      const type = unitTypeOf(enemy);
      const pri = routing ? 0 : (type && isRanged(type) ? 1 : 2);
      ranked.push({ enemy, pri, dist });
    }

    ranked.sort((a, b) => (a.pri - b.pri) || (a.dist - b.dist));

    // Tier handicap: a lower limit means the cav accepts the first
    // plausible alternative that passes the corridor check instead of
    // ranking and comparing several. Falls back to the config value,
    // then to the module constant, in that order.
    const limit = worldCtx?.tierCfg?.maxAlternativesAssessed
      ?? AIConfig.cavalryMaxAlternativesAssessed
      ?? DEFAULT_MAX_ALTERNATIVES;
    for (const { enemy } of ranked.slice(0, limit)) {
      const readiness = ChargeReadiness.assess(unit, enemy, enemyUnits, leniency, worldCtx);
      if (readiness.willLandClean) return { target: enemy, readiness };
    }
    return null;
  }

// Escort-scoped alternative finder. Same shape as _findCleanAlternative
  // but runs the FULL escort gate (ranged-power check, exposed-ranged
  // bypass, time window) on each candidate. Exposed archers pass
  // trivially; supported targets have to clear the time window like the
  // primary did.
  //
  // Ordering preferences, cheapest-to-punish first:
  //   1. Exposed ranged — free kills, no support to race.
  //   2. Routing enemy in chase range — same cheap-kill category.
  //   3. Any other valid target that passes the gate.
  //
  // Returns { target, verdict } or null.
  _findEscortCleanAlternative(unit, enemyUnits, excluded, worldCtx) {
    const myCenter = unit.getCenter();
    const ranked = [];

    for (const enemy of enemyUnits) {
      if (excluded.has(enemy.id)) continue;
      if (!this._isValidCavalryTarget(enemy, unit, worldCtx)) continue;
      const soldiers = enemy.getAliveSoldiers();
      if (soldiers.length === 0) continue;

      const ec = enemy.getCenter();
      const dist = Math.hypot(ec.x - myCenter.x, ec.z - myCenter.z);

      const type = unitTypeOf(enemy);
      const isRangedEnemy = !!(type && isRanged(type));
      const exposed = isRangedEnemy && this._isExposedRangedTarget(enemy, enemyUnits);

      const routing =
        soldiers.filter(s => s.isRouting).length / soldiers.length >= 0.5 &&
        dist <= AIConfig.cavalryRoutingChaseRadius;

      // Priority: exposed archers (0) > routing (1) > other ranged (2) >
      // everything else (3). Distance is the tiebreak.
      let pri;
      if (exposed) pri = 0;
      else if (routing) pri = 1;
      else if (isRangedEnemy) pri = 2;
      else pri = 3;

      ranked.push({ enemy, pri, dist });
    }

    ranked.sort((a, b) => (a.pri - b.pri) || (a.dist - b.dist));

    const limit = worldCtx?.tierCfg?.maxAlternativesAssessed
      ?? AIConfig.cavalryMaxAlternativesAssessed
      ?? 4;
    for (const { enemy } of ranked.slice(0, limit)) {
      const verdict = this._escortCommitGate(unit, enemy, enemyUnits, worldCtx);
      if (verdict.allow) return { target: enemy, verdict };
    }
    return null;
  }

_hasEnoughAlliesNearby(unit, worldCtx) {
    const center = unit.getCenter();
    let allies = 0;
    for (const s of worldCtx.allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.teamId !== unit.teamId) continue;
      if (s.unitId === unit.id) continue;
      const dx = s.pos.x - center.x;
      const dz = s.pos.z - center.z;
      if (dx * dx + dz * dz <= AIConfig.regroupTriggerAllyRadius * AIConfig.regroupTriggerAllyRadius) {
        allies++;
        if (allies >= AIConfig.regroupMinAllies) return true;
      }
    }
    return false;
  }

  // Priority: routing enemy (cheap kill, denies rally) > group leader's
  // current target (A3 coordination) > soft ranged target within factor >
  // nearest any.
  //
  // If this unit IS the group leader (or has no group), it falls through to
  // independent soft-target scoring — the leader is the one who picks for
  // the group, not the one who follows it.
  _pickFlankTarget(unit, enemyUnits, group, excludeUnitId, worldCtx) {
    const myCenter = unit.getCenter();
    const raw = excludeUnitId
      ? enemyUnits.filter(u => u.id !== excludeUnitId)
      : enemyUnits;

    // Filter to targets cavalry is allowed to attack at all: near our
    // units, and either ranged, routing, a charging enemy cavalry unit,
    // or already engaged with another unit.
    const candidates = raw.filter(enemy =>
      this._isValidCavalryTarget(enemy, unit, worldCtx)
    );
    if (candidates.length === 0) return null;

    const routingCandidate = this._nearestRouting(unit, candidates);
    if (routingCandidate) return routingCandidate;

    // A3: defer to the group leader's target if we are a follower and the
    // leader has already committed or is seeking a live target.
    if (group && !group.isLeader(unit)) {
      const leaderTarget = this._groupLeaderTarget(group, candidates);
      if (leaderTarget) return leaderTarget;
    }

    let nearestAny = null;
    let nearestAnyDist = Infinity;
    let nearestRanged = null;
    let nearestRangedDist = Infinity;

    for (const enemy of candidates) {
      const ec = enemy.getCenter();
      const dx = ec.x - myCenter.x;
      const dz = ec.z - myCenter.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < nearestAnyDist) {
        nearestAnyDist = dist;
        nearestAny = enemy;
      }

      const type = unitTypeOf(enemy);
      if (type && isRanged(type) && dist < nearestRangedDist) {
        nearestRangedDist = dist;
        nearestRanged = enemy;
      }
    }

    if (!nearestAny) return null;

    // B4 retrofit: weighted-pick between ranged and nearest when the
    // ranged target is within the soft-target distance factor.
    if (nearestRanged &&
        nearestRangedDist <= nearestAnyDist * AIConfig.cavalrySoftTargetDistanceFactor) {
      const options = [
        { unit: nearestRanged, score: 1.0 },
        { unit: nearestAny, score: 0.6 }
      ];
      const picked = WeightedSelect.pick(options, {
        getScore: (o) => o.score,
        qualityFloorFraction: 1.0,
        temperature: 0.6
      });
      return picked ? picked.unit : nearestRanged;
    }

    return nearestAny;
  }

  _nearestRouting(unit, enemyUnits) {
    const myCenter = unit.getCenter();
    let best = null;
    let bestDist = Infinity;
    for (const enemy of enemyUnits) {
      const soldiers = enemy.getAliveSoldiers();
      if (soldiers.length === 0) continue;
      const routingCount = soldiers.filter(s => s.isRouting).length;
      if (routingCount / soldiers.length < 0.5) continue; // unit as a whole is routing, not one straggler

      const ec = enemy.getCenter();
      const dx = ec.x - myCenter.x;
      const dz = ec.z - myCenter.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AIConfig.cavalryRoutingChaseRadius) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = enemy;
      }
    }
    return best;
  }

  // Reads the group leader's OWN intent (seeking or committed target) and
  // returns that enemy unit if it's still a valid candidate. Returns null
  // if the leader has no live target yet, so the follower falls through to
  // its own independent scoring for this cycle (it will pick up the
  // leader's target next cycle once the leader has one).
  _groupLeaderTarget(group, candidates) {
    const leaderIntent = group.leader.intent;
    if (!leaderIntent) return null;
    if (leaderIntent.phase !== 'seeking' && leaderIntent.phase !== 'committed') return null;
    if (!leaderIntent.targetUnitId) return null;

    const target = candidates.find(u => u.id === leaderIntent.targetUnitId);
    if (!target || target.isDefeated()) return null;
    return target;
  }

  // Cavalry target validity: what is this unit ALLOWED to attack?
  //
  // - Archers/ranged: always valid — an open archer unit is a legitimate
  //   cavalry target even with no friendly unit anywhere near it. Chasing
  //   down unguarded archers is one of cavalry's core jobs; requiring the
  //   archers to be near our line would make it impossible.
  // - No-melee-line exemption: when this team currently fields zero living
  //   spear/sword units of its own, EVERY non-ranged enemy becomes valid,
  //   regardless of friendly-support or engaged-state. This branch
  //   short-circuits the friendly-support gate and the engaged-state gate
  //   below.
  // - Routing enemy units: valid (cheap kills, existing priority).
  // - Enemy cavalry charging an AI unit: valid intercept.
  // - Everyone else (spear/sword line units): only if already engaged
  //   with another unit — cavalry does not initiate against a standing
  //   line, it exploits one that is already fighting.
  //
  // For teams WITH a melee line, every non-archer target must be close to
  // an existing AI unit — cavalry supports the line against melee threats,
  // it does not go on solo raids against unengaged melee units far from
  // the army. See AIConfig.cavalryFlankSupportRadius.
  _isValidCavalryTarget(enemy, unit, worldCtx) {
    if (enemy.isDefeated()) return false;

    const type = unitTypeOf(enemy);
    if (!type) return false;

    // Archers are exempt from every other gate — an open archer unit is
    // exactly the target cavalry should be hunting.
    if (isRanged(type)) return true;

    // No-melee-line exemption, checked FIRST after the ranged branch. With
    // no melee line of our own, both remaining gates are meaningless:
    // there is no other friendly unit to provide "support", and nobody can
    // pin an enemy so the engaged-state requirement can never be met.
    // Priority preservation is unaffected: _pickFlankTarget still runs
    // _nearestRouting FIRST on the widened candidate set.
    if (!this._teamHasMeleeLine(worldCtx)) return true;

    if (!this._hasFriendlySupport(enemy, unit, worldCtx)) return false;

    const soldiers = enemy.getAliveSoldiers();
    if (soldiers.length === 0) return false;

    const routingCount = soldiers.filter(s => s.isRouting).length;
    if (routingCount / soldiers.length >= 0.5) return true;

    if (isCavalry(type) && this._isAboutToCharge(enemy, unit, worldCtx)) return true;

    return soldiers.some(s => s.isInMelee());
  }

  // Does this unit's team currently field any living spear/sword (i.e.
  // non-cavalry, non-ranged) units? Used by _isValidCavalryTarget to
  // decide whether cavalry must take on standing enemy melee units
  // itself.
  //
  // If the field is missing entirely — a stripped-down worldCtx from
  // some other caller — default to TRUE: assume a melee line exists
  // and do NOT grant the exemption. The exemption widens cavalry's
  // target set, so the conservative default when we cannot tell is
  // the original rule.
  _teamHasMeleeLine(worldCtx) {
    if (!worldCtx || !Array.isArray(worldCtx.infantryLineUnits)) return true;
    for (const u of worldCtx.infantryLineUnits) {
      if (!u.isDefeated()) return true;
    }
    return false;
  }

  // Is this enemy unit close enough to one of our OTHER units for the
  // cavalry to consider it a supported target? Excludes the cavalry
  // unit itself — "near existing AI units" means near the line, not
  // near this cavalry unit alone.
  _hasFriendlySupport(enemy, unit, worldCtx) {
    if (!worldCtx || !worldCtx.allSoldiers) return true;
    const center = enemy.getCenter();
    const radius = AIConfig.cavalryFlankSupportRadius;
    const radiusSq = radius * radius;
    for (const s of worldCtx.allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.teamId !== unit.teamId) continue;
      if (s.unitId === unit.id) continue;
      const dx = s.pos.x - center.x;
      const dz = s.pos.z - center.z;
      if (dx * dx + dz * dz <= radiusSq) return true;
    }
    return false;
  }

  // True when this team has no melee line AND no ranged units. Reads the
  // same composition fields ChargeReadiness uses for its corridor-skip
  // policy, so the two stay in sync.
  //
  // Missing fields default to true (line exists, ranged exists) so an
  // unexpected worldCtx shape does not accidentally trigger mass charge.
  _shouldMassCharge(worldCtx) {
    if (!worldCtx) return false;
    if (this._hasAliveLineUnit(worldCtx)) return false;
    if (this._hasAliveRangedUnit(worldCtx)) return false;
    return true;
  }

  _hasAliveLineUnit(worldCtx) {
    if (!Array.isArray(worldCtx.infantryLineUnits)) return true;
    for (const u of worldCtx.infantryLineUnits) {
      if (!u.isDefeated()) return true;
    }
    return false;
  }

  _hasAliveRangedUnit(worldCtx) {
    if (!Array.isArray(worldCtx.rangedUnits)) return true;
    for (const u of worldCtx.rangedUnits) {
      if (!u.isDefeated()) return true;
    }
    return false;
  }

  // Mean center of this team's living cavalry units. Used by the mass-
  // charge staging step: each cav moves toward this point until all are
  // within MASS_CHARGE_CONVERGENCE_RADIUS of it, then all commit.
  //
  // Deliberately reads only cavalry — the staging point is a cavalry-
  // only rendezvous, not a team anchor.
  _cavGroupCentroid(worldCtx) {
    if (!worldCtx || !Array.isArray(worldCtx.teamUnits)) return null;
    let sx = 0, sz = 0, count = 0;
    for (const u of worldCtx.teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || !isCavalry(t)) continue;
      const c = u.getCenter();
      sx += c.x;
      sz += c.z;
      count++;
    }
    if (count === 0) return null;
    return { x: sx / count, z: sz / count };
  }

  // Returns a move order toward the cav group centroid if this unit is
  // still too far from it, or null if the group has converged (in which
  // case the caller should commit to the charge).
  //
  // A single cav is trivially converged — its own position is the
  // centroid — so this returns null and the lone cav charges
  // immediately.
  _massChargeStaging(unit, worldCtx) {
    const centroid = this._cavGroupCentroid(worldCtx);
    if (!centroid) return null;

    const center = unit.getCenter();
    const dx = centroid.x - center.x;
    const dz = centroid.z - center.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const radius = (AIConfig && AIConfig.massChargeConvergenceRadius) != null
      ? AIConfig.massChargeConvergenceRadius
      : MASS_CHARGE_CONVERGENCE_RADIUS_FALLBACK;
    if (dist <= radius) return null;

    return {
      x: centroid.x,
      z: centroid.z,
      facing: Math.atan2(dx, dz)
    };
  }

  // Is this enemy cavalry unit currently moving fast enough to count as
  // charging, AND close enough to one of our units that we should
  // intercept? Reuses the same speed threshold as charge detection so
  // "about to charge" means the same thing everywhere.
  _isAboutToCharge(enemyUnit, unit, worldCtx) {
    if (!worldCtx || !worldCtx.allSoldiers) return false;
    const speedThreshold = toSimSpeed(CombatConfig.charge.speedThreshold);
    const soldiers = enemyUnit.getAliveSoldiers();
    const chargers = soldiers.filter(s => s.currentSpeed >= speedThreshold);
    if (chargers.length === 0) return false;

    const radius = AIConfig.cavalryThreatDetectRadius;
    const radiusSq = radius * radius;
    for (const s of worldCtx.allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.teamId !== unit.teamId) continue;
      for (const charger of chargers) {
        const dx = charger.pos.x - s.pos.x;
        const dz = charger.pos.z - s.pos.z;
        if (dx * dx + dz * dz <= radiusSq) return true;
      }
    }
    return false;
  }

}
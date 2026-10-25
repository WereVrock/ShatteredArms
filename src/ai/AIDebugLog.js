// ===== src/ai/AIDebugLog.js =====
// Centralized AI debug logging. OFF by default (near-zero cost when
// disabled - every call site checks the enabled flag before doing any
// string work). Toggle from the browser console at runtime:
//
//   AIDebugLog.enabled = true
//   AIDebugLog.enabledCategories.add('charge')   // or 'objective', 'brace', 'rally', 'combat', 'regroup', 'fragile', etc.
//
// Output is deliberately grep-friendly / copy-paste friendly: one line per
// event, fixed prefix per category, plain values (no nested object dumps
// that collapse weirdly when copied out of devtools).
//
// All output is routed through BatchLogger rather than console.log
// directly, so headless runs accumulate the whole scenario's output and
// emit it as one batched console.log at the end. See
// src/logging/BatchLogger.js.
//
// Every numeric formatter here is defensive: a missing or non-finite value
// renders as a placeholder rather than throwing. Debug logging must never
// be able to take the sim down — the cost of a misreported line is
// negligible next to a hard tick failure, and the mor morale breakdown is
// built from a snapshot object whose fields are not populated on every
// code path (a rout transition can fire before the outnumbered block has
// run, for example).
import { BatchLogger } from '../logging/BatchLogger.js';

// Coerce any value to a finite number, falling back to `fallback` when it
// is missing or non-finite. Every numeric formatter in this file routes
// through here (directly or via _signed / _fixed1) so a missing field
// renders as 0 rather than throwing.
function _finiteOr(v, fallback) {
  return (typeof v === 'number' && isFinite(v)) ? v : fallback;
}

export const AIDebugLog = {
  enabled: true,
  // When empty, all categories log (once enabled). Add specific category
  // strings to narrow output when the log gets noisy.
  enabledCategories: new Set(),

  // Soldier ids whose morale is traced EVERY tick, transition or not. Empty
  // by default: a rout cascade can flag dozens of soldiers in a single tick,
  // and the per-transition log already covers those. Use this only when you
  // need the tick-by-tick history of one specific soldier. From devtools:
  //   AIDebugLog.moraleWatchSoldierIds.add(1234)
  moraleWatchSoldierIds: new Set(),

  // Categories far noisier than the rest (brace logs one line per sampled
  // defender per cavalry assessment, ~15-20 lines every decision cycle).
  // They only log when explicitly added to enabledCategories; the "empty
  // set = everything" default skips them.
  quietCategories: new Set(['brace']),

  _shouldLog(category) {
    if (!this.enabled) return false;
    if (this.enabledCategories.size === 0) return !this.quietCategories.has(category);
    return this.enabledCategories.has(category);
  },

  // Formats a signed number to two decimals with an explicit + on
  // non-negatives, so a morale breakdown reads as a sum at a glance.
  // Defensive: a missing or non-finite value renders as +0.00 rather
  // than throwing. See the file header for why every formatter here is
  // guarded.
  _signed(v) {
    v = _finiteOr(v, 0);
    const s = v.toFixed(2);
    return v >= 0 ? `+${s}` : s;
  },

  // Companion to _signed for the non-signed numeric readouts in the
  // morale breakdown. Same defensive contract.
  _fixed1(v) {
    return _finiteOr(v, 0).toFixed(1);
  },

  log(category, tick, message) {
    if (!this._shouldLog(category)) return;
    BatchLogger.push(null, `[AI][${category}][t${tick}] ${message}`);
  },

  // Convenience helpers so call sites stay short and consistent.
  objective(tick, teamId, unitLabel) {
    this.log('objective', tick, `team=${teamId} objective=${unitLabel}`);
  },

  chargeDecision(tick, cavUnitId, targetUnitId, willLandClean, reason) {
    this.log('charge', tick, `cav=${cavUnitId} target=${targetUnitId} clean=${willLandClean} reason="${reason}"`);
  },

  chargeCommit(tick, cavUnitId, targetUnitId, dist) {
    const d = _finiteOr(dist, 0).toFixed(2);
    this.log('charge', tick, `cav=${cavUnitId} COMMIT target=${targetUnitId} dist=${d}`);
  },

  chargeAbort(tick, cavUnitId, reason) {
    this.log('charge', tick, `cav=${cavUnitId} ABORT/HOLD reason="${reason}"`);
  },

  // Diagnostic: fires for every issued move order on a cavalry unit.
  // Used to test the "stale formationSlot" hypothesis — if the cav walks
  // back toward spears during a window with no ORDER line, the last
  // applied formationSlot came from an earlier order and no one has
  // refreshed it. `phase` and `target` identify which decision path
  // produced this order (committed/seeking/regrouping) and what target
  // (if any) the intent is holding at the time.
  cavOrder(tick, unitId, x, z, phase, targetUnitId) {
    const sx = _finiteOr(x, 0).toFixed(1);
    const sz = _finiteOr(z, 0).toFixed(1);
    this.log('charge', tick,
      `ORDER cav=${unitId} -> (${sx}, ${sz}) phase=${phase} target=${targetUnitId ?? 'none'}`);
  },

  braceCheck(tick, cavUnitId, defenderSoldierId, angleOffDeg, turnNeededDeg, turnAvailableDeg, willBrace) {
    this.log('brace', tick, `cav=${cavUnitId} defender=${defenderSoldierId} angleOff=${this._fixed1(angleOffDeg)} needed=${this._fixed1(turnNeededDeg)} available=${this._fixed1(turnAvailableDeg)} willBrace=${willBrace}`);
  },

  braceOutcome(tick, attackerId, defenderId, wasBraced, angleOffDeg) {
    this.log('brace', tick, `attacker=${attackerId} defender=${defenderId} ACTUALLY_BRACED=${wasBraced} angleOff=${this._fixed1(angleOffDeg)}`);
  },

  rallyInterrupt(tick, unitId, soldierId) {
    this.log('rally', tick, `unit=${unitId} soldier=${soldierId} CONTACT-INTERRUPT march order cleared`);
  },

  weakPointBias(tick, teamId, unitId, targetUnitId, detourRatio) {
    this.log('weakpoint', tick, `team=${teamId} unit=${unitId} biasedTo=${targetUnitId} detour=${this._signed(detourRatio)}`);
  },

  focusFire(tick, teamId, targetUnitId, tier) {
    this.log('focusfire', tick, `team=${teamId} target=${targetUnitId} tier="${tier}"`);
  },

  regroup(tick, unitId, phase) {
    this.log('regroup', tick, `unit=${unitId} phase=${phase}`);
  },

  // Fires once per actual melee hit resolution, independent of AI logic -
  // ground truth for "did anything actually die", which the AI-side logs
  // alone can't answer.
  combatHit(tick, attackerId, defenderId, damage, defenderHpAfter, defenderMaxHp) {
    const hpA = _finiteOr(defenderHpAfter, 0).toFixed(0);
    this.log('combat', tick,
      `attacker=${attackerId} defender=${defenderId} ` +
      `dmg=${this._fixed1(damage)} hpAfter=${hpA}/${defenderMaxHp}`);
  },

  combatDeath(tick, defenderId, defenderUnitId) {
    this.log('combat', tick, `DEATH defender=${defenderId} unit=${defenderUnitId}`);
  },

  unitDefeated(tick, unitId, teamId) {
    this.log('combat', tick, `UNIT DEFEATED unit=${unitId} team=${teamId}`);
  },

  // Fires whenever TeamAI decides to START a regroup, with the reason -
  // this is what was missing to explain the repeat-charge loop: without
  // it, regroup transitions were invisible and looked like fresh target
  // selection from scratch.
  regroupStart(tick, unitId, ticksInMelee, allyCount) {
    this.log('regroup', tick, `unit=${unitId} START regroup ticksInMelee=${ticksInMelee} nearbyAllies=${allyCount}`);
  },

  // Fires when the SAME target is re-selected after a regroup cycle
  // completed without killing it - the direct signal for "stuck in a
  // charge/regroup loop against one target".
  repeatTargetWarning(tick, unitId, targetUnitId, priorAttempts) {
    this.log('charge', tick, `WARNING cav=${unitId} RE-TARGETING target=${targetUnitId} (attempt #${priorAttempts + 1} against same unit without killing it)`);
  },

  posture(tick, teamId, posture, strengthRatio, moraleAdv) {
    this.log('posture', tick, `team=${teamId} posture=${posture} strengthRatio=${this._signed(strengthRatio)} moraleAdv=${this._fixed1(moraleAdv)}`);
  },

  // A4: fragile-unit status read. Fires whenever TeamAI evaluates a unit as
  // fragile and routes it to the reserve fallback - see behaviorUtils.isFragile
  // and ReserveBehavior.
  fragileStatus(tick, teamId, unitId, avgMorale, threshold) {
    this.log('fragile', tick, `team=${teamId} unit=${unitId} avgMorale=${this._fixed1(avgMorale)} threshold=${threshold} FRAGILE -> reserve fallback`);
  },

  // --- Morale --------------------------------------------------------------
  // MoraleSystem logs one line per rout/rally transition, plus a per-tick
  // line for any soldier on the watch list. All three share the same
  // per-source breakdown, so a line reads as a sum: every drain and bonus
  // listed adds up to `total`. `total` is the RAW delta applied before
  // clamping - a soldier already sitting at morale 0 can have a total well
  // below zero while showing no visible change, which is exactly what you
  // want to see when diagnosing a stuck routing soldier.
  //
  // Field names here MUST match the breakdown object MoraleSystem fills in
  // (see MoraleSystem._breakdown). `casRegen` reads casualtyRegenMult, the
  // linear regen scaling factor; there is no `casualtyRatio` field on the
  // breakdown object.
  isMoraleWatched(soldierId) {
    return this.moraleWatchSoldierIds.size > 0 &&
      this.moraleWatchSoldierIds.has(soldierId) &&
      this._shouldLog('morale');
  },

  _moraleBreakdown(b) {
    return `regen=${this._signed(b.regen)} hp=${this._signed(b.hp)} ` +
      `casRegen=${this._signed(b.casualtyRegenMult)} casLoss=${this._signed(b.casualtyLoss)} ` +
      `outnum=${this._signed(b.outnumbered)} ` +
      `[r${this._fixed1(b.outnumberedRatio)} ${this._fixed1(b.allyStrength)}v${this._fixed1(b.enemyStrength)}] ` +
      `flank=${this._signed(b.flanked)} ` +
      `allyRout=${this._signed(b.allyRout)} enemyRout=${this._signed(b.enemyRout)} ` +
      `kill=${this._signed(b.kill)} total=${this._signed(b.total)}`;
  },

  moraleRout(tick, soldier, b) {
    if (!this._shouldLog('morale')) return;
    this.log('morale', tick,
      `ROUT soldier=${soldier.id} unit=${soldier.unitId} ` +
      `morale=${this._fixed1(b.startMorale)}->0 [${this._moraleBreakdown(b)}]`);
  },

  moraleRally(tick, soldier, b) {
    if (!this._shouldLog('morale')) return;
    this.log('morale', tick,
      `RALLY soldier=${soldier.id} unit=${soldier.unitId} ` +
      `morale=${this._fixed1(b.startMorale)}->${this._fixed1(b.endMorale)} [${this._moraleBreakdown(b)}]`);
  },

  // Only ever called after isMoraleWatched() returned true, so it is already
  // pre-gated on both the watch list and the 'morale' category.
  moraleTick(tick, soldier, b) {
    this.log('morale', tick,
      `TICK soldier=${soldier.id} unit=${soldier.unitId} state=${soldier.state} ` +
      `morale=${this._fixed1(b.startMorale)}->${this._fixed1(b.endMorale)} [${this._moraleBreakdown(b)}]`);
  },

  battleEnd(tick, winnerTeamId) {
    this.log('battle', tick, `BATTLE OVER winner=${winnerTeamId}`);
  },

  // --- Plan layer (Stage B) ---
  // Emitted by PlanScheduler on plan lifecycle events. Category 'plan' so
  // plan behavior is debuggable as soon as the plan layer exists - not
  // deferred to when a specific tactic is built on top of it.
  planCreate(tick, teamId, tactic, objectiveUnitId, roleCount) {
    this.log('plan', tick, `team=${teamId} CREATE tactic=${tactic} objective=${objectiveUnitId} roles=${roleCount}`);
  },

  planPhase(tick, teamId, tactic, phase, phaseNum, phaseTotal) {
    this.log('plan', tick, `team=${teamId} PHASE tactic=${tactic} phase=${phase} (${phaseNum}/${phaseTotal})`);
  },

  planDissolve(tick, teamId, tactic, reason) {
    this.log('plan', tick, `team=${teamId} DISSOLVE tactic=${tactic} reason="${reason}"`);
  },

  planGateRejected(tick, teamId, planId, reason) {
    this.log('plan', tick, `team=${teamId} GATE_REJECT plan=${planId} reason="${reason}"`);
  },

  // --- Corridor debug channel ---
  // Non-text side channel: fired by ChargeReadiness.assess whenever the
  // corridor check refuses a charge. Subscribers (CorridorDebugView) render
  // the geometry. Kept here rather than a new module so wiring is a single
  // property assignment from main.js. Unlike log(), this fires regardless
  // of the `enabled` flag — the corridor view is a visual debug tool, not
  // text output, and turning off logging shouldn't turn it off.
  onCorridorEvent: null,

  corridorEvent(evt) {
    if (this.onCorridorEvent) this.onCorridorEvent(evt);
  }
};

// Attach to window so it's reachable from the browser console without an
// import (main.js still imports it normally for internal use).
if (typeof window !== 'undefined') {
  window.AIDebugLog = AIDebugLog;
}
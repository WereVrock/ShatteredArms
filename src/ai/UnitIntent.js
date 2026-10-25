// Persistent per-unit AI memory.
//
// threatUnitId is new in this revision: set by SkirmisherBehavior when it
// detects a charge threat (see _findChargeThreat), read by TeamAI's
// _archerInterceptOverride so a line/reserve unit can be redirected to
// intercept — this is what connects "archers see a threat" to "someone
// else does something about it", which didn't exist before.
export class UnitIntent {
  constructor(unitId) {
    this.unitId = unitId;
    this.phase = 'seeking';
    this.targetUnitId = null;
    this.threatUnitId = null;
    this.formedAtTick = 0;
    this.enteredMeleeAtTick = null;
    this.lastGoalX = null;
    this.lastGoalZ = null;

    // Last move order the AI actually issued for this unit — the filtered
    // output of TeamAI._issueOrderIfChanged. Used to skip issuing an
    // essentially identical order on the next decision cycle: re-issuing
    // would call Unit.issueMoveOrder, which (for anything other than a
    // near-zero move) resets the march anchor, recomputes every soldier's
    // formationSlot, un-releases soldiers that had individually broken off
    // to chase, and force-clears any engaged/ranged combat state with a
    // disengage grace. For a cavalry unit the AI re-decides each cycle
    // (e.g. during a long approach), that produced the visible stutter
    // documented in the playtest log — same-order re-issues every 15 ticks
    // with no actual change to the destination.
    //
    // Null until the first order is issued. Not reset on phase changes:
    // an intent transition that happens to land on the same destination
    // is exactly the case this field exists to catch.
    this.lastIssuedX = null;
    this.lastIssuedZ = null;
    this.lastIssuedFacing = null;
    // Set by beginRegroup when pulling out of an unfinished fight. Read by
    // the retarget check to avoid immediately re-committing to the same
    // target on the cycle the cav pulled out of it.
    this.lastFailedTargetUnitId = null;

    // Snapshot of ChargeReadiness.bracedCount at the moment we committed to
    // the current target. FlankerBehavior._decideCommitted compares the
    // live count against this to detect "the defenders in front of us got
    // more braced during the approach" — the case where we committed at
    // archers and arrived at spears. Reset on every phase change.
    this.committedBracedCount = 0;

    // Map<targetUnitId, tick until which this target is off-limits>. Set
    // when a charge on it is aborted, so a flickering corridor can't
    // re-commit us to the same protected target every decision cycle.
    //
    // This is the ONLY blacklist mechanism. A per-target cooldown,
    // measured from the abort itself, self-pruning on read via
    // blockedTargetIds(). A previous count-based system on top of it was
    // removed; its expiry anchored on the tick of the cav's most recent
    // regroup (any regroup, for any reason), so it never expired during
    // an active fight and permanently blocked targets whose corridor had
    // long since cleared.
    this.blockedTargetUntil = new Map();

    // --- Archer support pairing ---
    //
    // CAV SIDE. When ArcherSupportCoordinator pairs this cavalry unit
    // to a cluster of archers that needs cover, both fields are set.
    // FlankerBehavior._decideSeeking reads them: if no opportunity
    // preempts, the cav either stands by near the cluster's mean
    // (threat still far) or charges the flagged threat (threat inside
    // intercept range). Coordinator clears both when the threat
    // resolves or the assignment becomes invalid.
    //
    // `escortArcherUnitIds` is the list of friendly archer unit ids in
    // the protected cluster. The standby position is computed from
    // their mean. `escortThreatUnitId` is the enemy cavalry unit the
    // cluster is threatened by — the one the cav will charge when the
    // threat closes.
    this.escortArcherUnitIds = null;
    this.escortThreatUnitId = null;

    // ARCHER SIDE. Set every decision cycle by ArcherSupportCoordinator.
    // When true, this archer unit may advance to standoff. When false,
    // it hugs the melee line. The coordinator sets it true in three
    // cases: (a) the enemy has no cavalry on the field at all, so
    // there's nothing to fear; (b) this archer's cluster has a cav
    // assigned to protect it; (c) this archer isn't currently near any
    // enemy cavalry, so it doesn't need cover right now.
    this.hasEscort = false;

    // Intent-level memory, used by the ranged decision dispatcher.
    //
    // lastIntentKey names the most recent intent that was actually
    // ISSUED for this unit — e.g. 'focus:1234', 'move:kite'. It exists
    // because the AI recomputes its intent every decision cycle, and the
    // position-only same-order filter (in Unit.issueMoveOrder) misses
    // the case where the intent is conceptually unchanged but the
    // recomputed destination drifted a fraction of a unit due to anchor
    // or enemy movement. That miss made the AI re-issue identical-
    // intent orders every cycle, resetting the unit's combat state each
    // time — which is what killed the goblin archers' bow draws.
    // Comparing the intent key catches it.
    this.lastIntentKey = null;

    // Pending repositioning order for a ranged unit that is currently
    // drawing. Set by TeamAI._dispatchRangedDecision when the AI wants
    // to move the unit but a volley is in flight; consumed and cleared
    // by TeamAI.onVolleyFired the instant the volley looses, so the
    // order applies on the same sim tick the arrows leave the bows.
    // Shape: { subKind, x, z, facing }. Null when nothing is queued.
    //
    // Single-slot: a fresh reposition replaces whatever was queued, so
    // the pending order is always the AI's most recent intent.
    this.pendingMove = null;
  }

  commitTo(targetUnitId, currentTick, bracedCount, commitDistance) {
    this.phase = 'committed';
    this.targetUnitId = targetUnitId;
    this.formedAtTick = currentTick;
    this.enteredMeleeAtTick = null;
    this.committedBracedCount = bracedCount || 0;
    // Distance from unit to target at the moment of commit. Read by
    // FlankerBehavior._decideCommitted's timeout, which must not shrink
    // as the cav closes — a distance-derived timeout that uses live
    // distance fires in the middle of a healthy approach (the cav closes
    // distance, ticksNeeded shrinks, and eventually ticksSinceFormed
    // exceeds it) and releases the unit to seeking, causing it to
    // re-commit to the same target with a fresh timer every ~100 ticks.
    // Null for non-cav commitments (which never read it).
    this.commitDistance = (typeof commitDistance === 'number' && isFinite(commitDistance))
      ? commitDistance
      : null;
  }

  beginRegroup(currentTick, failedTargetUnitId) {
    this.phase = 'regrouping';
    // Remember what we were just fighting when we pulled out, so seeking
    // logic (after this regroup completes) can tell "I already tried this
    // target and it didn't die" apart from "this is a fresh pick" — without
    // this, a survived target just gets re-charged solo forever, which is
    // exactly the loop observed in playtest logs (repeated COMMIT against
    // the same archer unit every ~100+ ticks with no progress).
    this.lastFailedTargetUnitId = failedTargetUnitId || this.targetUnitId || null;
    this.targetUnitId = null;
    this.formedAtTick = currentTick;
    this.enteredMeleeAtTick = null;
    this.committedBracedCount = 0;
  }

  releaseToSeeking(currentTick) {
    this.phase = 'seeking';
    this.targetUnitId = null;
    this.formedAtTick = currentTick;
    this.enteredMeleeAtTick = null;
    this.committedBracedCount = 0;
  }

  // Marks a target as off-limits until untilTick.
  blockTarget(targetUnitId, untilTick) {
    if (targetUnitId) this.blockedTargetUntil.set(targetUnitId, untilTick);
  }

  // Returns a fresh Set of target ids still blocked at currentTick, and
  // drops expired entries as a side effect.
  blockedTargetIds(currentTick) {
    const out = new Set();
    for (const [id, until] of this.blockedTargetUntil) {
      if (currentTick < until) out.add(id);
      else this.blockedTargetUntil.delete(id);
    }
    return out;
  }

  noteEnteredMelee(currentTick) {
    if (this.enteredMeleeAtTick === null) {
      this.enteredMeleeAtTick = currentTick;
    }
  }

  noteExitedMelee() {
    this.enteredMeleeAtTick = null;
  }

  setGoal(x, z) {
    this.lastGoalX = x;
    this.lastGoalZ = z;
  }

  ticksSinceFormed(currentTick) {
    return currentTick - this.formedAtTick;
  }

  ticksInMelee(currentTick) {
    if (this.enteredMeleeAtTick === null) return 0;
    return currentTick - this.enteredMeleeAtTick;
  }
}

export class UnitIntentRegistry {
  constructor() {
    this._byUnitId = new Map();
  }

  get(unitId) {
    let intent = this._byUnitId.get(unitId);
    if (!intent) {
      intent = new UnitIntent(unitId);
      this._byUnitId.set(unitId, intent);
    }
    return intent;
  }

  pruneMissing(validUnitIds) {
    for (const unitId of this._byUnitId.keys()) {
      if (!validUnitIds.has(unitId)) {
        this._byUnitId.delete(unitId);
      }
    }
  }
}
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
    // Set by beginRegroup when pulling out of an unfinished fight. Read by
    // FlankerBehavior on the next seeking cycle: if the same unit is about
    // to be re-picked, that counts as a repeat attempt (see
    // repeatAttemptsByTargetId) instead of a fresh, cost-free choice.
    this.lastFailedTargetUnitId = null;
    // Map<targetUnitId, attemptCount> — persists across regroup cycles for
    // the lifetime of this intent object (i.e. for this unit's whole
    // battle), so a target that survives two solo charges in a row gets
    // flagged for the team-level "send help or abandon" escalation instead
    // of a third solo attempt.
    this.repeatAttemptsByTargetId = new Map();

    // Snapshot of ChargeReadiness.bracedCount at the moment we committed to
    // the current target. FlankerBehavior._decideCommitted compares the
    // live count against this to detect "the defenders in front of us got
    // more braced during the approach" — the case where we committed at
    // archers and arrived at spears. Reset on every phase change.
    this.committedBracedCount = 0;
  }

  commitTo(targetUnitId, currentTick, bracedCount) {
    this.phase = 'committed';
    this.targetUnitId = targetUnitId;
    this.formedAtTick = currentTick;
    this.enteredMeleeAtTick = null;
    this.committedBracedCount = bracedCount || 0;
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
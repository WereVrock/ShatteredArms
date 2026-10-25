// B1 — Persistent team plan object.
//
// TeamAI._decide() is stateless: every cycle re-derives everything from the
// current snapshot. That is enough for reactive behavior, but expresses no
// concept of "we are executing Plan X, currently at phase 2 of 4" — so any
// timing-dependent behavior ("wait for the pin before charging") is
// inexpressible.
//
// A TeamPlan is the persistent state that fixes this. It is created,
// advanced, and dissolved by PlanScheduler; behaviors READ it (e.g.
// `plan.phase === 'strike'`) but never write to it.
//
// Phase transitions are condition-driven, not tick-driven. Each phase
// declares:
//   - name: string, visible in logs and used by role dispatch
//   - exitCondition(worldState, plan): predicate over world state
//   - timeoutTicks: safety cutoff; on expiry the plan aborts
//
// This is what makes plans robust rather than scripted: a hammer that never
// gets its pin never charges; if the enemy refuses to commit to the anvil,
// the plan aborts and the team returns to reactive behavior.
export class TeamPlan {
  constructor({ tactic, phases, objectiveUnitId, roles, stagingPoint, createdAtTick }) {
    if (!Array.isArray(phases) || phases.length === 0) {
      throw new Error('TeamPlan requires at least one phase');
    }
    this.tactic = tactic;
    this.phases = phases;
    this.phaseIndex = 0;
    this.phase = phases[0].name;
    this.phaseStartedTick = createdAtTick || 0;
    this.createdAtTick = createdAtTick || 0;
    this.objectiveUnitId = objectiveUnitId ?? null;
    this.roles = roles instanceof Map ? roles : new Map(Object.entries(roles || {}));
    this.stagingPoint = stagingPoint ?? null;

    this.completed = false;
    this.aborted = false;
    this.abortReason = null;

    // Set by PlanScheduler from tier config so abort timeouts can be
    // lengthened/shortened without mutating the plan object itself.
    this.abortThresholdMult = 1.0;
  }

  get currentPhaseDef() {
    return this.phases[this.phaseIndex];
  }

  // Called once per TeamAI decision cycle while this plan is active.
  // worldState must expose whatever the phases' exit conditions read
  // (typically: currentTick, enemyUnits, allSoldiers, teamUnits,
  //  pinDetector, formation, assessment, objectiveUnit).
  //
  // Returns { status: 'active' | 'advanced' | 'completed' | 'aborted', ... }.
  step(worldState) {
    if (this.completed || this.aborted) {
      return { status: this.completed ? 'completed' : 'aborted' };
    }

    const phaseDef = this.currentPhaseDef;
    const tick = worldState.currentTick;
    const elapsed = tick - this.phaseStartedTick;
    const timeout = Math.max(
      1,
      Math.round((phaseDef.timeoutTicks || 60) * this.abortThresholdMult)
    );

    // Exit condition takes precedence over timeout: a plan completing on
    // the same tick it would have timed out is a success, not a failure.
    let exit = false;
    try {
      exit = !!phaseDef.exitCondition(worldState, this);
    } catch (err) {
      // A throwing exit condition is a bug, not a plan failure. Abort
      // so the team falls back to reactive behavior, and surface it.
      this.aborted = true;
      this.abortReason = `exit condition threw: ${err.message}`;
      return { status: 'aborted', reason: this.abortReason };
    }

    if (exit) {
      this.phaseIndex++;
      if (this.phaseIndex >= this.phases.length) {
        this.completed = true;
        return { status: 'completed' };
      }
      this.phase = this.phases[this.phaseIndex].name;
      this.phaseStartedTick = tick;
      return { status: 'advanced', phase: this.phase };
    }

    if (elapsed >= timeout) {
      this.aborted = true;
      this.abortReason = `phase '${phaseDef.name}' timed out after ${elapsed} ticks`;
      return { status: 'aborted', reason: this.abortReason };
    }

    return { status: 'active' };
  }

  roleOf(unitId) {
    return this.roles.get(unitId) || null;
  }

  get summary() {
    return `tactic=${this.tactic} phase=${this.phase}(${this.phaseIndex + 1}/${this.phases.length}) ` +
           `objective=${this.objectiveUnitId} roles=${this.roles.size}`;
  }
}
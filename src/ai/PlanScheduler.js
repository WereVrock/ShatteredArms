// B1 — Plan scheduler. Owns the lifecycle of TeamPlan instances:
//   - deciding whether to create a new plan,
//   - advancing / aborting the current plan,
//   - and (via B3 + B4) picking between multiple viable candidates.
//
// Retreat is special-cased: it is sticky and cannot be preempted (see B1
// priority rules). Every other plan is subject to the tier's enabledPlans
// list, the B3 risk gate, and B4 weighted selection.
import { AIDebugLog } from './AIDebugLog.js';
import { TeamPlan } from './TeamPlan.js';
import { PinDetector } from './PinDetector.js';
import { PlanRiskGate } from './PlanRiskGate.js';
import { WeightedSelect } from './WeightedSelect.js';
import { RetreatPlan } from './plans/RetreatPlan.js';
import { CombinedArmsPlan } from './plans/CombinedArmsPlan.js';
import { HammerAndAnvilPlan } from './plans/HammerAndAnvilPlan.js';

const PLAN_MODULES = [CombinedArmsPlan, HammerAndAnvilPlan];
const RETREAT_MODULE = RetreatPlan;

export class PlanScheduler {
  constructor(teamId, tierCfg) {
    this.teamId = teamId;
    this.tierCfg = tierCfg;
    this.pinDetector = new PinDetector();

    // Cooldown after a plan aborts so the same tactic isn't re-created the
    // very next decision cycle. Without this, a plan whose exit condition
    // can't be reached (units too slow to cover the distance in the phase
    // timeout) enters an abort/re-create spin and the team never falls back
    // to reactive behavior. 120 ticks ≈ 8s at 15Hz — enough for the fight
    // around the units to change meaningfully before retrying.
    this._cooldownUntilByTactic = new Map();
    this._abortCooldownTicks = 120;
  }

  // Called once per decision cycle, from TeamAI._decide().
  // currentPlan: this TeamAI's _currentPlan (or null).
  // worldCtx: shared world context object; see TeamAI._decide.
  //
  // Returns the plan to carry into the next decision cycle (either the
  // advanced currentPlan, a freshly created plan, or null).
  update(currentPlan, worldCtx) {
    const tick = worldCtx.currentTick;
    const teamId = this.teamId;

    // Record this cycle's positions for the pin detector. Called every
    // cycle regardless of whether a plan is active — the history needs to
    // span the pin window even for a plan that starts mid-cycle.
    const allUnits = worldCtx.teamUnits.concat(worldCtx.enemyUnits || []);
    this.pinDetector.record(allUnits, tick);

    // Step the currently active plan (if any).
    if (currentPlan) {
      if (currentPlan.abortThresholdMult !== this.tierCfg.abortThresholdMult) {
        currentPlan.abortThresholdMult = this.tierCfg.abortThresholdMult;
      }
      const result = currentPlan.step(worldCtx);
      if (result.status === 'active') return currentPlan;
      if (result.status === 'advanced') {
        AIDebugLog.planPhase(tick, teamId, currentPlan.tactic, currentPlan.phase,
          currentPlan.phaseIndex + 1, currentPlan.phases.length);
        return currentPlan;
      }
      if (result.status === 'completed') {
        AIDebugLog.planDissolve(tick, teamId, currentPlan.tactic, 'completed');
        return null;
      }
      // aborted
      AIDebugLog.planDissolve(tick, teamId, currentPlan.tactic,
        `aborted: ${result.reason || currentPlan.abortReason || 'unknown'}`);
      this._cooldownUntilByTactic.set(
        currentPlan.tactic,
        tick + this._abortCooldownTicks
      );
      return null;
    }

    // No active plan. Retreat has priority and is not gated by B3/B4 — a
    // team losing badly MUST fall back, not gamble on a weighted roll.
    if (worldCtx.assessment && worldCtx.assessment.posture === 'retreat') {
      const cd = this._cooldownUntilByTactic.get(RETREAT_MODULE.id) || 0;
      if (tick >= cd) {
        const retreat = this._buildPlan(RETREAT_MODULE, worldCtx);
        if (retreat) {
          AIDebugLog.planCreate(tick, teamId, retreat.tactic, retreat.objectiveUnitId, retreat.roles.size);
          return retreat;
        }
      }
      return null;
    }

    // Non-retreat: build a candidate pool from enabled plans, apply B3,
    // then B4 weighted-select among survivors.
    const candidates = [];
    for (const module of PLAN_MODULES) {
      if (!this._isEnabled(module.id)) continue;
      const cd = this._cooldownUntilByTactic.get(module.id) || 0;
      if (tick < cd) continue;
      const evalResult = module.evaluate(worldCtx);
      if (!evalResult || !evalResult.applicable) continue;
      candidates.push({ module, eval: evalResult });
    }
    if (candidates.length === 0) return null;

    const gated = [];
    for (const c of candidates) {
      const gate = PlanRiskGate.evaluate(c.eval, this.tierCfg);
      if (!gate.allowed) {
        AIDebugLog.planGateRejected(tick, teamId, c.module.id, gate.reason);
        continue;
      }
      c.expectedValue = gate.expectedValue;
      gated.push(c);
    }
    if (gated.length === 0) return null;

    const picked = WeightedSelect.pick(gated, {
      getScore: (c) => c.expectedValue,
      qualityFloorFraction: this.tierCfg.qualityFloorFraction,
      temperature: this.tierCfg.softmaxTemperature
    });
    if (!picked) return null;

    const plan = this._buildPlan(picked.module, worldCtx, picked.eval);
    if (plan) {
      AIDebugLog.planCreate(tick, teamId, plan.tactic, plan.objectiveUnitId, plan.roles.size);
    }
    return plan;
  }

  _isEnabled(moduleId) {
    const list = this.tierCfg.enabledPlans;
    if (!Array.isArray(list)) return true;
    return list.indexOf(moduleId) !== -1;
  }

  _buildPlan(module, worldCtx, evalResult) {
    const built = module.build(worldCtx, evalResult, this);
    if (!built) return null;
    if (built instanceof TeamPlan) return built;
    // Modules may return a descriptor; wrap it.
    return new TeamPlan({ ...built, createdAtTick: worldCtx.currentTick });
  }
}
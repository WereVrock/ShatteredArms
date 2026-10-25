// Decides one team's unit orders. Intent-driven (see UnitIntent.js) so
// commitment-heavy decisions (cavalry charges) aren't re-rolled on the same
// cheap timescale as passive ones.
//
// This revision adds:
//   - Weak-point concentration: EnemyLineAnalysis picks the enemy's
//     weakest slice; a bounded fraction of our front-line units are biased
//     toward it (see _assignWeakPointBias), instead of every unit
//     independently chasing its own nearest enemy.
//   - Reserve deployment: units held back by BattleLineFormation's
//     'reserve' role are released into normal front-line behavior when a
//     gap opens nearby or a reinforcement need is flagged within
//     reserveDeployRadius.
//   - Focus fire: FocusFireCoordinator assigns one shared archer target
//     for the whole team, reassessed on its own slower cadence.
//   - Archer intercept: when SkirmisherBehavior flags threatUnitId on its
//     intent (a charge bearing down on it), TeamAI looks for the nearest
//     free line/reserve unit and redirects it to intercept, rather than
//     leaving archers to just outrun the horse on their own.
//   - A2: Reinforcement dispatch now goes through ReinforcementCoordinator
//     (winnability + suitability + deconfliction) instead of a per-unit
//     greedy override.
//   - A3: Cavalry same-flank coordination now goes through CavalryGroup —
//     each cavalry unit's group (with a stable, deterministic leader) is
//     built once per decision cycle and passed into FlankerBehavior in
//     place of the old pairwise sibling array.
//   - A4: fragile units (average morale below AIConfig.fragileMoraleThreshold)
//     are excluded from weak-point/objective concentration roles and from
//     reinforcement dispatch (enforced inside ReinforcementCoordinator), and
//     are routed to ReserveBehavior's fallback rally position instead of
//     their normal per-type behavior.
//   - Skirmisher cavalry-cover: BattleAssessment tracks own-vs-enemy
//     cavalry strength and exposes skirmishersWithoutCavalryCover; TeamAI
//     passes worldCtx (including a fresh infantryLineAnchor) to
//     SkirmisherBehavior so archers hold just in front of the melee line
//     when our cavalry screen is weaker than the enemy's.
import { AIConfig } from '../config/AIConfig.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { toSimSpeed } from '../config/SpeedScale.js';
import { getTierConfig, DEFAULT_AI_TIER } from '../config/AITierConfig.js';
import { isCavalry as isCavalryClass, isCavalryForAI as isCavalryForAIClass, isRanged as isRangedClass, isSwordsmen as isSwordsmenClass, getRangedRange } from '../config/UnitClasses.js';
import { PlanScheduler } from './PlanScheduler.js';
import { UnitBehaviorRegistry } from './UnitBehaviorRegistry.js';
import { UnitIntentRegistry } from './UnitIntent.js';
import { BattleAssessment } from './BattleAssessment.js';
import { EnemyLineAnalysis } from './EnemyLineAnalysis.js';
import { FocusFireCoordinator } from './FocusFireCoordinator.js';
import { ReinforcementCoordinator } from './ReinforcementCoordinator.js';
import { WinPlanner } from './WinPlanner.js';
import { CavalryGroup } from './CavalryGroup.js';
import { ArcherSupportCoordinator } from './ArcherSupportCoordinator.js';
import { LineAlarmDetector } from './LineAlarmDetector.js';
import { RangedPressureDetector } from './RangedPressureDetector.js';
import { ChargeReadiness } from './ChargeReadiness.js';
import { AIDebugLog } from './AIDebugLog.js';
import { unitTypeOf, centerTowardUnit, isFragile } from './behaviorUtils.js';

export class TeamAI {
  // valiantDefence: see BattleAssessment's constructor doc. Scenario-level
  // flag (set via BattleAI's valiantDefenceTeamIds option) — this team
  // computes posture normally but never acts on a 'retreat' reading; it
  // fights at full effort (press/hold) regardless of being outnumbered,
  // rather than withdrawing wholesale as an opening strategy. Tactical
  // repositioning (kiting, cavalry regroup, make-way) is untouched — none
  // of that reads posture.
  constructor(teamId, teamUnits, allUnits, formation, tierName, valiantDefence) {
    this.teamId = teamId;
    this.teamUnits = teamUnits;
    this.allUnits = allUnits;
    this.formation = formation || null;
    this.tickCounter = 0;
    this.valiantDefence = !!valiantDefence;

    // Difficulty tier — see src/config/AITierConfig.js. Both tiers run the
    // same machinery; only these parameters differ.
    this.tierName = tierName || DEFAULT_AI_TIER;
    this.tierCfg = getTierConfig(this.tierName);

    // Stage B plan layer. _currentPlan is null when no tactic is active —
    // which is the normal state, and behaviorally identical to pre-plan AI.
    this.planScheduler = new PlanScheduler(this.teamId, this.tierCfg);
    this._currentPlan = null;

    this.intents = new UnitIntentRegistry();

    // "Is our line under attack?" detector. Its result is published to
    // behaviors as worldCtx.lineUnderAttack each decision cycle.
    this.lineAlarm = new LineAlarmDetector();

    // "Is our line being outshot by ranged units nothing is engaging?"
    // detector. Published as worldCtx.rangedPressureTargets (array of enemy
    // shooter units, or null) each decision cycle.
    this.rangedPressure = new RangedPressureDetector();
    this.assessment = null;

    // Stance: computed once from the first assessment's strengthRatio
    // (see _decide). Held for the remainder of the battle — a team does
    // not flip between attacking and defending based on momentary reads.
    // 'offence' = advance the line in cohesion toward the enemy;
    // 'defence' = hold position and let the enemy come to us. Null
    // until the first assessment runs.
    this._stance = null;

    // Reserve state: set of unitIds currently held as reserve. Recomputed
    // from formation contexts each decision cycle, but a unit REMOVED from
    // this set (deployed) stays removed even if formation would otherwise
    // still classify it as reserve — deployment is one-way for the
    // remainder of the battle, matching how a real reserve commitment works.
    this._deployedReserveIds = new Set();

    // Archer-pressure re-check state. Tracks the previous decision cycle's
    // effective-combatant count for this team, so a drop between cycles
    // can trigger a ranged-power re-comparison. Null until the first
    // cycle that runs with _stance set. See _decide for the check.
    this._lastEffectiveCombatantCount = null;

    // Envelopment hold-tracking state. Maps enemyUnitId -> the tick the
    // unit FIRST satisfied the envelopment conditions (behind/beside,
    // in detect range, not currently fighting). An entry is removed the
    // moment the unit stops satisfying those conditions; a flip only
    // fires when a single unit has held continuously for
    // AIConfig.envelopmentMinHoldTicks. See _decide and
    // _qualifyingEnvelopmentCandidates.
    this._envelopmentCandidateSince = new Map();

    // Activity-wide router-chase cooldown. Set when any cav fails its
    // 20% roll; read by every cav in _tryRouterChase via worldCtx.
    // Overridden when team power reaches routerChaseOverridePowerRatio.
    this._routerChaseCooldownUntilTick = -Infinity;

    // Map from unit id to Unit reference, built once at construction.
    // Used by onVolleyFired to resolve a unitId to the unit whose pending
    // reposition should be applied — the handler runs on the sim's
    // volley-fired hook, not on the AI decision cycle, so it cannot
    // afford to scan teamUnits. Also used by the ranged decision
    // dispatcher if a lookup path ever needs it.
    this._unitById = new Map(teamUnits.map(u => [u.id, u]));
  }

  // Plan-role dispatch. Given a unit and the active plan, returns an
  // { x, z, facing } order if the plan wants to direct this unit this
  // cycle, or null to fall through to normal per-type behavior.
  //
  // Role vocabulary is shared across plans — a 'hammer' role in
  // hammer-and-anvil behaves like a 'hammer' role in any future plan that
  // uses the same word. New roles are added by extending this switch.
  _planRoleOrder(unit, plan, worldCtx, enemyUnits) {
    const role = plan.roles.get(unit.id);
    if (!role) return null;

    const phase = plan.phase;
    const objective = plan.objectiveUnitId
      ? enemyUnits.find(u => u.id === plan.objectiveUnitId)
      : null;

    switch (role) {
      case 'anvil':
      case 'bombard':
        if (!objective || objective.isDefeated()) return null;
        return this._orderToward(unit, objective.getCenter(), worldCtx, enemyUnits);

      case 'staging':
        // Combined-arms: cavalry holds at staging during bombard, charges
        // during charge/exploit.
        if (phase === 'bombard') return this._orderToward(unit, plan.stagingPoint, worldCtx, enemyUnits);
        if (!objective || objective.isDefeated()) return null;
        // Gate the charge order through ChargeReadiness — same corridor
        // check FlankerBehavior applies. Without this, a plan in charge/
        // exploit walks the cav at objective.getCenter() with no corridor
        // awareness, straight through any spear screen in the way.
        return this._orderTowardGated(unit, objective, plan, worldCtx, enemyUnits);

      case 'hammer':
        if (phase === 'advance' || phase === 'pin') {
          return this._orderToward(unit, plan.stagingPoint, worldCtx, enemyUnits);
        }
        if (phase === 'strike' || phase === 'exploit') {
          if (!objective || objective.isDefeated()) return null;
          return this._orderTowardGated(unit, objective, plan, worldCtx, enemyUnits);
        }
        return null;

      case 'rally':
      case 'screen':
        // Retreat plan: pull back / hold at the rally line.
        return this._orderToward(unit, plan.stagingPoint, worldCtx, enemyUnits);

      case 'hold':
        // Hold position — issue no order; the caller still consumes the
        // turn so normal reactive behavior does not resume.
        return null;

      default:
        return null;
    }
  }

  _orderToward(unit, pos, worldCtx, enemyUnits) {
    if (!pos) return null;
    const c = unit.getCenter();
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < AIConfig.slotArrivalRadius) return null;

    // Corridor check for cavalry. Any cav move-to-point order — plan
    // staging, hold, retreat rally, etc. — goes through this check, not
    // just ChargeReadiness-gated charges. Without it, a plan role like
    // combined_arms 'staging' walks the cav straight at a spear screen
    // because it never runs FlankerBehavior at all (the plan role blocks
    // per-type behavior for this unit — see TeamAI._decide).
    //
    // On a block, returns { blocked: true } — a distinct signal from
    // `null`. `null` means "no order needed" (already at the destination,
    // or no destination given) and the caller is free to consume the
    // turn. `{ blocked: true }` means "the plan wants me to go
    // somewhere, but I can't get there" — the caller should fall
    // through to the unit's normal per-type behavior so it can ask for
    // a new plan. Conflating the two is what caused the cav to freeze
    // in place after the last patch: `_decide` treated `null` (blocked)
    // the same as `null` (arrived) and just `continue`d.
    //
    // Fires a corridor debug event on every check (refused or clean) so
    // a G-selected cav's plan-driven movements are visible in the
    // corridor debug view.
    const typeDef = unit.soldiers[0]?.unitTypeDef;
    const isCavalry = !!(typeDef && isCavalryClass(typeDef));
    if (isCavalry && worldCtx && enemyUnits) {
      const blocked = this._isCavPathBlockedBySpears(
        unit, pos.x, pos.z, dist, worldCtx, enemyUnits
      );
      if (blocked) {
        AIDebugLog.log('charge', worldCtx.currentTick,
          `cav=${unit.id} BLOCKED path to (${pos.x.toFixed(1)},${pos.z.toFixed(1)}) by enemy spear corridor — requesting new orders`);
        return { blocked: true };
      }
    }

    return { x: pos.x, z: pos.z, facing: Math.atan2(dx, dz) };
  }

  // Corridor geometry for a cav move-to-point order. Same half-width and
  // perpendicular-band check as ChargeReadiness._countBracedSpearmenInCorridor,
  // but not gated on the spear being able to brace in time — an enemy
  // spear in the path is an obstacle regardless of whether the spear
  // would turn to meet the charge. A count of 1 is enough to block: the
  // cav should never walk into even a single spearman on its way to a
  // non-charge destination.
  //
  // Fires AIDebugLog.corridorEvent with `refused` set, so the corridor
  // debug view can render the geometry. targetUnitId is null because
  // there is no target unit for a staging / hold order — the view only
  // reads the two endpoints, so null is fine.
// Corridor geometry for a cav move-to-point order. Same half-width and
  // perpendicular-band check as ChargeReadiness._countBracedSpearmenInCorridor,
  // but not gated on the spear being able to brace in time — an enemy
  // spear in the path is an obstacle regardless of whether the spear
  // would turn to meet the charge.
  //
  // Overwhelming gate: mirror of the charge-corridor rule. If the cav
  // unit's non-routing alive count is >= AIConfig.corridorOverwhelmingRatio
  // times the non-routing spear count in the path, the path is treated as
  // unblocked — one spear cannot stop a full cavalry unit from walking
  // through. Below the ratio, a single spear still blocks (the original
  // conservative rule); this exists purely to stop a lone straggler from
  // vetoing a massed move.
  //
  // Fires AIDebugLog.corridorEvent with `refused` / `overwhelmed` set, so
  // the corridor debug view can render the geometry distinctly. targetUnitId
  // is null because there is no target unit for a staging / hold order —
  // the view only reads the two endpoints, so null is fine.
  _isCavPathBlockedBySpears(unit, toX, toZ, dist, worldCtx, enemyUnits) {
    const c = unit.getCenter();
    const dirX = (toX - c.x) / dist;
    const dirZ = (toZ - c.z) / dist;
    // Widened corridor (AIConfig.corridorWidthMultiplier, default 2x).
    // The original half-width was tuned to the exact line between cav
    // and destination; a spear a few units off that line is invisible
    // until the cav has already closed past the point where it can
    // disengage. Widening catches the near-path spears one cycle
    // earlier, which is the cycle that matters.
    const halfWidth = CombatConfig.charge.corridorHalfWidth *
      (AIConfig.corridorWidthMultiplier ?? 2.0);
    const halfWidthSq = halfWidth * halfWidth;

    let spearCount = 0;
    for (const eu of enemyUnits) {
      if (eu.isDefeated()) continue;
      for (const s of eu.getAliveSoldiers()) {
        if (s.unitTypeDef.weaponType !== 'spear') continue;
        if (s.isRouting) continue;
        // Engaged spearmen cannot turn to receive a charge — they are
        // fighting someone else and the sim will not let them plant a
        // shaft. Excluding them removes bodies that cannot actually
        // block from the corridor count.
        if (s.isInMelee()) continue;
        const sx = s.pos.x - c.x;
        const sz = s.pos.z - c.z;
        const along = sx * dirX + sz * dirZ;
        if (along <= 0 || along >= dist) continue;
        const perpX = sx - along * dirX;
        const perpZ = sz - along * dirZ;
        if (perpX * perpX + perpZ * perpZ > halfWidthSq) continue;
        spearCount++;
      }
    }

    let blocked = false;
    let overwhelmed = false;
    if (spearCount > 0) {
      const cavStrength = unit.getAliveSoldiers().filter(s => !s.isRouting).length;
      if (cavStrength >= spearCount * AIConfig.corridorOverwhelmingRatio) {
        overwhelmed = true;
      } else {
        blocked = true;
      }
    }

    AIDebugLog.corridorEvent({
      attackerUnitId: unit.id,
      targetUnitId: null,
      cavX: c.x,
      cavZ: c.z,
      defX: toX,
      defZ: toZ,
      halfWidth,
      refused: blocked,
      overwhelmed,
      // Path-blocking corridor has no skip policy — it always runs.
      // The flag is present for shape consistency so the debug view
      // doesn't have to null-guard for the two emitters.
      skipped: false,
      skipReason: null
    });

    return blocked;
  }

  // Like _orderToward, but for cavalry moving toward an enemy objective:
  // runs ChargeReadiness first and, if the corridor is blocked, holds at
  // staging instead of walking into the spear screen. Mirrors the gate in
  // FlankerBehavior._decideSeeking so plan-driven charge orders and
  // reactive charge orders apply the same rule. Non-cav roles (anvil,
  // bombard, screen) are unaffected — they aren't subject to the corridor
  // check and don't need the read.
  //
  // The staging fallback is intentional: returning null would freeze the
  // unit in place with a stale formationSlot, and returning the raw
  // objective order is what this method exists to prevent.
  _orderTowardGated(unit, targetUnit, plan, worldCtx, enemyUnits) {
    const typeDef = unit.soldiers[0]?.unitTypeDef;
    const isCavalry = !!(typeDef && isCavalryClass(typeDef));
    if (!isCavalry) return this._orderToward(unit, targetUnit.getCenter(), worldCtx, enemyUnits);

    const readiness = ChargeReadiness.assess(unit, targetUnit, enemyUnits, 0, worldCtx);
    if (!readiness.willLandClean) {
      AIDebugLog.log('plan', worldCtx.currentTick,
        `role order blocked for ${unit.id} → holding at staging (reason="${readiness.reason}")`);
      if (plan.stagingPoint) return this._orderToward(unit, plan.stagingPoint, worldCtx, enemyUnits);
      return null;
    }
    return this._orderToward(unit, targetUnit.getCenter(), worldCtx, enemyUnits);
  }

  tick() {
    // Per-tier decision cadence. Resolved once per tick so a tier config
    // edit at runtime (devtools) takes effect on the next tick without
    // restarting the battle. Falls back to the global AIConfig value
    // when a tier omits the field, so a future tier config cannot
    // accidentally freeze the AI by forgetting it.
    //
    // This is the ONLY cadence the difficulty tier changes. Assessment
    // and focus-fire keep their global intervals: a slower-deciding
    // weakened team still measures the world at the normal rate, so
    // when it does decide it is acting on fresh data. The handicap is
    // latency, not blind guessing.
    const decisionInterval = this.tierCfg.decisionIntervalTicks
      ?? AIConfig.decisionIntervalTicks;

    if (this.tickCounter % AIConfig.assessmentIntervalTicks === 0) {
      this._updateAssessment();
    }
    if (this.tickCounter % decisionInterval === 0) {
      this._decide();
    }
    if (this.tickCounter % AIConfig.focusFireReassessTicks === 0) {
      this._updateFocusFire();
    }
    this.tickCounter++;
  }

  _updateAssessment() {
    const enemyUnits = this.allUnits.filter(u => u.teamId !== this.teamId);
    this.assessment = new BattleAssessment(
      this.teamId, this.teamUnits, enemyUnits, this.valiantDefence, this.tierCfg
    );
    AIDebugLog.posture(this.tickCounter, this.teamId, this.assessment.posture, this.assessment.strengthRatio, this.assessment.moraleAdvantage);
    if (this.valiantDefence && this.assessment.rawPosture === 'retreat' && this.assessment.posture !== 'retreat') {
      AIDebugLog.log('posture', this.tickCounter,
        `team=${this.teamId} VALIANT DEFENCE clamped rawPosture=retreat -> ${this.assessment.posture} (strengthRatio=${this.assessment.strengthRatio.toFixed(2)})`);
    }
  }

  _updateFocusFire() {
    const archerUnits = this.teamUnits.filter(u => {
      if (u.isDefeated()) return false;
      const type = unitTypeOf(u);
      return type && isRangedClass(type);
    });
    const enemyUnits = this.allUnits.filter(u => u.teamId !== this.teamId && !u.isDefeated());
    // Pass the current team objective (computed by the last _decide() call,
    // may be one interval stale here since focus-fire reassesses on its own
    // faster cadence — acceptable, this is a preference not a hard lock)
    // so archer fire concentrates on the same target the rest of the team
    // is converging on, when that target is actually reachable by them.
    // C3: posture profile widens/narrows FocusFireCoordinator's candidate
    // pool (press opens tier 2/3 alongside tier 1 instead of insisting on
    // the most-wounded target).
    FocusFireCoordinator.assign(archerUnits, enemyUnits, this._currentObjectiveUnit || null, this._postureProfile(), this.tierCfg);
  }

  // C3: resolves this cycle's posture-conditional parameter set from
  // AIConfig.posture, keyed off the last computed assessment. Falls back
  // to 'hold' (today's defaults) when no assessment exists yet or posture
  // is 'retreat' — a retreating team has no business pressing harder, it
  // just uses the neutral profile while RetreatPlan / _holdOrRetreatLine
  // handle withdrawal.
  _postureProfile() {
    const posture = this.assessment ? this.assessment.posture : 'hold';
    const base = AIConfig.posture[posture] || AIConfig.posture.hold;
    // Tier-level overrides: a tier may dial individual posture parameters
    // up or down without touching the shared defaults. Best-possible
    // leaves this undefined (no-op); weakened uses it to refuse more
    // charges under hold posture. Missing-key discipline means a tier
    // that only overrides one parameter inherits every other value from
    // AIConfig.posture — no duplication, no drift.
    const overrides = this.tierCfg.postureOverrides?.[posture];
    return overrides ? { ...base, ...overrides } : base;
  }

  // Sum of ranged power across a set of units. Symmetric — used for both
  // our own team and the enemy team, so the ratio comparison is apples-to-
  // apples by construction. See Unit.getRangedPower for the per-unit
  // contribution and its exclusions (routing / shattered soldiers do not
  // count on either side, since they do not fire).
  _sumRangedPower(units) {
    let sum = 0;
    for (const u of units) {
      if (u.isDefeated()) continue;
      sum += u.getRangedPower();
    }
    return sum;
  }

  // Count of soldiers on a team still in a fighting state — alive and NOT
  // routing or shattered. Used as the trigger for the archer-pressure
  // re-check (see _decide): a drop between decision cycles means the
  // tactical situation just got worse and the ranged-power comparison is
  // worth re-reading. Uses the same predicate Unit.getRangedPower excludes
  // on, so the two reads stay in sync by construction.
  _effectiveCombatantCount(units) {
    let count = 0;
    for (const u of units) {
      if (u.isDefeated()) continue;
      for (const s of u.soldiers) {
        if (!s.isAlive()) continue;
        if (s.state === 'routing' || s.state === 'shattered') continue;
        count++;
      }
    }
    return count;
  }

  // Does the enemy team currently have a decisive ranged-power advantage?
  // See AIConfig.archerPressureFlipRatio for the threshold and rationale.
  // Zero own power is handled explicitly: a team with no ranged units at
  // all flips under any nonzero enemy ranged power, because "we cannot
  // shoot back and they can" is the exact scenario this mechanism is
  // designed to escape.
  _shouldFlipForArcherPressure(enemyUnits) {
    const own = this._sumRangedPower(this.teamUnits);
    const enemy = this._sumRangedPower(enemyUnits);
    if (enemy <= 0) return false;
    if (own <= 0) return true;
    return enemy >= own * AIConfig.archerPressureFlipRatio;
  }

  // Envelopment candidates: which enemy units currently satisfy ALL the
  // geometric, proximity, and eligibility conditions for the
  // defence->offence flip?
  //
  // Conditions, all required:
  //   1. NOT currently fighting one of our units. A unit with any
  //      engaged or staggered soldier is already committed somewhere —
  //      it's not a flanking threat, it's a fight. Also filters the
  //      case where a charging cavalry briefly ends up behind our line
  //      while in melee with someone.
  //   2. FLANKING, i.e. beyond AIConfig.envelopmentFlankAngleDeg (75°)
  //      from our line's forward axis, measured from our team mean. This
  //      is an ANGLE test, not a lateral-span test — a wider-but-still-
  //      in-front enemy line sits at 10-25° off-axis and never qualifies,
  //      while a flanker swinging around the side crosses 75° and does.
  //   3. WITHIN detect range (AIConfig.envelopmentDetectRangeMult ×
  //      CombatConfig.rangedRange) of our nearest unit, measured center
  //      to center. Filters far-away flankers who aren't yet a threat.
  //
  // Returns Map<enemyUnitId, { dist, angle, forward, lateral }>. Empty map
  // when nothing qualifies. The hold-time accumulation is done by the
  // caller (see _decide), not here — this method answers "who qualifies
  // right now", the caller answers "for how long".
  //
  // Runs every decision cycle while _stance === 'defence'.
  //
  // Debug: enable the 'envelop' category to see every enemy unit's
  // measurements each cycle (angle from forward, distance to nearest of
  // our units, in-combat flag, and the rejection reason if any).
  _qualifyingEnvelopmentCandidates(enemyUnits) {
    const out = new Map();
    if (!this.formation) return out;

    const axis = this.formation.getLineAxis(this.teamUnits, enemyUnits);
    if (!axis) return out;

    const fwdX = axis.fwdX;
    const fwdZ = axis.fwdZ;
    const rightX = axis.rightX;
    const rightZ = axis.rightZ;

    // Reference point for the angle test: mean of our LINE units only —
    // non-cavalry, non-ranged. The previous version used the whole team
    // mean, which included skirmishing archers that sit BEHIND the line
    // and drift as they respond to standoff. That biased the reference
    // backward and sideways, so "is this enemy behind or beside the
    // line" was answered against a moving target rather than the line
    // itself. Cavalry is excluded for the same reason — they drift
    // laterally and would bias the reference sideways.
    //
    // Fallback: if no line unit is alive (all-cavalry / all-archer team,
    // or the line was wiped), use the whole team mean so the check
    // never silently dies.
    let sumX = 0, sumZ = 0, ownCount = 0;
    for (const u of this.teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (t && (isCavalryClass(t) || isRangedClass(t))) continue;
      const c = u.getCenter();
      sumX += c.x;
      sumZ += c.z;
      ownCount++;
    }
    if (ownCount === 0) {
      for (const u of this.teamUnits) {
        if (u.isDefeated()) continue;
        const c = u.getCenter();
        sumX += c.x;
        sumZ += c.z;
        ownCount++;
      }
    }
    if (ownCount === 0) return out;
    const meanX = sumX / ownCount;
    const meanZ = sumZ / ownCount;

    const detectRange = CombatConfig.rangedRange * AIConfig.envelopmentDetectRangeMult;
    const detectRangeSq = detectRange * detectRange;
    const flankAngle = AIConfig.envelopmentFlankAngleDeg;

    const shouldLog = AIDebugLog.enabled && AIDebugLog._shouldLog('envelop');
    const logLines = shouldLog ? [] : null;

    for (const enemy of enemyUnits) {
      if (enemy.isDefeated()) continue;

      const ec = enemy.getCenter();
      const dx = ec.x - meanX;
      const dz = ec.z - meanZ;

      const toEnemyFwd = dx * fwdX + dz * fwdZ;
      const toEnemyLat = dx * rightX + dz * rightZ;
      const angleDeg = Math.abs(Math.atan2(toEnemyLat, toEnemyFwd) * 180 / Math.PI);

      let closestDistSq = Infinity;
      for (const u of this.teamUnits) {
        if (u.isDefeated()) continue;
        const c = u.getCenter();
        const ddx = ec.x - c.x;
        const ddz = ec.z - c.z;
        const dSq = ddx * ddx + ddz * ddz;
        if (dSq < closestDistSq) closestDistSq = dSq;
      }
      const dist = Math.sqrt(closestDistSq);
      const inCombat = this._unitIsInCombat(enemy);

      let reason = null;
      if (inCombat) reason = 'in-combat';
      else if (angleDeg < flankAngle) reason = 'too-forward';
      else if (closestDistSq > detectRangeSq) reason = 'out-of-range';

      if (reason === null) {
        out.set(enemy.id, {
          dist,
          angle: angleDeg,
          forward: toEnemyFwd,
          lateral: toEnemyLat
        });
      }

      if (logLines) {
        logLines.push(
          `e=${enemy.id} ang=${angleDeg.toFixed(0)} fwd=${toEnemyFwd.toFixed(1)} ` +
          `lat=${toEnemyLat.toFixed(1)} dist=${dist.toFixed(1)} ` +
          `combat=${inCombat ? 1 : 0} ${reason ? `REJ(${reason})` : 'QUAL'}`
        );
      }
    }

    if (logLines) {
      AIDebugLog.log('envelop', 0,
        `team=${this.teamId} mean=(${meanX.toFixed(1)},${meanZ.toFixed(1)}) ` +
        `own=${ownCount} detectRange=${detectRange.toFixed(1)} flankAngle=${flankAngle} | ` +
        logLines.join(' | '));
    }

    return out;
  }

  _decide() {
    const enemyUnits = this.allUnits.filter(
      u => u.teamId !== this.teamId && !u.isDefeated()
    );

    const validUnitIds = new Set(this.teamUnits.map(u => u.id));
    this.intents.pruneMissing(validUnitIds);

    if (enemyUnits.length === 0) return;
    if (!this.assessment) this._updateAssessment();

    // Initial stance, committed once and held for the whole battle —
    // with one exception: if the enemy has a decisive ranged-power
    // advantage, defence is a losing stance from tick 0 (we stand and
    // get shot). See AIConfig.archerPressureFlipRatio. This gate runs
    // only at commit time; ongoing pressure is handled by the re-check
    // block below.
    if (this._stance === null) {
      const strengthStance = this.assessment.strengthRatio >= AIConfig.offenceStrengthRatio
        ? 'offence'
        : 'defence';
      const archerPressureFlip = strengthStance === 'defence' &&
        this._shouldFlipForArcherPressure(enemyUnits);
      this._stance = archerPressureFlip ? 'offence' : strengthStance;
      AIDebugLog.log('posture', this.tickCounter,
        `team=${this.teamId} STANCE=${this._stance} (initial strengthRatio=${this.assessment.strengthRatio.toFixed(2)}` +
        `${archerPressureFlip ? ', archerPressure=flip' : ''})`);
    }

    // Archer-pressure re-check. While on defence, any drop in effective
    // combatants (deaths, routs, shatters — a soldier that stops fighting
    // counts as a loss for this trigger) is a prompt to re-compare ranged
    // power against the enemy. If the enemy's ranged output now exceeds
    // ours by the flip ratio, transition to offence permanently: a
    // defensive team standing under sustained arrow fire is exactly the
    // "wait to get killed" failure this mechanism exists to prevent.
    //
    // Once _stance is 'offence', this never runs again. There is no
    // offence->defence path — a decision to close distance under ranged
    // pressure must not be second-guessed on the next casualty.
    if (this._stance === 'defence') {
      const currentCombatants = this._effectiveCombatantCount(this.teamUnits);
      const combatantLoss = this._lastEffectiveCombatantCount !== null &&
                            currentCombatants < this._lastEffectiveCombatantCount;

      // Trigger 1: archer pressure after combatant loss. Existing
      // mechanism — the enemy's ranged edge only becomes decisive once
      // we've started taking real casualties.
      if (combatantLoss && this._shouldFlipForArcherPressure(enemyUnits)) {
        this._stance = 'offence';
        const own = this._sumRangedPower(this.teamUnits);
        const enemy = this._sumRangedPower(enemyUnits);
        AIDebugLog.log('posture', this.tickCounter,
          `team=${this.teamId} STANCE FLIP defence->offence reason=archerPressure ` +
          `ownRangedPower=${own.toFixed(1)} enemyRangedPower=${enemy.toFixed(1)} ` +
          `combatants=${currentCombatants}(was ${this._lastEffectiveCombatantCount})`);
      }
      // Trigger 2: envelopment — an enemy unit behind or beside our
      // line, within detect range. Runs every decision cycle, NOT gated
      // on combatant loss: the flanker's positioning itself is the
      // signal. Waiting for casualties before reacting is exactly the
      // delay that makes a flank so effective against a static defence,
      // and red's cavalry in particular cannot engage a walking flanker
      // at all (see FlankerBehavior._isValidCavalryTarget — enemies not
      // already in melee are not valid targets). Flipping to offence
      // forces the fight into a shape red's units can actually respond
      // to.
      else {
        const candidates = this._qualifyingEnvelopmentCandidates(enemyUnits);

        // Prune entries for units no longer qualifying. This is the
        // "uninterrupted" half of the check: a flanker that steps out of
        // range, gets into a fight, or swings back in front of our line
        // loses its accumulated hold time and restarts from zero if it
        // qualifies again later.
        for (const id of Array.from(this._envelopmentCandidateSince.keys())) {
          if (!candidates.has(id)) this._envelopmentCandidateSince.delete(id);
        }

        // Register newly-qualifying units with the tick they first
        // qualified.
        for (const id of candidates.keys()) {
          if (!this._envelopmentCandidateSince.has(id)) {
            this._envelopmentCandidateSince.set(id, this.tickCounter);
          }
        }

        // Flip if any tracked unit has held for the full duration.
        for (const [id, since] of this._envelopmentCandidateSince) {
          if (this.tickCounter - since >= AIConfig.envelopmentMinHoldTicks) {
            this._stance = 'offence';
            const info = candidates.get(id);
            AIDebugLog.log('posture', this.tickCounter,
              `team=${this.teamId} STANCE FLIP defence->offence reason=envelopment ` +
              `triggerUnit=${id} heldTicks=${this.tickCounter - since} ` +
              `dist=${info.dist.toFixed(1)} lateral=${info.lateral.toFixed(1)} forward=${info.forward.toFixed(1)}`);
            this._envelopmentCandidateSince.clear();
            break;
          }
        }
      }

      this._lastEffectiveCombatantCount = currentCombatants;
    }

    const contexts = this.formation
      ? this.formation.computeContexts(this.teamUnits, enemyUnits)
      : null;

    const allSoldiers = this._allSoldiersOfBothSides(enemyUnits);
    const ownFallbackPoint = this._computeOwnFallbackPoint();
    const teamAnchor = this._computeTeamAnchor();
    // Infantry-line data for skirmisher cavalry-cover logic. Excludes both
    // cavalry AND ranged, so `anchor` is the melee line's mean rather than
    // the whole team's — archers positioning relative to a mean that
    // includes themselves would feedback-loop every time they moved.
    // `units` is the list of line units themselves, used by the unleash
    // rule to test "is any enemy within X of a line unit".
    const infantryLineData = this._computeInfantryLineData();
    const infantryLineAnchor = infantryLineData.anchor;
    // Ranged tether. True when one or more friendly ranged units have
    // drifted past the tether distance from the melee line. LineBehavior
    // reads this via worldCtx and advances instead of holding, so the
    // archers' cover follows them forward. See _computeRangedOverextended
    // and SkirmisherBehavior._isBeingOutranged for the archer-side half
    // of the rule.
    const rangedOverextended = this._computeRangedOverextended(infantryLineData);
    // Team-wide ranged-outranged flag. When true, SkirmisherBehavior
    // releases EVERY archer from hug — the enemy's reach advantage is
    // a formation-level fact, not a per-archer one.
    const rangedUnderFire = this._rangedUnderFire(infantryLineData.rangedUnits, enemyUnits);
    const lineUnderAttack = this.lineAlarm.update(
      infantryLineData.units, enemyUnits, this.tickCounter
    );

    const worldCtx = {
      currentTick: this.tickCounter,
      // Difficulty-tier config for this team. Read by behaviors whose
      // parameters vary per tier (LineAssault local-threat radius,
      // ChargeReadiness corridor skip, FlankerBehavior alternative
      // limit, FocusFireCoordinator preference override). Centralized
      // here so call sites that already receive worldCtx don't need
      // another constructor/signature change.
      tierCfg: this.tierCfg,
      allSoldiers,
      ownFallbackPoint,
      // Initial battle stance (offence / defence), read by LineBehavior
      // to decide whether to advance the line or hold it.
      stance: this._stance,
      // Team's mean alive-unit center. FlankerBehavior uses this (plus
      // the unit's formation context offsets) to walk to its flank slot
      // when it has no valid target yet — otherwise cavalry would sit
      // at spawn until something entered charge range.
      teamAnchor,
      // Mean of the team's living MELEE line (excludes cavalry + ranged).
      // SkirmisherBehavior reads this under the no-cavalry-cover flag to
      // position archers just in front of the line. May be null if no
      // line units survive — the fallback handles that by falling through
      // to normal standoff behavior.
      infantryLineAnchor,
      // The line units themselves. SkirmisherBehavior's unleash rule uses
      // this to test whether any enemy sits within the unleash bubble
      // around a line unit (see skirmisherUnleashRangeMult). Empty array
      // (not null) when no line units survive, so the caller can iterate
      // without a null-check.
      infantryLineUnits: infantryLineData.units,
      // Ranged tether flag. When true, LineBehavior skips its defence
      // hold and lets the cohesion/target paths advance, so the line
      // follows archers that sallied past the tether to return fire.
      // See _computeRangedOverextended and SkirmisherBehavior's tether
      // release for the two halves of this rule.
      rangedOverextended,
      // Team-wide "any archer being outranged" flag. Read by
      // SkirmisherBehavior to release the WHOLE archer formation from
      // hug, not just the individual archer being shot at. Distinct
      // from rangedOverextended above: that one is about archers that
      // have already sallied and need the line to follow; this one is
      // about archers that haven't moved yet and need releasing.
      rangedUnderFire,
      // Ranged units on this team. Read by ChargeReadiness's corridor-skip
      // policy: a team with neither a melee line NOR ranged units has no
      // way to ever soften or pin a spear formation, so the corridor check
      // must not block the cavalry's only offensive option. See
      // ChargeReadiness.shouldSkipCorridor.
      rangedUnits: infantryLineData.rangedUnits,
      // C3: posture-conditional ChargeReadiness leniency, read by
      // FlankerBehavior.decide(). Resolved once per cycle here so every
      // cavalry unit's decision this cycle uses the same value.
      postureChargeLeniency: this._postureProfile().chargeReadinessLeniency || 0,
      // True while a line unit is in melee or an enemy melee unit is on top
      // of the line. LineBehavior switches to direct attack when set, and
      // plan 'hold' roles are released (see _isHoldReleased).
      lineUnderAttack,
      // Enemy units (already computed at the top of _decide). Behaviors
      // that need to iterate enemy units without receiving them as a
      // parameter — FlankerBehavior._tryRouterChase is called from
      // _decideRegrouping which historically did not take enemyUnits —
      // read them here.
      enemyUnits,
      // This team's own Unit list. Behaviors that resolve a friendly unit
      // by id — most importantly FlankerBehavior._decideEscort, which
      // looks up each archer unit id it has been assigned to protect, and
      // _cavGroupCentroid, which needs the team's cavalry roster — read
      // this. Distinct from infantryLineUnits below, which is a NARROWER
      // line-only list (excludes archers and cavalry); conflating the two
      // silently breaks escort duty and mass-charge staging.
      teamUnits: this.teamUnits,
      // Effective combatant counts (alive non-routing, non-shattered).
      // Read by router-chase power checks: own-vs-enemy ratio uses the
      // same predicate on both sides so the comparison is apples-to-
      // apples. Computed once per decision cycle here, not per cav unit.
      ownEffectiveCount: this._effectiveCombatantCount(this.teamUnits),
      enemyEffectiveCount: this._effectiveCombatantCount(enemyUnits),
      // Router-chase tier mode ('smart' | 'simple'). Read by
      // FlankerBehavior._tryRouterChase to pick between the seven-check
      // gate and the corridor-only gate.
      routerChaseMode: this.tierCfg.routerChaseMode || 'smart',
      // Activity-wide cooldown expiry tick. Read by _canChaseRouter;
      // written via setRouterChaseCooldown below so per-cycle worldCtx
      // copies cannot lose the write.
      routerChaseCooldownUntil: this._routerChaseCooldownUntilTick
    };

    // Callback so behaviors can push the router-chase cooldown back onto
    // this TeamAI. Attached AFTER the literal so the write target is a
    // real instance field, not a per-cycle worldCtx copy.
    const self = this;
    worldCtx.setRouterChaseCooldown = function (untilTick) {
      self._routerChaseCooldownUntilTick = untilTick;
    };

    // Ranged pressure needs worldCtx itself (ChargeReadiness reads its team
    // composition fields), so it is evaluated after worldCtx is built and
    // attached to it. Always an array or null, never an empty array.
    worldCtx.rangedPressureTargets = this.rangedPressure.update({
      tick: this.tickCounter,
      lineUnits: infantryLineData.units,
      ownUnits: this.teamUnits,
      enemyUnits,
      intents: this.intents,
      worldCtx
    });

    worldCtx.rangedPressureAssignments = this._assignRangedPressureChasers(
      infantryLineData.units,
      worldCtx.rangedPressureTargets,
      contexts
    );

    this._updateReserveDeployment(contexts, enemyUnits);

    // Single shared team objective for this decision cycle. Every
    // subsystem below (line concentration, cavalry, focus fire) consults
    // this FIRST — this is what replaces four independently-guessing
    // heuristics with one coherent plan.
    const { objectiveUnit } = WinPlanner.plan(this.teamUnits, enemyUnits, this.formation, this.teamId, this.tickCounter);
    this._currentObjectiveUnit = objectiveUnit; // exposed for _updateFocusFire

    // Stage B plan layer: advance or create a team plan BEFORE per-unit
    // logic. A plan's objective overrides WinPlanner's — the plan scheduler
    // is authoritative when active (it may keep WinPlanner's objective, or
    // pick something else based on the tactic).
    const planWorldCtx = {
      currentTick: this.tickCounter,
      teamId: this.teamId,
      teamUnits: this.teamUnits,
      enemyUnits,
      allSoldiers,
      contexts,
      formation: this.formation,
      assessment: this.assessment,
      ownFallbackPoint,
      teamAnchor,
      objectiveUnit,
      intents: this.intents,
      // Same team-composition fields the main worldCtx carries, so
      // plan-layer consumers (ChargeReadiness via HammerAndAnvilPlan
      // .evaluate) see the same corridor-skip signals as reactive
      // decisions. Without these, plan EV estimates would default to
      // "no skip" while FlankerBehavior would actually skip, giving the
      // plan layer a pessimistic read of its own tactics.
      infantryLineUnits: infantryLineData.units,
      rangedUnits: infantryLineData.rangedUnits
    };
    this._currentPlan = this.planScheduler.update(this._currentPlan, planWorldCtx);
    if (this._currentPlan && this._currentPlan.objectiveUnitId) {
      const planObj = enemyUnits.find(u => u.id === this._currentPlan.objectiveUnitId);
      if (planObj && !planObj.isDefeated()) {
        this._currentObjectiveUnit = planObj;
      }
    }

    const weakPointTargets = this._assignWeakPointBias(contexts, enemyUnits, objectiveUnit);

    // Archer support pairing. Runs before the unit loop so every cav
    // and every archer reads this cycle's assignment when its own
    // behaviour runs below. Writes intent.hasEscort on each archer
    // (read by SkirmisherBehavior to gate advance-vs-hug) and
    // intent.escortArcherUnitIds / escortThreatUnitId on each
    // protecting cav (read by FlankerBehavior._decideSeeking).
    ArcherSupportCoordinator.resolve(
      this.teamUnits, enemyUnits, this.intents, this.assessment
    );

    // A3: build cavalry flank groups once per decision cycle. Each cavalry
    // unit gets its group (always includes at least itself) via a
    // Map<unitId, CavalryGroup>. We attach `.intent` onto each cavalry
    // unit's group-member entry so FlankerBehavior can read a group
    // leader's live intent without TeamAI reaching back into itself — see
    // _cavalryGroupsWithIntents.
    const axis = this.formation ? this.formation.getLineAxis(this.teamUnits, enemyUnits) : null;
    const cavalryGroupsByUnitId = this._cavalryGroupsWithIntents(axis);

    // A2: one coordinated reinforcement resolution per decision cycle.
    // Replaces the previous per-unit greedy _reinforcementOverride, which
    // could send three units to the same threatened ally in one cycle and
    // had no notion of winnability or type suitability. ReinforcementCoordinator
    // itself excludes fragile (A4) units from the helper pool.
    const reinforcementDispatches = ReinforcementCoordinator.resolve(
      this.teamUnits, allSoldiers, this.teamId, this.intents
    );

    for (const unit of this.teamUnits) {
      if (unit.isDefeated()) continue;

      const intent = this.intents.get(unit.id);
      this._syncMeleeTracking(unit, intent);

      // Routing units cannot execute orders — their soldiers are
      // fleeing under MoraleSystem and ignore formation slots and
      // unit commands. Continuing to evaluate charges/targets for
      // them produces meaningless assessment lines in the log and
      // can leave their intent stuck in a committed state whose
      // target is now physically unreachable (the unit's center
      // drifts away from the target every tick while the AI keeps
      // re-assessing a charge that will never happen). Skip until
      // they rally — the check runs every cycle, so they resume
      // normal behavior the moment morale recovers.
      if (this._isMostlyRouting(unit)) continue;

      // In-combat units normally skip AI decision-making — they're busy
      // fighting and any order the behavior layer issues would be ignored
      // by MovementSystem anyway (engaged soldiers don't move). Exception:
      // committed/regrouping cavalry still needs to reach its regroup
      // check, because that is the *only* mechanism for disengaging from
      // melee. Before this exception, regroup logic was unreachable in
      // practice — `_shouldStartRegroup` sits below this skip, so a unit
      // that was actually in melee never got to run it. Result: a cavalry
      // charge that made contact ground on to death instead of bouncing.
      if (this._unitIsInCombat(unit)) {
        const typeDef = unit.soldiers[0]?.unitTypeDef;
        const isCavalry = !!(typeDef && isCavalryClass(typeDef));
        // 'seeking' is included so a cavalry unit that entered melee while
        // in seeking phase — typically because the commit timeout released
        // it from a charge that had already closed to contact — can still
        // reach FlankerBehavior._decideSeeking, which detects the melee
        // state and routes to regroup instead of re-picking the attacker as
        // a fresh target and returning "hold position".
        const isRegroupEligible =
          isCavalry && (intent.phase === 'committed' || intent.phase === 'regrouping' || intent.phase === 'seeking');
        if (!isRegroupEligible) continue;
      }

      let context = contexts ? contexts.get(unit.id) : null;

      // A4 (revised): fragile units are ROLE-EXCLUDED, not behavior-
      // overridden. They keep fighting — they just aren't assigned to
      // critical roles while flagged. See _assignWeakPointBias and
      // ReinforcementCoordinator, both of which already exclude fragile
      // units from their candidate pools.
      //
      // This block previously also routed fragile units to a reserve
      // rally point via ReserveBehavior, removing them from the fight
      // entirely. Playtest analysis showed that fallback was actively
      // counterproductive:
      //
      //   - Flagged units did not survive any better. Every unit the
      //     flag sent to reserve died anyway — just slower, and further
      //     from the action, with no support nearby.
      //   - Pulling them off the line thinned the line, which increased
      //     casualties on the remaining units, which dropped THEIR
      //     morale, which triggered the flag on them next cycle. The
      //     fallback accelerated the collapse it was meant to prevent.
      //   - The flag's INPUT (a soft average-morale snapshot) was far
      //     weaker evidence than its OUTPUT (a hard stop in behavior).
      //     That mismatch is what produced the cascade.
      //
      // Keeping only the useful half: don't trust a fragile unit with a
      // critical role. Everything else continues normally.

      // Reserve units not yet deployed: hold position, skip normal
      // behavior entirely. computeContexts already places them at their
      // hold point via depthOffset/lateralOffset with role 'reserve';
      // treat that context exactly like a front-line unit's slot (reuse
      // LineBehavior's own slot-arrival logic by simply issuing a move
      // toward the same slot math a front unit would use — simplest: fall
      // straight through to normal per-type behavior IS correct for a
      // held reserve too, since 'reserve' context still carries a valid
      // lateral/depth offset. So no special case is needed here beyond
      // not deploying it into the weak-point/reinforcement logic below.)
      if (context && context.role === 'reserve' && !this._deployedReserveIds.has(unit.id)) {
        const behavior = UnitBehaviorRegistry.forUnit(unit);
        if (!behavior) continue;
        // A held reserve stays held under the line alarm; it is released
        // by _updateReserveDeployment (gap / needy ally), not by the alarm.
        const reserveCtx = (worldCtx.lineUnderAttack || worldCtx.rangedPressureTargets)
          ? { ...worldCtx, lineUnderAttack: false, rangedPressureTargets: null }
          : worldCtx;
        const order = behavior.decide(unit, enemyUnits, context, intent, this.assessment, reserveCtx, null);
        if (order) this._issueOrderIfChanged(unit, intent, order.x, order.z, order.facing);
        continue;
      }

      if (intent.phase === 'committed' && this._shouldStartRegroup(unit, intent, worldCtx)) {
        const failedTarget = intent.targetUnitId;
        AIDebugLog.regroupStart(this.tickCounter, unit.id, intent.ticksInMelee(this.tickCounter), this._countNearbyAllies(unit, worldCtx));
        intent.beginRegroup(this.tickCounter, failedTarget);
      }

      const behavior = UnitBehaviorRegistry.forUnit(unit);
      if (!behavior) continue;

      const typeDef = unit.soldiers[0]?.unitTypeDef;
      const isCavalry = !!(typeDef && isCavalryClass(typeDef));
      const isRanged = !!(typeDef && isRangedClass(typeDef));

      // Stage B plan-layer role handling. Units assigned a role in the
      // active plan are directed by the plan for this cycle — even a null
      // order (role 'hold') consumes the turn, since the plan exists to
      // OVERRIDE the default decision. Exception: a cavalry hammer that
      // has already entered its regroup phase is left to FlankerBehavior,
      // which owns disengagement from melee.
      if (this._currentPlan && this._currentPlan.roles.has(unit.id) &&
          !this._isHoldReleased(unit, worldCtx)) {
        const isRegroupingCav = isCavalry && intent.phase === 'regrouping';
        if (!isRegroupingCav) {
          const planOrder = this._planRoleOrder(unit, this._currentPlan, worldCtx, enemyUnits);
          if (planOrder && planOrder.blocked) {
            // Plan wants this unit somewhere, but the path is blocked
            // (corridor check refused — enemy spears in the way). Do NOT
            // consume the turn. Fall through to normal per-type behavior
            // so the unit asks for new orders — FlankerBehavior will
            // re-evaluate its target and either commit to a different
            // one or hold on its own. The plan scheduler will time out
            // the phase if this persists and re-plan from scratch.
            AIDebugLog.log('plan', this.tickCounter,
              `unit=${unit.id} plan role=${this._currentPlan.roles.get(unit.id)} blocked — falling through to normal behavior`);
          } else if (planOrder) {
            // Diagnostic: cav orders issued via the plan bypass
            // FlankerBehavior and the cavOrder log below. Without this
            // line, plan-driven cav movement is invisible in the log even
            // though it's driving the unit.
            const issued = this._issueOrderIfChanged(
              unit, intent, planOrder.x, planOrder.z, planOrder.facing
            );
            if (issued && isCavalry) {
              const role = this._currentPlan.roles.get(unit.id);
              AIDebugLog.cavOrder(
                this.tickCounter,
                unit.id,
                planOrder.x,
                planOrder.z,
                `plan:${role}/${this._currentPlan.phase}`,
                intent.targetUnitId
              );
            }
            continue;
          } else {
            continue;
          }
        }
      }

      let order = null;

      if (!isCavalry && !isRanged) {
        order = this._archerInterceptOverride(unit, worldCtx);
      }

      if (!order && reinforcementDispatches.has(unit.id)) {
        const targetAllyId = reinforcementDispatches.get(unit.id);
        const targetAlly = this.teamUnits.find(u => u.id === targetAllyId);
        if (targetAlly && !targetAlly.isDefeated()) {
          const c = targetAlly.getCenter();
          const my = unit.getCenter();
          const dx = c.x - my.x;
          const dz = c.z - my.z;
          if (Math.sqrt(dx * dx + dz * dz) >= AIConfig.slotArrivalRadius) {
            intent.targetUnitId = null;
            order = { x: c.x, z: c.z, facing: Math.atan2(dx, dz) };
          }
        }
      }

      if (!order) {
        if (isCavalry) {
          const group = cavalryGroupsByUnitId.get(unit.id) || null;
          order = behavior.decide(unit, enemyUnits, context, intent, this.assessment, worldCtx, group, this._currentObjectiveUnit);
        } else if (isRanged) {
          // Ranged units return typed decisions ({ focus | move | hold }),
          // dispatched through the ranged-specific path. Focus decisions
          // route through the player's attack-order entry point (no draw
          // cancellation). Move decisions go through the normal move path
          // but are queued when the archers are mid-volley — the order
          // then applies on the exact tick the current volley releases,
          // via TeamAI.onVolleyFired. Hold decisions do nothing. All of
          // that is handled inside _dispatchRangedDecision; the rest of
          // the loop is skipped for ranged units.
          const decision = behavior.decide(unit, enemyUnits, context, intent, this.assessment, worldCtx);
          this._dispatchRangedDecision(unit, intent, decision, enemyUnits);
          continue;
        } else {
          const wpTarget = weakPointTargets.get(unit.id) || null;
          order = behavior.decide(unit, enemyUnits, context, intent, this.assessment, worldCtx, wpTarget);
        }
      }

      if (!order && intent.phase === 'seeking' && intent.ticksSinceFormed(this.tickCounter) === 0) {
        order = behavior.decide(unit, enemyUnits, context, intent, this.assessment, worldCtx);
      }

      if (!order) continue;

      // Committed cavalry: use a REAL attack order, not a move order.
      //
      // A player's right-click produces Unit.issueAttackOrder(enemy),
      // which sets focusTargetUnitId and lets Unit.update() march the
      // anchor toward that unit's live center without touching the
      // formation anchor, combat state, or _marchReleased on every
      // re-issue. The AI's charge path was producing a plain move order
      // toward the target's center instead. Same destination, but the
      // move-order path calls _clearEngagedState(), resets
      // _marchReleased, and re-fits the anchor via _bestFitAnchor() on
      // every issuing cycle — and the re-fit shifts the formation slots
      // enough that Unit._followersFallingBehind reads the followers as
      // "behind" on the following tick and freezes the anchor, producing
      // the visible mid-charge stall the playtest log shows. Matching
      // the player's code path removes the whole failure mode: the same
      // destination, without the formation reset.
      //
      // issueAttackOrder has its own same-target short-circuit, so
      // calling it every decision cycle is free when the target hasn't
      // changed. When FlankerBehavior retargets (RETARGET after kill,
      // clean alternative), focusTargetUnitId flips and the new attack
      // order takes effect immediately.
      //
      // Non-committed cav (seeking, regrouping) still use move orders:
      // those orders move the unit to a *position* (flank slot, regroup
      // point), not toward an enemy unit, so an attack order would be
      // wrong for them.
      if (isCavalry && intent.phase === 'committed' && intent.targetUnitId) {
        const targetUnit = enemyUnits.find(u => u.id === intent.targetUnitId && !u.isDefeated());
        if (targetUnit) {
          const isNewFocus = unit.focusTargetUnitId !== targetUnit.id;
          unit.issueAttackOrder(targetUnit);
          intent.lastIssuedX = order.x;
          intent.lastIssuedZ = order.z;
          intent.lastIssuedFacing = order.facing;
          if (isNewFocus) {
            AIDebugLog.cavOrder(this.tickCounter, unit.id, order.x, order.z, intent.phase, intent.targetUnitId);
          }
          continue;
        }
      }

      // Diagnostic: log every issued order for cavalry units so we can
      // verify whether a "return to spears" window has fresh orders or is
      // running on a stale formationSlot from an earlier commit. The
      // phase/target fields disambiguate intent-owned orders
      // (committed/regrouping/seeking) from other sources (plan role,
      // reinforcement dispatch, archer intercept).
      const issued = this._issueOrderIfChanged(unit, intent, order.x, order.z, order.facing);
      if (issued && isCavalry) {
        AIDebugLog.cavOrder(this.tickCounter, unit.id, order.x, order.z, intent.phase, intent.targetUnitId);
      }
    }
  }

  // A3: builds this cycle's cavalry groups and, for each member, attaches a
  // lightweight `.intent` accessor onto the leader so FlankerBehavior can
  // read `group.leader.intent` without TeamAI exposing its whole intents
  // registry. Wrapping happens on a per-cycle plain object (never mutates
  // the actual Unit) so there's no risk of leaking state across cycles.
  //
  // Returns Map<unitId, { leader: {id, intent}, members, isLeader(), followers() }>
  // matching the shape FlankerBehavior expects (group.leader.id,
  // group.leader.intent, group.isLeader(unit)).
  _cavalryGroupsWithIntents(axis) {
    const cavalryUnits = CavalryGroup.cavalryUnitsOf(this.teamUnits);
    const rawGroupsByUnitId = CavalryGroup.build(cavalryUnits, axis);

    // Wrap each distinct group's leader once (groups share the same
    // CavalryGroup instance across all their members from CavalryGroup.build,
    // so dedupe by leader id to avoid rewrapping per member).
    const wrappedByLeaderId = new Map();
    const result = new Map();

    for (const [unitId, rawGroup] of rawGroupsByUnitId) {
      let wrapped = wrappedByLeaderId.get(rawGroup.leader.id);
      if (!wrapped) {
        const leaderIntent = this.intents.get(rawGroup.leader.id);
        wrapped = {
          leader: { id: rawGroup.leader.id, intent: leaderIntent },
          members: rawGroup.members,
          isLeader(unit) { return rawGroup.leader.id === unit.id; },
          followers() { return rawGroup.followers(); }
        };
        wrappedByLeaderId.set(rawGroup.leader.id, wrapped);
      }
      result.set(unitId, wrapped);
    }

    return result;
  }

  // Picks weakPointConcentrationFraction of eligible (non-cavalry,
  // non-ranged, non-reserve-undeployed, non-fragile) line units and assigns
  // them the single weakest enemy unit as their target, bounded by
  // weakPointMaxDetourRatio so a unit doesn't abandon a much closer fight
  // for a marginal concentration bonus far away.
  _assignWeakPointBias(contexts, enemyUnits, objectiveUnit) {
    const result = new Map();
    if (!this.formation) return result;

    // Prefer WinPlanner's shared objective over an independently-derived
    // weak slice — this is what stops line concentration from picking a
    // DIFFERENT target than what cavalry/focus-fire are converging on.
    let weakUnit = objectiveUnit;
    if (!weakUnit || weakUnit.isDefeated()) {
      const axis = this.formation.getLineAxis(this.teamUnits, enemyUnits);
      const analysis = new EnemyLineAnalysis(enemyUnits, axis, AIConfig.enemyLineSliceWidth);
      weakUnit = analysis.getWeakestUnit();
    }
    if (!weakUnit) return result;

    const eligible = this.teamUnits.filter(u => {
      if (u.isDefeated()) return false;
      const type = unitTypeOf(u);
      if (!type || isCavalryClass(type) || isRangedClass(type)) return false;
      if (isFragile(u, AIConfig.fragileMoraleThreshold)) return false;
      const ctx = contexts ? contexts.get(u.id) : null;
      if (ctx && ctx.role === 'reserve' && !this._deployedReserveIds.has(u.id)) return false;
      return true;
    });

    const concentrationFraction = objectiveUnit
      ? AIConfig.winPlannerConcentrationFraction
      : AIConfig.weakPointConcentrationFraction;
    const concentrationCount = Math.max(1, Math.round(eligible.length * concentrationFraction));

    // C3: press posture loosens how far a unit will detour to join the
    // concentration point; hold uses the unmodified (x1.0) base ratios.
    const detourMult = this._postureProfile().weakPointDetourMult;

    // Score by how little of a detour the weak point is relative to each
    // unit's own nearest-enemy distance; take the N smallest detours so
    // units already reasonably close to the weak point get assigned first.
    const scored = [];
    for (const u of eligible) {
      let nearestDist = Infinity;
      for (const e of enemyUnits) {
        const { dist } = centerTowardUnit(u, e);
        if (dist < nearestDist) nearestDist = dist;
      }
      if (nearestDist === Infinity || nearestDist === 0) continue;

      const { dist: weakDist } = centerTowardUnit(u, weakUnit);
      const detourRatio = weakDist / nearestDist;
      const baseMaxDetour = objectiveUnit ? AIConfig.winPlannerMaxDetourRatio : AIConfig.weakPointMaxDetourRatio;
      const maxDetour = baseMaxDetour * detourMult;
      if (detourRatio > maxDetour) continue;

      scored.push({ unit: u, detourRatio });
    }

    scored.sort((a, b) => a.detourRatio - b.detourRatio);
    for (let i = 0; i < Math.min(concentrationCount, scored.length); i++) {
      result.set(scored[i].unit.id, weakUnit);
    }

    return result;
  }

  // Reserve deployment: a reserve unit deploys (permanently, for the rest
  // of the battle) if a front-line gap opened near its hold position, or a
  // reinforcement need exists within reserveDeployRadius.
  _updateReserveDeployment(contexts, enemyUnits) {
    if (!contexts) return;

    for (const unit of this.teamUnits) {
      if (unit.isDefeated()) continue;
      const ctx = contexts.get(unit.id);
      if (!ctx || ctx.role !== 'reserve') continue;
      if (this._deployedReserveIds.has(unit.id)) continue;

      const center = unit.getCenter();

      const gapNearby = this.teamUnits.some(other => {
        if (other.id === unit.id) return false;
        const otherType = unitTypeOf(other);
        if (!otherType || isCavalryClass(otherType) || isRangedClass(otherType)) return false;
        if (!other.isDefeated()) return false; // looking for a DEFEATED front unit = a gap
        const origin = other.formationOrigin;
        const dx = origin.x - center.x;
        const dz = origin.z - center.z;
        return Math.sqrt(dx * dx + dz * dz) <= AIConfig.reserveDeployRadius;
      });

      const needyAllyNearby = this.teamUnits.some(ally => {
        if (ally.id === unit.id) return false;
        if (ally.isDefeated()) return false;
        const allyInMelee = ally.getAliveSoldiers().some(s => s.isInMelee());
        if (!allyInMelee) return false;
        const c = ally.getCenter();
        const dx = c.x - center.x;
        const dz = c.z - center.z;
        if (Math.sqrt(dx * dx + dz * dz) > AIConfig.reserveDeployRadius) return false;

        const { allyCount, enemyCount } = BattleAssessment.localCounts(
          c.x, c.z, this._allSoldiersOfBothSides(enemyUnits), this.teamId, AIConfig.localSuperiorityRadius
        );
        return allyCount > 0 && (enemyCount / allyCount) > AIConfig.reinforceLocalOutnumberRatio;
      });

      if (gapNearby || needyAllyNearby) {
        this._deployedReserveIds.add(unit.id);
      }
    }
  }

  // Assigns a small number of line units (preferring swordsmen, then
  // closest) to chase the active ranged-pressure shooters. Returns a
  // Map<unitId, enemyUnit> (empty when there is no pressure / no candidates).
  _assignRangedPressureChasers(lineUnits, shooters, contexts) {
    const result = new Map();
    if (!Array.isArray(shooters) || shooters.length === 0) return result;
    if (!lineUnits || lineUnits.length === 0) return result;

    const maxDist = AIConfig.rangedPressureMaxChaseDist;
    const maxSlots = Math.max(1, AIConfig.rangedPressureChaserCount | 0);

    const eligible = [];
    for (const u of lineUnits) {
      if (u.isDefeated()) continue;
      if (isFragile(u, AIConfig.fragileMoraleThreshold)) continue;
      const ctx = contexts ? contexts.get(u.id) : null;
      if (ctx && ctx.role === 'reserve' && !this._deployedReserveIds.has(u.id)) continue;
      eligible.push(u);
    }
    if (eligible.length === 0) return result;

    const scored = [];
    for (const u of eligible) {
      const type = unitTypeOf(u);
      const swordBias = (type && isSwordsmenClass(type)) ? 0 : 1;
      let bestDist = Infinity;
      let bestShooter = null;
      for (const s of shooters) {
        if (s.isDefeated()) continue;
        const { dist } = centerTowardUnit(u, s);
        if (dist > maxDist) continue;
        if (dist < bestDist) {
          bestDist = dist;
          bestShooter = s;
        }
      }
      if (!bestShooter) continue;
      scored.push({ unit: u, shooter: bestShooter, swordBias, dist: bestDist });
    }

    scored.sort((a, b) => {
      if (a.swordBias !== b.swordBias) return a.swordBias - b.swordBias;
      return a.dist - b.dist;
    });

    const usedShooters = new Set();
    for (let i = 0; i < scored.length && result.size < maxSlots; i++) {
      const entry = scored[i];
      if (usedShooters.has(entry.shooter.id) && usedShooters.size < shooters.length) {
        let alt = null;
        let altDist = Infinity;
        for (const s of shooters) {
          if (s.isDefeated() || usedShooters.has(s.id)) continue;
          const { dist } = centerTowardUnit(entry.unit, s);
          if (dist > maxDist) continue;
          if (dist < altDist) {
            altDist = dist;
            alt = s;
          }
        }
        if (!alt) continue;
        result.set(entry.unit.id, alt);
        usedShooters.add(alt.id);
        AIDebugLog.log('rangedpressure', this.tickCounter,
          `chaser unit=${entry.unit.id} -> shooter=${alt.id} dist=${altDist.toFixed(2)} (swords=${entry.swordBias === 0})`);
        continue;
      }
      result.set(entry.unit.id, entry.shooter);
      usedShooters.add(entry.shooter.id);
      AIDebugLog.log('rangedpressure', this.tickCounter,
        `chaser unit=${entry.unit.id} -> shooter=${entry.shooter.id} dist=${entry.dist.toFixed(2)} (swords=${entry.swordBias === 0})`);
    }

    return result;
  }

// When a friendly archer unit's SkirmisherBehavior has flagged
  // intent.threatUnitId (a charge bearing down on it), find the nearest
  // free (not in melee, not cavalry, not already intercepting something
  // else) line/reserve unit and send it to intercept the threat's path,
  // rather than leaving the archers to outrun it alone.
  _archerInterceptOverride(unit, worldCtx) {
    let closestThreatenedArcher = null;
    let closestDist = Infinity;
    let threatUnit = null;

    for (const other of this.teamUnits) {
      if (other.isDefeated()) continue;
      const type = unitTypeOf(other);
      if (!type || !isRangedClass(type)) continue;

      const otherIntent = this.intents.get(other.id);
      if (!otherIntent.threatUnitId) continue;

      const threat = this.allUnits.find(u => u.id === otherIntent.threatUnitId);
      if (!threat || threat.isDefeated()) continue;

      const myCenter = unit.getCenter();
      const archerCenter = other.getCenter();
      const dx = archerCenter.x - myCenter.x;
      const dz = archerCenter.z - myCenter.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AIConfig.archerInterceptMaxAllyDist) continue;

      if (dist < closestDist) {
        closestDist = dist;
        closestThreatenedArcher = other;
        threatUnit = threat;
      }
    }

    if (!closestThreatenedArcher || !threatUnit) return null;

    // Only intercept if we're not already closer to the threat than the
    // archers themselves would need us to be — i.e. don't bother if
    // someone else is clearly already positioned to block it.
    const threatCenter = threatUnit.getCenter();
    const myCenter = unit.getCenter();
    const dx = threatCenter.x - myCenter.x;
    const dz = threatCenter.z - myCenter.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < AIConfig.slotArrivalRadius) return null;

    return { x: threatCenter.x, z: threatCenter.z, facing: Math.atan2(dx, dz) };
  }

  // Plan role 'hold' (e.g. combined-arms infantry) returns no order and
  // consumes the unit's turn, so a held line unit does nothing even while
  // the line is being attacked. Under the line alarm the hold is released
  // and the unit falls through to normal behavior (direct assault). Other
  // roles (anvil, bombard, rally, screen, ...) are unaffected. Caller
  // guarantees _currentPlan is non-null.
  _isHoldReleased(unit, worldCtx) {
    if (!worldCtx.lineUnderAttack && !worldCtx.rangedPressureTargets) return false;
    return this._currentPlan.roles.get(unit.id) === 'hold';
  }

  _syncMeleeTracking(unit, intent) {
    const inMelee = unit.getAliveSoldiers().some(s => s.isInMelee());
    if (inMelee) {
      intent.noteEnteredMelee(this.tickCounter);
    } else {
      intent.noteExitedMelee();
    }
  }

  _countNearbyAllies(unit, worldCtx) {
    return this._countNearbyEngagedAllies(unit, worldCtx);
  }

  // Counts allies who are actually ENGAGED (fighting) nearby, not merely
  // present nearby. Evidence from playtest: a lone cavalry soldier being
  // ground down by an archer unit (repeated hits, HP 55->46->...->0 over
  // many ticks) never triggered regroup, because some unrelated, uninvolved
  // ally happened to be within regroupTriggerAllyRadius — "allies nearby"
  // was true even though nobody was actually helping. Regroup only makes
  // sense as "I have real melee support here"; a bystander doesn't count.
  _countNearbyEngagedAllies(unit, worldCtx) {
    const center = unit.getCenter();
    let allies = 0;
    for (const s of worldCtx.allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.teamId !== unit.teamId) continue;
      if (s.unitId === unit.id) continue;
      if (!s.isInMelee()) continue;
      const dx = s.pos.x - center.x;
      const dz = s.pos.z - center.z;
      if (dx * dx + dz * dz <= AIConfig.regroupTriggerAllyRadius * AIConfig.regroupTriggerAllyRadius) allies++;
    }
    return allies;
  }

  _shouldStartRegroup(unit, intent, worldCtx) {
    const typeDef = unit.soldiers[0]?.unitTypeDef;
    const isCavalry = !!(typeDef && isCavalryClass(typeDef));

    if (isCavalry) {
      // Cavalry melee disengage comes in two flavors, gated on the
      // tier flag cavalryThreatBasedDisengage.
      //
      // Weakened tier (flag false): the original fixed-timer behavior.
      // After cavalryMeleeCommitTicks in melee, disengage — unconditionally,
      // no target inspection, no threat check. Cav touches, fights, leaves.
      // Against archers this leaves them alive at half strength; that's the
      // exploitable weakness the tier exists to have.
      //
      // Best-possible tier (flag true): the threat-based logic. Non-archer
      // targets keep the fixed timer (bounce before spear/sword retaliation
      // matters). Pure archer targets are ground down until an actual threat
      // appears — the archers cannot brace, cannot block a swing, and take
      // full melee damage, so leaving early just lets them rally and resume
      // shooting.
      const inContact = unit.getAliveSoldiers().some(s => s.isInMelee());
      if (!inContact) return false;
      const ticksInMelee = intent.ticksInMelee(this.tickCounter);

      // Cav vs cav: never regroup, on any tier. A mounted melee is a
      // fight to the death, not a strike-and-bounce. Disengaging from
      // an enemy cav hands it the pursuit — and the cav's own regroup
      // is a straight-line walk to a flank slot, which a pursuer of
      // equal or greater speed catches every time. Better to stay in
      // the melee and let morale decide who breaks. This is a rule,
      // not a tunable: it holds regardless of the tier's
      // cavalryThreatBasedDisengage flag, because the rationale
      // (you cannot out-run a peer pursuer) is tier-independent.
      //
      // Gated on the ACTUAL melee opponents, not intent.targetUnitId:
      // a cav that charged archers and got counter-charged by enemy
      // cavalry still has targetUnitId pointing at the archers, and
      // the archer-target branch below would otherwise extend-grind
      // until a threat appeared, then disengage — abandoning the melee
      // it is already in. The soldiers know who they are fighting.
      if (this._cavalryFightingCavalry(unit, worldCtx)) return false;

      if (!this.tierCfg.cavalryThreatBasedDisengage) {
        return ticksInMelee >= AIConfig.cavalryMeleeCommitTicks;
      }

      const target = intent.targetUnitId
        ? this.allUnits.find(u => u.id === intent.targetUnitId && !u.isDefeated())
        : null;

      // Non-archer target (or target is gone/dead): unchanged behavior.
      // Fixed melee window, then bounce back to flank. This is the
      // strike-and-run cadence spears and swords are balanced against.
      if (!target || !this._isPureArcherTarget(target)) {
        return ticksInMelee >= AIConfig.cavalryMeleeCommitTicks;
      }

      // Archer target: stay and grind. No timer, no "it's been long
      // enough" fallback. The minimum melee window still applies so the
      // charge strike lands before the threat check can pull the unit
      // out — below the window, we always keep fighting.
      if (ticksInMelee < AIConfig.cavalryMeleeCommitTicks) return false;
      return this._cavalryThreatRequiresDisengage(unit);
    }

    const ticksInMelee = intent.ticksInMelee(this.tickCounter);
    if (ticksInMelee < AIConfig.regroupTriggerTicksInMelee) return false;
    return this._countNearbyEngagedAllies(unit, worldCtx) < AIConfig.regroupMinAllies;
  }

// True when every living soldier of the given unit is ranged-class.
  // Used by _shouldStartRegroup to decide whether cav gets the extended
  // stay-and-grind behavior (pure archers) or the base bounce timer.
  //
  // Deliberately conservative: ANY melee soldier in the target unit
  // disqualifies it. A "mostly archers with one spear straggler mixed
  // in" reads as dangerous, which matches how the combat maths treats
  // it — the straggler can brace a fresh charge or catch a lingering
  // cav in the side.
  _isPureArcherTarget(unit) {
    const alive = unit.getAliveSoldiers();
    if (alive.length === 0) return false;
    for (const s of alive) {
      const type = s.unitTypeDef;
      if (!type) return false;
      if (!isRangedClass(type)) return false;
    }
    return true;
  }

  // True when any living soldier of this unit is currently in melee
  // with an enemy soldier whose unit type is cavalry-classed.
  //
  // Uses isCavalryForAI (extended predicate), so the mounted Goblin
  // Warlord's retinue counts as cavalry for this rule even though it
  // is deliberately not classed CAVALRY in the sim — a beast-mounted
  // champion chasing a disengaging cav unit is exactly the scenario
  // the rule exists to prevent.
  //
  // Reads the ACTUAL melee opponents rather than intent.targetUnitId.
  // TargetingSystem freezes each engaged soldier's targetId while it
  // is in melee (see the engaged/staggered/knockedDown skip in
  // TargetingSystem.update), so the field points at whoever the
  // soldier is physically fighting right now. The intent target is
  // the unit-level commitment, which can still point at archers after
  // an enemy cav unit counter-charged — the intent alone would miss
  // that case, and the cav would keep grinding archers while enemy
  // cav carved it up.
  //
  // worldCtx.allSoldiers carries both teams' living soldiers; the
  // cav's own soldiers are in it too, but the targetId lookup is by
  // id, and a soldier never targets itself or a same-team unit, so
  // this reads only enemy targets in practice. Defensive on a missing
  // allSoldiers array — returns false so the caller falls through to
  // its normal logic rather than crashing on a stripped worldCtx.
  _cavalryFightingCavalry(unit, worldCtx) {
    const soldiers = worldCtx && worldCtx.allSoldiers;
    if (!Array.isArray(soldiers) || soldiers.length === 0) return false;
    for (const s of unit.getAliveSoldiers()) {
      if (!s.isInMelee()) continue;
      if (!s.targetId) continue;
      for (const other of soldiers) {
        if (other.id !== s.targetId) continue;
        const t = other.unitTypeDef;
        if (t && isCavalryForAIClass(t)) return true;
        break;
      }
    }
    return false;
  }

  // Does a threat exist that should pull this cavalry unit out of melee?
  // Called only when the current target is a pure archer unit and the
  // minimum melee window has elapsed. Returns true on the FIRST
  // qualifying threat (priority order: enemy cav > spears > swords).
  //
  // All checks read current world state, so a threat that fires this
  // cycle will also fire next cycle if nothing changed — the disengage
  // decision is stable. Regroup transitions are one-way per intent (see
  // beginRegroup), so the unit won't flip back and forth.
  //
  // "Alive and not routing" for the enemy counts: a routing spear unit
  // is not about to engage anything, and treating it as a threat would
  // make cav flee from a unit that's already fleeing.
  _cavalryThreatRequiresDisengage(unit) {
    const myAlive = unit.getAliveSoldiers().filter(s => !s.isRouting);
    const cavAlive = myAlive.length;
    if (cavAlive === 0) return false;

    const myCenter = unit.getCenter();
    const enemyUnits = this.allUnits.filter(
      u => u.teamId !== this.teamId && !u.isDefeated()
    );
    if (enemyUnits.length === 0) return false;

    const chargeSpeed = toSimSpeed(CombatConfig.charge.speedThreshold);

    // 1) Enemy cavalry closing fast on us. Highest priority: we need to
    //    be clear of this position before they arrive, which means
    //    leaving earlier than the melee-threat checks would.
    //
    //    The threat radius is DYNAMIC — see the config doc for the
    //    reasoning. Formula:
    //
    //      time_to_arrive = distance / enemy_cav_max_speed
    //      trigger when   = time_to_arrive <= (base + safety)
    //      equivalent to  = distance <= (base + safety) * enemy_cav_max_speed
    //
    //    enemy_cav_max_speed is the max effectiveMoveSpeed (sim space)
    //    across all living enemy cav soldiers. effectiveMoveSpeed
    //    already folds in equipment and race multipliers, so a skeleton
    //    or goblin cav variant (if either ever exists) sets its own
    //    radius rather than inheriting a human horseman's.
    //
    //    A fixed-radius check (the previous version, 12 units) under-
    //    served the scenario in the log: cav engaged with archers, the
    //    check fired at 12 units, but by the time the retreat order
    //    actually broke the unit free, enemy cav was already inside
    //    melee. The dynamic radius gives the cav enough lead time to
    //    complete its disengage before the enemy cav arrives.
    let enemyCavMaxSpeed = 0;
    for (const eu of enemyUnits) {
      const type = unitTypeOf(eu);
      if (!type || !isCavalryClass(type)) continue;
      const alive = eu.getAliveSoldiers();
      if (alive.length === 0) continue;
      // Any living soldier of the unit is representative — move speed
      // is a per-type × per-race property, not per-soldier state.
      const sample = alive[0];
      const simSpeed = sample.effectiveMoveSpeed *
        CombatConfig.movement.globalSpeedScale;
      if (simSpeed > enemyCavMaxSpeed) enemyCavMaxSpeed = simSpeed;
    }

    if (enemyCavMaxSpeed > 0) {
      const leadSeconds =
        AIConfig.cavalryDisengageBaseSeconds +
        AIConfig.cavalryDisengageSafetySeconds;
      const threatRadius = leadSeconds * enemyCavMaxSpeed;
      const threatRadiusSq = threatRadius * threatRadius;

      for (const eu of enemyUnits) {
        const type = unitTypeOf(eu);
        if (!type || !isCavalryClass(type)) continue;
        const alive = eu.getAliveSoldiers().filter(s => !s.isRouting);
        if (alive.length === 0) continue;
        if (alive.length < cavAlive * AIConfig.cavalryDisengageEnemyCavRatio) continue;

        // Only enemy cav that is actually moving at charge speed counts.
        // Enemy cav that's repositioning at walking pace is not about
        // to charge us and does not warrant abandoning a good target.
        let speedSum = 0;
        for (const s of alive) speedSum += s.currentSpeed;
        const avgSpeed = speedSum / alive.length;
        if (avgSpeed < chargeSpeed) continue;

        const c = eu.getCenter();
        const dx = c.x - myCenter.x;
        const dz = c.z - myCenter.z;
        if (dx * dx + dz * dz > threatRadiusSq) continue;

        return true;
      }
    }

    // 2) & 3) Enemy spearmen / swordsmen about to engage us. Same
    //    threshold shape, different ratio (spears trigger at a lower
    //    count because the anti-cavalry bonus makes a small spear pack
    //    dangerous). Short distance gate — this is "about to engage",
    //    not "somewhere on the field". A unit already in melee with us
    //    is trivially inside the radius.
    const meleeRadiusSq =
      AIConfig.cavalryDisengageMeleeThreatRadius *
      AIConfig.cavalryDisengageMeleeThreatRadius;
    for (const eu of enemyUnits) {
      const type = unitTypeOf(eu);
      if (!type) continue;
      const weapon = type.weaponType;
      if (weapon !== 'spear' && weapon !== 'sword') continue;

      const alive = eu.getAliveSoldiers().filter(s => !s.isRouting);
      if (alive.length === 0) continue;

      const ratio = weapon === 'spear'
        ? AIConfig.cavalryDisengageSpearmanRatio
        : AIConfig.cavalryDisengageSwordsmanRatio;
      if (alive.length <= cavAlive * ratio) continue;

      const c = eu.getCenter();
      const dx = c.x - myCenter.x;
      const dz = c.z - myCenter.z;
      if (dx * dx + dz * dz > meleeRadiusSq) continue;

      return true;
    }

    return false;
  }

_unitIsInCombat(unit) {
    // Soldier.isInMelee() distinguishes "staggered in melee" from
    // "staggered by an arrow across the field" via stateBeforeStagger.
    // The old disjunction (engaged || staggered) treated any arrow
    // stagger as combat, which routed cavalry that got plinked during
    // a charge into the combat-skip branch of _decide.
    const alive = unit.getAliveSoldiers();
    for (const s of alive) {
      if (s.isInMelee()) return true;
    }
    return false;
  }

// A unit is "mostly routing" when at least half of its living
  // soldiers carry the routing flag. Matches the same >=0.5 threshold
  // used by FlankerBehavior._isRoutingUnit and the various
  // isMostlyRouting helpers scattered through the codebase, so
  // "routing" means the same thing here as everywhere else.
  //
  // Returns false for a unit with no living soldiers — a defeated or
  // empty unit should not be labelled routing. It has already been
  // filtered out by the isDefeated() check above; this is just the
  // defensive guard.
  _isMostlyRouting(unit) {
    const alive = unit.getAliveSoldiers();
    if (alive.length === 0) return false;
    let routing = 0;
    for (const s of alive) {
      if (s.isRouting) routing++;
    }
    return routing / alive.length >= 0.5;
  }

// Single choke point for every AI-issued move order. Routes through
  // the unit's intent so a redundant order — same destination, same
  // facing, within small epsilon — is dropped before it reaches
  // Unit.issueMoveOrder.
  //
  // Why this exists on top of the same-order absorption inside
  // Unit.issueMoveOrder itself:
  //
  //   - Debug log hygiene. Every issued order logs a line; the AI
  //     re-derives each unit's destination every decision cycle, so
  //     without this filter the log fills with identical ORDER lines
  //     and stops being a signal that anything actually changed.
  //
  //   - Intent state honesty. intent.setGoal(...) inside FlankerBehavior
  //     marks the tactical goal the AI committed to. When the AI
  //     re-derives the same physical order from scratch every cycle,
  //     that field describes a decision that was made long ago and has
  //     not been reconsidered — which is invisible in the log. The
  //     filter makes "issued" mean "the AI chose to re-affirm this."
  //
  //   - Defence in depth. Unit.issueMoveOrder's guard is a wider net
  //     tuned for the player path (a click on almost-the-same-spot
  //     shouldn't thrash the formation either). The AI can afford a
  //     tighter epsilon because it knows exactly what it wanted. If the
  //     Unit-level guard is ever narrowed for player-feel reasons, the
  //     AI is unaffected.
  //
  // Epsilon choice: SAME_ORDER_DIST is 0.5 world units — below the
  // typical distance a chasing unit's target drifts in one decision
  // cycle (15 ticks), so a genuinely moving target still re-issues when
  // it has moved a meaningful amount, but a stationary target's stable
  // coordinates (the observed case: identical (-9.7, 19.3) every
  // cycle for 25+ cycles) are absorbed. SAME_ORDER_FACING_RAD is 0.1
  // rad (~5.7°) — below the visible threshold of a facing tweak for a
  // unit already pointed the right way, above the float-level jitter a
  // rotating formation axis produces.
  //
  // Returns true when the order was actually issued (and stored as the
  // new last-issued state), false when it was skipped. Callers that log
  // issued orders should gate the log on the return value so a skipped
  // cycle is silent.
  _issueOrderIfChanged(unit, intent, x, z, facing) {
    const SAME_ORDER_DIST = 0.5;
    const SAME_ORDER_FACING_RAD = 0.1;

    if (intent.lastIssuedX !== null && intent.lastIssuedX !== undefined) {
      const dx = x - intent.lastIssuedX;
      const dz = z - intent.lastIssuedZ;
      if (dx * dx + dz * dz < SAME_ORDER_DIST * SAME_ORDER_DIST) {
        let fd = facing - intent.lastIssuedFacing;
        fd = ((fd + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        if (Math.abs(fd) < SAME_ORDER_FACING_RAD) {
          return false;
        }
      }
    }

    unit.issueMoveOrder(x, z, facing);
    intent.lastIssuedX = x;
    intent.lastIssuedZ = z;
    intent.lastIssuedFacing = facing;
    return true;
  }

  // Dispatch a ranged unit's typed decision. Three shapes:
  //
  //   focus  — route through Unit.issueAttackOrder, the same entry point
  //            the player's right-click uses. This sets focusTargetUnitId,
  //            which makes Unit.update march the formation anchor to the
  //            unit's own depth-aware standoff of the focus target and
  //            makes every soldier prefer the nearest soldier of that
  //            unit. issueAttackOrder does NOT clear soldier combat
  //            state, so archers keep drawing and firing through a focus
  //            order — that is what lets the standoff path route through
  //            it without disturbing the volley. Re-issuing the SAME
  //            focus is free (issueAttackOrder short-circuits on same
  //            target), so the AI can return it every cycle without
  //            thrashing.
  //
  //   move   — position order. Issued via _issueOrderIfChanged, but with
  //            two guards:
  //              1. If the intent key is unchanged from last cycle AND
  //                 the destination has not drifted meaningfully, skip.
  //                 Anchor drift of a fraction of a unit is not an intent
  //                 change; re-issuing a full move order for it resets
  //                 the unit's combat state each time.
  //              2. If the unit's archers are mid-draw, queue the order
  //                 on the intent rather than issuing it. It applies the
  //                 instant the volley releases, via onVolleyFired.
  //            A queued order is single-slot: a fresh decision replaces
  //            whatever was pending.
  //
  //   hold   — no order this cycle. A hold does not cancel a pending
  //            move: the pending order is still what the AI most
  //            recently wanted, and a hold just means "nothing new this
  //            cycle".
  //
  // Null falls through as a no-op.
  _dispatchRangedDecision(unit, intent, decision, enemyUnits) {
    if (!decision) return;

    if (decision.type === 'focus') {
      const target = enemyUnits.find(
        u => u.id === decision.targetUnitId && !u.isDefeated()
      );
      if (!target) return;
      // A fresh focus supersedes any queued move — the AI changed its
      // mind, and letting a stale hug or kite fire later would fight
      // the new intent.
      intent.pendingMove = null;
      unit.issueAttackOrder(target);
      intent.lastIntentKey = `focus:${target.id}`;
      return;
    }

    if (decision.type === 'move') {
      const key = `move:${decision.subKind || ''}`;

      // Same-intent skip. Position-only comparison would miss this
      // because the AI recomputes the destination from a live anchor
      // every cycle, and the recomputed destination drifts by a
      // fraction of a unit even when the intent is unchanged. The
      // tolerance is wider than the unit's own same-order filter
      // (0.5 world units) because at the intent level "same place,
      // different cycle" is still the same order and should be
      // absorbed, not re-issued.
      const SAME_INTENT_TOLERANCE = 2.0;
      if (key === intent.lastIntentKey && intent.lastIssuedX !== null) {
        const dx = decision.x - intent.lastIssuedX;
        const dz = decision.z - intent.lastIssuedZ;
        if (dx * dx + dz * dz < SAME_INTENT_TOLERANCE * SAME_INTENT_TOLERANCE) {
          return;
        }
      }

      // Mid-draw queue. Issuing a move order while the archers are
      // drawing cancels the draw (see Unit._clearEngagedState) and
      // wastes the entire cooldown cycle. Store the decision on the
      // intent and let onVolleyFired apply it the instant the arrows
      // leave the bows.
      if (this._unitHasArchersDrawing(unit)) {
        intent.pendingMove = {
          subKind: decision.subKind,
          x: decision.x,
          z: decision.z,
          facing: decision.facing
        };
        return;
      }

      const issued = this._issueOrderIfChanged(
        unit, intent, decision.x, decision.z, decision.facing
      );
      if (issued) intent.lastIntentKey = key;
      return;
    }

    // 'hold' or unrecognised: no order this cycle. A pending move (from
    // a previous cycle's queued decision) is left in place — the pending
    // move is still what the AI most recently wanted, and a hold just
    // means nothing new this cycle.
  }

  // True when any living soldier of this unit is currently drawing — in
  // 'ranged' state with bow-draw cooldown still to run. Used by the
  // ranged decision dispatcher to decide between issuing a move order
  // now and queueing it for the moment the current volley releases.
  //
  // Requires cooldown > 0, not just state === 'ranged': an archer whose
  // cooldown has reached 0 but has no target in range (target died, or
  // moved out of range between ticks) is nominally in 'ranged' state but
  // is not drawing and will not fire. Queueing on it would wait forever.
  // The cooldown check catches that case.
  _unitHasArchersDrawing(unit) {
    for (const s of unit.soldiers) {
      if (!s.isAlive()) continue;
      if (s.state !== 'ranged') continue;
      if (s.attackCooldownTicks > 0) return true;
    }
    return false;
  }

  // Called by BattleSimulation the instant a volley releases for a unit
  // this team owns. If a repositioning order was queued while the archers
  // were drawing, apply it now — at the exact tick the arrows leave the
  // bows, when the archers are between draws and issuing a move order
  // costs them no shot.
  //
  // Single-shot: the pending entry is cleared before the order is issued,
  // so a second volley-fired callback on the same tick (impossible in
  // practice, but defensive) cannot double-fire the same pending order.
  onVolleyFired(unitId) {
    const intent = this.intents.get(unitId);
    if (!intent || !intent.pendingMove) return;

    const unit = this._unitById.get(unitId);
    if (!unit || unit.isDefeated()) {
      intent.pendingMove = null;
      return;
    }

    const pending = intent.pendingMove;
    intent.pendingMove = null;
    const issued = this._issueOrderIfChanged(
      unit, intent, pending.x, pending.z, pending.facing
    );
    if (issued) {
      intent.lastIntentKey = `move:${pending.subKind || ''}`;
    }
  }

  _allSoldiersOfBothSides(enemyUnits) {
    const all = [];
    for (const u of this.teamUnits) all.push(...u.soldiers);
    for (const u of enemyUnits) all.push(...u.soldiers);
    return all;
  }

  // A4: mean center of this team's own currently-alive LINE units. Used as
  // the anchor a fragile unit falls back behind (via ReserveBehavior), and
  // by FlankerBehavior's regroup / flank-slot logic.
  //
  // Cavalry is EXCLUDED from this mean. A cavalry unit deep in enemy
  // territory (mid-charge or mid-melee) would otherwise drag the anchor
  // forward, and since cavalry regroup destinations are computed RELATIVE
  // to this anchor, the regroup position would follow the cavalry forward
  // instead of returning to the actual line. Excluding cavalry makes this
  // a LINE anchor: the position of the team's actual battle line, which is
  // what every consumer of this value actually wants.
  //
  // Fallback: if there are no non-cavalry units alive (all-cavalry team,
  // or the line has been wiped), fall back to including everyone so the
  // anchor is never null while any friendly unit lives.
  _computeTeamAnchor() {
    let sx = 0, sz = 0, count = 0;
    for (const u of this.teamUnits) {
      if (u.isDefeated()) continue;
      const type = unitTypeOf(u);
      if (type && isCavalryClass(type)) continue;
      const c = u.getCenter();
      sx += c.x;
      sz += c.z;
      count++;
    }
    if (count === 0) {
      for (const u of this.teamUnits) {
        if (u.isDefeated()) continue;
        const c = u.getCenter();
        sx += c.x;
        sz += c.z;
        count++;
      }
    }
    if (count === 0) return null;
    return { x: sx / count, z: sz / count };
  }

  // Mean center of this team's alive MELEE line — excludes cavalry AND
  // ranged — plus the list of those line units themselves.
  //
  // The anchor is used by SkirmisherBehavior's cavalry-cover fallback as
  // the reference point for "just in front of the line". Distinct from
  // _computeTeamAnchor (which includes ranged units): archers positioning
  // relative to a mean that includes themselves creates a feedback loop
  // where every archer move shifts the anchor and re-triggers movement.
  //
  // The units list is read by SkirmisherBehavior's unleash rule, which
  // tests whether any enemy sits within a bubble around a line unit.
  // Returned as a single object so both are computed in one pass — call
  // sites read `data.anchor` for the mean, `data.units` for the list.
  //
  // Returns `{ units: [], anchor: null }` if no line units survive — the
  // fallback then falls through to normal standoff behavior rather than
  // freezing archers in place while the melee line has been wiped out.
  _computeInfantryLineData() {
    const units = [];
    const rangedUnits = [];
    let sx = 0, sz = 0;
    for (const u of this.teamUnits) {
      if (u.isDefeated()) continue;
      const type = unitTypeOf(u);
      if (!type) continue;
      if (isCavalryClass(type)) continue;
      if (isRangedClass(type)) {
        rangedUnits.push(u);
        continue;
      }
      units.push(u);
      const c = u.getCenter();
      sx += c.x;
      sz += c.z;
    }
    if (units.length === 0) return { units: [], anchor: null, rangedUnits };

    // Forward axis: line mean → enemy mean. Same convention used
    // everywhere else in the AI (BattleLineFormation, EnemyLineAnalysis).
    // Stored on the returned object so _computeRangedOverextended can
    // score archers as "in front of" vs "behind" the line rather than
    // tripping on raw distance in both directions.
    const anchor = { x: sx / units.length, z: sz / units.length };
    const enemyUnits = this.allUnits.filter(
      u => u.teamId !== this.teamId && !u.isDefeated()
    );
    let forward = null;
    if (enemyUnits.length > 0) {
      let ex = 0, ez = 0, ecount = 0;
      for (const eu of enemyUnits) {
        const c = eu.getCenter();
        ex += c.x;
        ez += c.z;
        ecount++;
      }
      ex /= ecount;
      ez /= ecount;
      const fdx = ex - anchor.x;
      const fdz = ez - anchor.z;
      const fdist = Math.sqrt(fdx * fdx + fdz * fdz);
      if (fdist > 0.001) {
        forward = { x: fdx / fdist, z: fdz / fdist };
      }
    }

    return { units, anchor, forward, rangedUnits };
  }

// Team-wide ranged-under-fire flag. Returns true when ANY friendly
  // ranged unit is being shot at from beyond its own reach by an enemy
  // ranged unit. This is the trigger the archer behaviour reads to
  // release the whole formation from hug, not just the individual
  // archer taking fire — the enemy's reach advantage applies to every
  // archer on the field equally, so unleashing one at a time just gets
  // them shot one at a time.
  //
  // Same distance measurement SkirmisherBehavior._isBeingOutranged
  // uses per-archer: nearest soldier of the enemy unit to our unit's
  // centre, compared against both sides' own ranges. The difference is
  // scope — this method answers "is the TEAM outranged", the
  // behaviour's per-archer version answers "is THIS archer outranged".
  // Both are needed; the team flag drives the unleash, the per-archer
  // check drives the local hug-clamp suppression.
  _rangedUnderFire(rangedUnits, enemyUnits) {
    if (!Array.isArray(rangedUnits) || rangedUnits.length === 0) return false;
    if (!Array.isArray(enemyUnits) || enemyUnits.length === 0) return false;

    for (const unit of rangedUnits) {
      if (unit.isDefeated()) continue;
      const type = unitTypeOf(unit);
      if (!type || !isRangedClass(type)) continue;
      const myRange = getRangedRange(type);
      if (myRange <= 0) continue;
      const myCenter = unit.getCenter();

      for (const enemy of enemyUnits) {
        if (enemy.isDefeated()) continue;
        const et = unitTypeOf(enemy);
        if (!et || !isRangedClass(et)) continue;
        const enemyRange = getRangedRange(et);

        // Nearest living soldier of this enemy to our archer's centre.
        let nearestSq = Infinity;
        for (const s of enemy.getAliveSoldiers()) {
          const dx = s.pos.x - myCenter.x;
          const dz = s.pos.z - myCenter.z;
          const d = dx * dx + dz * dz;
          if (d < nearestSq) nearestSq = d;
        }
        if (!isFinite(nearestSq)) continue;
        const dist = Math.sqrt(nearestSq);

        // Enemy can hit us; we cannot hit back.
        if (dist > myRange && dist <= enemyRange) return true;
      }
    }
    return false;
  }

// Ranged tether predicate. Returns true when any living friendly
  // ranged unit's centre is farther than AIConfig.archerLineTetherDist
  // from the melee line anchor. The tether is the mechanism that lets
  // archers sally to return fire without losing cover: the line itself
  // advances, so the cover moves with them.
  //
  // Distance-based, not forward-projected: a lateral drift far enough
  // from the line also trips the flag. Acceptable — lateral drift of
  // that magnitude is a repositioning signal in its own right, and the
  // response (line advances) is benign in that case.
  //
  // Reads infantryLineData.rangedUnits, which _computeInfantryLineData
  // populates on the same pass that computes the anchor. Returns false
  // when no line anchor exists (line wiped, or no line units alive) —
  // there is nothing to tether to, so no line advance is warranted.
  _computeRangedOverextended(infantryLineData) {
    if (!infantryLineData || !infantryLineData.anchor) return false;
    const rangedUnits = infantryLineData.rangedUnits;
    if (!Array.isArray(rangedUnits) || rangedUnits.length === 0) return false;

    // Forward axis to distinguish "archer is in front of the line"
    // from "archer is behind the line". See the previous version's
    // note for why a raw distance check is directionally wrong.
    const axis = infantryLineData.forward;
    if (!axis || typeof axis.x !== 'number' || typeof axis.z !== 'number') return false;

    const anchor = infantryLineData.anchor;
    const tether = AIConfig.archerLineTetherDist ?? 8.0;

    for (const u of rangedUnits) {
      if (u.isDefeated()) continue;

      // ONLY hug archers count. Escort archers are intentionally far
      // forward — that is the whole point of the escort path: advance
      // to standoff, get in range, shoot, and let the assigned cav
      // provide cover. Counting them here trips the tether on an
      // archer doing exactly what it was told, the defence hold gets
      // skipped, the line walks forward to "catch up", and the whole
      // formation shuffles south chasing an archer that never wanted
      // the line to follow it in the first place.
      //
      // The intent's hasEscort flag is the authoritative source — set
      // by ArcherSupportCoordinator each cycle, read here directly.
      // Absent an intent (shouldn't happen for a living ranged unit,
      // but defensive), fall through and treat as a hug archer.
      const intent = this.intents.get(u.id);
      if (intent && intent.hasEscort === true) continue;

      const c = u.getCenter();
      const dx = c.x - anchor.x;
      const dz = c.z - anchor.z;
      const forward = dx * axis.x + dz * axis.z;
      if (forward > tether) return true;
    }
    return false;
  }

// Deep fallback point used by FlankerBehavior._decideRegrouping when no
  // formation context exists. Cavalry is excluded from the mean for the
  // same reason as _computeTeamAnchor: a cavalry unit deep in enemy
  // territory would drag the mean forward, and this point (mean + away-
  // from-enemy * regroupFallbackDist) would follow it forward, defeating
  // the purpose of a fallback. With cavalry excluded, this is the line's
  // mean offset away from the enemy mean.
  _computeOwnFallbackPoint() {
    let sx = 0, sz = 0, count = 0;
    for (const u of this.teamUnits) {
      if (u.isDefeated()) continue;
      const type = unitTypeOf(u);
      if (type && isCavalryClass(type)) continue;
      const c = u.getCenter();
      sx += c.x;
      sz += c.z;
      count++;
    }
    if (count === 0) {
      for (const u of this.teamUnits) {
        if (u.isDefeated()) continue;
        const c = u.getCenter();
        sx += c.x;
        sz += c.z;
        count++;
      }
    }
    if (count === 0) return null;
    const meanX = sx / count;
    const meanZ = sz / count;

    const enemyUnits = this.allUnits.filter(u => u.teamId !== this.teamId && !u.isDefeated());
    if (enemyUnits.length === 0) return { x: meanX, z: meanZ };

    let ex = 0, ez = 0, ecount = 0;
    for (const u of enemyUnits) {
      const c = u.getCenter();
      ex += c.x;
      ez += c.z;
      ecount++;
    }
    ex /= ecount;
    ez /= ecount;

    const dx = meanX - ex;
    const dz = meanZ - ez;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.001) return { x: meanX, z: meanZ };

    return {
      x: meanX + (dx / dist) * AIConfig.regroupFallbackDist,
      z: meanZ + (dz / dist) * AIConfig.regroupFallbackDist
    };
  }
}
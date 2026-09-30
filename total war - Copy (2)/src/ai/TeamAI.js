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
import { getTierConfig, DEFAULT_AI_TIER } from '../config/AITierConfig.js';
import { isCavalry as isCavalryClass, isRanged as isRangedClass } from '../config/UnitClasses.js';
import { PlanScheduler } from './PlanScheduler.js';
import { UnitBehaviorRegistry } from './UnitBehaviorRegistry.js';
import { UnitIntentRegistry } from './UnitIntent.js';
import { BattleAssessment } from './BattleAssessment.js';
import { EnemyLineAnalysis } from './EnemyLineAnalysis.js';
import { FocusFireCoordinator } from './FocusFireCoordinator.js';
import { ReinforcementCoordinator } from './ReinforcementCoordinator.js';
import { WinPlanner } from './WinPlanner.js';
import { CavalryGroup } from './CavalryGroup.js';
import { ReserveBehavior } from './ReserveBehavior.js';
import { ChargeReadiness } from './ChargeReadiness.js';
import { AIDebugLog } from './AIDebugLog.js';
import { unitTypeOf, centerTowardUnit, isFragile } from './behaviorUtils.js';

const reserveBehavior = new ReserveBehavior();

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
    const halfWidth = CombatConfig.charge.corridorHalfWidth;
    const halfWidthSq = halfWidth * halfWidth;

    let spearCount = 0;
    for (const eu of enemyUnits) {
      if (eu.isDefeated()) continue;
      for (const s of eu.getAliveSoldiers()) {
        if (s.unitTypeDef.weaponType !== 'spear') continue;
        if (s.isRouting) continue;
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
    if (this.tickCounter % AIConfig.assessmentIntervalTicks === 0) {
      this._updateAssessment();
    }
    if (this.tickCounter % AIConfig.decisionIntervalTicks === 0) {
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
    FocusFireCoordinator.assign(archerUnits, enemyUnits, this._currentObjectiveUnit || null, this._postureProfile());
  }

  // C3: resolves this cycle's posture-conditional parameter set from
  // AIConfig.posture, keyed off the last computed assessment. Falls back
  // to 'hold' (today's defaults) when no assessment exists yet or posture
  // is 'retreat' — a retreating team has no business pressing harder, it
  // just uses the neutral profile while RetreatPlan / _holdOrRetreatLine
  // handle withdrawal.
  _postureProfile() {
    const posture = this.assessment ? this.assessment.posture : 'hold';
    return AIConfig.posture[posture] || AIConfig.posture.hold;
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

    const worldCtx = {
      currentTick: this.tickCounter,
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
      // Ranged units on this team. Read by ChargeReadiness's corridor-skip
      // policy: a team with neither a melee line NOR ranged units has no
      // way to ever soften or pin a spear formation, so the corridor check
      // must not block the cavalry's only offensive option. See
      // ChargeReadiness.shouldSkipCorridor.
      rangedUnits: infantryLineData.rangedUnits,
      // C3: posture-conditional ChargeReadiness leniency, read by
      // FlankerBehavior.decide(). Resolved once per cycle here so every
      // cavalry unit's decision this cycle uses the same value.
      postureChargeLeniency: this._postureProfile().chargeReadinessLeniency || 0
    };

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

      // A4: fragile units (average morale below threshold) are pulled out
      // of normal behavior entirely and routed to a reserve/rally fallback,
      // UNLESS they are currently in melee (handled by the in-combat skip
      // above) — a fragile unit already fighting isn't yanked mid-fight,
      // it simply isn't ASSIGNED any new concentration/reinforcement role
      // this cycle (enforced by _assignWeakPointBias / ReinforcementCoordinator
      // excluding it), and falls back to reserve once it disengages.
      if (isFragile(unit, AIConfig.fragileMoraleThreshold)) {
        AIDebugLog.log('fragile', this.tickCounter,
          `unit=${unit.id} team=${this.teamId} avgMorale below threshold — routing to reserve fallback`);
        const order = reserveBehavior.decide(unit, context, teamAnchor);
        if (order) unit.issueMoveOrder(order.x, order.z, order.facing);
        continue;
      }

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
        const order = behavior.decide(unit, enemyUnits, context, intent, this.assessment, worldCtx, null);
        if (order) unit.issueMoveOrder(order.x, order.z, order.facing);
        continue;
      }

      if (intent.phase === 'committed' && this._shouldStartRegroup(unit, intent, worldCtx)) {
        const failedTarget = intent.targetUnitId;
        AIDebugLog.regroupStart(this.tickCounter, unit.id, intent.ticksInMelee(this.tickCounter), this._countNearbyAllies(unit, worldCtx));
        intent.beginRegroup(this.tickCounter, failedTarget);
        if (failedTarget) {
          const priorCount = intent.repeatAttemptsByTargetId.get(failedTarget) || 0;
          intent.repeatAttemptsByTargetId.set(failedTarget, priorCount + 1);
        }
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
      if (this._currentPlan && this._currentPlan.roles.has(unit.id)) {
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
            if (isCavalry) {
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
            unit.issueMoveOrder(planOrder.x, planOrder.z, planOrder.facing);
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
          // Pass worldCtx so SkirmisherBehavior can read infantryLineAnchor
          // for its cavalry-cover fallback. Matches the 6-arg convention
          // already used by LineBehavior and FlankerBehavior.
          order = behavior.decide(unit, enemyUnits, context, intent, this.assessment, worldCtx);
        } else {
          const wpTarget = weakPointTargets.get(unit.id) || null;
          order = behavior.decide(unit, enemyUnits, context, intent, this.assessment, worldCtx, wpTarget);
        }
      }

      if (!order && intent.phase === 'seeking' && intent.ticksSinceFormed(this.tickCounter) === 0) {
        order = behavior.decide(unit, enemyUnits, context, intent, this.assessment, worldCtx);
      }

      if (!order) continue;

      // Diagnostic: log every issued order for cavalry units so we can
      // verify whether a "return to spears" window has fresh orders or is
      // running on a stale formationSlot from an earlier commit. The
      // phase/target fields disambiguate intent-owned orders
      // (committed/regrouping/seeking) from other sources (plan role,
      // reinforcement dispatch, archer intercept).
      if (isCavalry) {
        AIDebugLog.cavOrder(this.tickCounter, unit.id, order.x, order.z, intent.phase, intent.targetUnitId);
      }

      unit.issueMoveOrder(order.x, order.z, order.facing);
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
        const allyInMelee = ally.getAliveSoldiers().some(s => s.state === 'engaged');
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

  _syncMeleeTracking(unit, intent) {
    const inMelee = unit.getAliveSoldiers().some(
      s => s.state === 'engaged' || s.state === 'staggered'
    );
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
      if (s.state !== 'engaged' && s.state !== 'staggered') continue;
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
      // Cavalry is a strike-and-run weapon, not a grinder — but a
      // strike needs time to actually land. The previous "disengage on
      // first contact tick" rule caused cavalry to bounce off after a
      // single hit, leaving archer units at half strength. A short
      // minimum melee window (cavalryMeleeCommitTicks) lets the charge
      // damage resolve before the unit pulls out.
      //
      // Still no nearby-engaged-ally requirement — a solo charge should
      // bounce off once its strike is delivered. Ally count is an
      // infantry-cohesion concept with no bearing on whether a horse
      // should be standing in a spear formation.
      const inContact = unit.getAliveSoldiers().some(
        s => s.state === 'engaged' || s.state === 'staggered'
      );
      if (!inContact) return false;
      const ticksInMelee = intent.ticksInMelee(this.tickCounter);
      return ticksInMelee >= AIConfig.cavalryMeleeCommitTicks;
    }

    const ticksInMelee = intent.ticksInMelee(this.tickCounter);
    if (ticksInMelee < AIConfig.regroupTriggerTicksInMelee) return false;
    return this._countNearbyEngagedAllies(unit, worldCtx) < AIConfig.regroupMinAllies;
  }

  _unitIsInCombat(unit) {
    const alive = unit.getAliveSoldiers();
    for (const s of alive) {
      if (s.state === 'engaged' || s.state === 'staggered') {
        return true;
      }
    }
    return false;
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
    return { units, anchor: { x: sx / units.length, z: sz / units.length }, rangedUnits };
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
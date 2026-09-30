// ===== BattleAssessment.js =====
// Team-wide utility scoring. Computed a few times a second (see
// AIConfig.assessmentIntervalTicks), not every sim tick — this is
// deliberately coarse, aggregate data for POSTURE decisions (press / hold /
// retreat), not per-soldier targeting.
//
// This is the piece that was previously entirely absent: MoraleSystem
// already computes rich per-soldier morale/local-superiority data every
// tick, but nothing at the AI layer ever read it. TeamAI's old _decide()
// only ever asked "where is the nearest enemy", never "are we winning".
import { AIConfig } from '../config/AIConfig.js';
import { isCavalry } from '../config/UnitClasses.js';

export class BattleAssessment {
  // valiantDefence: when true, this team never adopts 'retreat' posture as
  // a strategy — see AIConfig-adjacent doc in TeamAI/BattleAI for the
  // rationale (outnumbered AI was withdrawing wholesale from tick 0 in
  // e.g. 3v5 openings, before any real fight happened). The RAW computed
  // posture is still stored (rawPosture) so strengthRatio/moraleAdvantage
  // and debug logs stay honest about the team's actual situation; only the
  // externally-read `posture` is clamped. This does not affect individual
  // tactical repositioning (kiting, cavalry regroup, make-way sidesteps —
  // none of those read posture at all), only the wholesale
  // LineBehavior._holdOrRetreatLine withdrawal and (later) RetreatPlan.
  //
  // tierCfg: optional AITierConfig entry. Read ONLY for the
  // skirmishersRespectCavalryBalance flag — when false (weakened tier),
  // the cavalry-cover read is skipped and skirmishersWithoutCavalryCover
  // stays false regardless of the actual cavalry balance. Passed as the
  // whole tier config rather than a lone boolean so future tier-gated
  // reads can land here without another constructor signature change.
  constructor(teamId, teamUnits, enemyUnits, valiantDefence, tierCfg) {
    this.teamId = teamId;
    this.valiantDefence = !!valiantDefence;
    this.tierCfg = tierCfg || null;

    const ownAlive = this._sumAlive(teamUnits);
    const enemyAlive = this._sumAlive(enemyUnits);

    this.ownAliveCount = ownAlive.count;
    this.enemyAliveCount = enemyAlive.count;
    this.strengthRatio = enemyAlive.count > 0
      ? ownAlive.count / enemyAlive.count
      : (ownAlive.count > 0 ? Infinity : 1);

    this.ownAvgMorale = ownAlive.count > 0 ? ownAlive.moraleSum / ownAlive.count : 0;
    this.enemyAvgMorale = enemyAlive.count > 0 ? enemyAlive.moraleSum / enemyAlive.count : 0;
    this.moraleAdvantage = this.ownAvgMorale - this.enemyAvgMorale;

    this.ownAvgHpFraction = ownAlive.count > 0 ? ownAlive.hpFracSum / ownAlive.count : 0;

    // Cavalry balance. Counted in SOLDIERS, not units — a cavalry unit at
    // half strength is not cavalry parity with a fresh one, and the point
    // of this read is "can our screen beat theirs", which is a headcount
    // question, not a unit-count one.
    this.ownCavalryCount = this._countAliveCavalrySoldiers(teamUnits);
    this.enemyCavalryCount = this._countAliveCavalrySoldiers(enemyUnits);
    // Derived flag for SkirmisherBehavior. Computed once here so the
    // threshold logic lives in one place (and gets the assessment
    // cadence for free), and so the tier gate is applied consistently.
    this.skirmishersWithoutCavalryCover = this._computeSkirmishersWithoutCavalryCover();

    // Posture: the single high-level lever TeamAI reads to bias every
    // behavior's decisions this interval (press harder / hold / fall back).
    this.rawPosture = this._computePosture();
    this.posture = (this.rawPosture === 'retreat' && this.valiantDefence)
      ? 'hold'
      : this.rawPosture;
  }

  _computePosture() {
    const cfg = AIConfig;
    if (this.ownAliveCount === 0) return 'retreat';
    if (this.enemyAliveCount === 0) return 'press';

    const wantsRetreat =
      this.strengthRatio <= cfg.retreatStrengthRatio ||
      this.moraleAdvantage <= cfg.retreatMoraleAdvantage;

    if (wantsRetreat) return 'retreat';

    const wantsPress =
      this.strengthRatio >= cfg.pressStrengthRatio ||
      this.moraleAdvantage >= cfg.pressMoraleAdvantage;

    if (wantsPress) return 'press';

    return 'hold';
  }

  // "Our archers have no cavalry cover" predicate, gated on the tier flag.
  // Rationale:
  //   - enemy has no cavalry → no threat to the screen → false.
  //   - we have cavalry but they're above the threshold → adequate cover.
  //   - we have ZERO cavalry and enemy has some → trivially uncovered.
  //     Falls out of the ratio comparison naturally (0 < any positive).
  //   - weakened tier → false regardless (the tier flag short-circuits
  //     before any ratio math, so a weakened AI never hugs the line for
  //     cavalry-cover reasons even if it's badly out-cavalried).
  _computeSkirmishersWithoutCavalryCover() {
    if (this.tierCfg && this.tierCfg.skirmishersRespectCavalryBalance === false) {
      return false;
    }
    if (this.enemyCavalryCount === 0) return false;
    if (this.ownCavalryCount === 0) return true;
    return this.ownCavalryCount <
      this.enemyCavalryCount * AIConfig.skirmisherCavalrySuperiorityThreshold;
  }

  // Alive soldiers of cavalry units only. Uses the same unitTypeDef.isCavalry
  // flag every other system keys cavalry off, so a new cavalry variant
  // (light horse, horse archer later) is counted automatically.
  _countAliveCavalrySoldiers(units) {
    let count = 0;
    for (const unit of units) {
      if (unit.isDefeated()) continue;
      const typeDef = unit.soldiers[0]?.unitTypeDef;
      if (!typeDef || !isCavalry(typeDef)) continue;
      count += unit.getAliveSoldiers().length;
    }
    return count;
  }

  _sumAlive(units) {
    let count = 0;
    let moraleSum = 0;
    let hpFracSum = 0;
    for (const unit of units) {
      if (unit.isDefeated()) continue;
      for (const soldier of unit.getAliveSoldiers()) {
        count++;
        moraleSum += soldier.morale;
        hpFracSum += soldier.hp / soldier.maxHp;
      }
    }
    return { count, moraleSum, hpFracSum };
  }

  // Local numeric superiority around a point (used for reinforcement
  // decisions: "is this specific unit's fight going badly enough to divert
  // help to it"). Separate from the team-wide posture, which is too coarse
  // for per-fight decisions.
  static localCounts(centerX, centerZ, allSoldiers, teamId, radius) {
    const radiusSq = radius * radius;
    let allyCount = 0;
    let enemyCount = 0;
    for (const s of allSoldiers) {
      if (!s.isAlive()) continue;
      const dx = s.pos.x - centerX;
      const dz = s.pos.z - centerZ;
      if (dx * dx + dz * dz > radiusSq) continue;
      if (s.teamId === teamId) allyCount++;
      else enemyCount++;
    }
    return { allyCount, enemyCount };
  }
}
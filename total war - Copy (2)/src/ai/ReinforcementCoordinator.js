import { AIConfig } from '../config/AIConfig.js';
import { isCavalry, isRanged } from '../config/UnitClasses.js';
import { BattleAssessment } from './BattleAssessment.js';
import { unitTypeOf, isFragile } from './behaviorUtils.js';
import { WeightedSelect } from './WeightedSelect.js';

// A2 — Reinforcement Request Pool.
//
// Resolves, once per TeamAI decision cycle, which free line units should be
// dispatched to reinforce which threatened allies. Replaces the previous
// per-unit greedy _reinforcementOverride, which could not express three
// things that matter:
//
//   - Deconfliction. Two units near the same threatened ally both saw the
//     same "neediest" target and both marched to it, wasting one. This
//     coordinator assigns at most ONE helper per threatened ally per
//     cycle, and at most one destination per helper.
//
//   - Winnability. A fight already at 1:5 local odds is not worth sending
//     help to — the helper dies with the ally. Filtered by an upper bound
//     (reinforcementMaxWinnableRatio) distinct from the lower bound
//     (reinforceLocalOutnumberRatio) that governs "does this fight need
//     help at all."
//
//   - Suitability. A spear is a hard counter to cavalry and a warm body
//     against sword. The old code had no way to express that and treated
//     every helper as equivalent. Suitability is looked up by the
//     helper's weapon type against the threatened ally's *nearest* enemy
//     type — the immediate threat, not a count-weighted average of
//     everyone nearby.
//
// A4 addition: fragile units (average morale below
// AIConfig.fragileMoraleThreshold) are never selected as helpers — a unit
// on the verge of routing is not a reliable reinforcement, and dispatching
// it just relocates a soon-to-be-rout rather than fixing the threatened
// fight.
//
// The coordinator is a pure function of world state. It holds no state
// across cycles; "post a request" happens implicitly by the ally being
// present, threatened, and winnable this cycle. This keeps it trivially
// testable and keeps the state-management question (if any is ever needed)
// out of A2's scope.
export class ReinforcementCoordinator {
  // Returns Map<helperUnitId, threatenedAllyUnitId>. A unit not present as
  // a key was not dispatched this cycle.
  //
  //   teamUnits   — this team's Unit objects.
  //   allSoldiers — all soldiers from both sides, for local-count queries.
  //   teamId      — this team's id.
  //   intents     — UnitIntentRegistry. Optional; when provided, only units
  //                 whose intent.phase === 'seeking' are eligible as
  //                 helpers, matching the old per-unit guard.
  static resolve(teamUnits, allSoldiers, teamId, intents) {
    const threats = this._collectThreats(teamUnits, allSoldiers, teamId);
    if (threats.length === 0) return new Map();

    const helpers = this._collectHelpers(teamUnits, allSoldiers, intents);
    if (helpers.length === 0) return new Map();

    // Worst threats first. Ties broken by the iteration order of
    // _collectThreats (unit id order via teamUnits), so the outcome is
    // deterministic given the same world state — the A2 acceptance
    // criteria do not require B4's weighted unpredictability, and adding
    // it here would make debugging the coordinator harder.
    threats.sort((a, b) => b.score - a.score);

    const dispatches = new Map();
    const dispatchedHelpers = new Set();

    for (const threat of threats) {
      const candidates = [];
      for (const helper of helpers) {
        if (dispatchedHelpers.has(helper.unit.id)) continue;
        const score = this._scoreHelper(helper, threat);
        if (score <= 0) continue;
        candidates.push({ helper, score });
      }
      if (candidates.length === 0) continue;

      // B4 retrofit: among helpers within the quality floor of the
      // top-scored suitability/distance candidate, weighted-pick rather
      // than always dispatching the single best-scored helper. Two
      // similarly-suitable spearmen equidistant from the same threat
      // should not always send the same one (by whatever incidental
      // iteration-order tiebreak happened to win) on every replay.
      const bestHelper = WeightedSelect.pick(candidates, {
        getScore: (c) => c.score,
        qualityFloorFraction: 0.85,
        temperature: 0.3
      });

      if (bestHelper) {
        dispatches.set(bestHelper.helper.unit.id, threat.unit.id);
        dispatchedHelpers.add(bestHelper.helper.unit.id);
      }
    }

    return dispatches;
  }

  // A threatened ally is a unit that is (a) in melee, (b) locally
  // outnumbered above the "needs help" threshold, and (c) not already so
  // far gone that a helper would just die alongside it.
  static _collectThreats(teamUnits, allSoldiers, teamId) {
    const out = [];
    for (const unit of teamUnits) {
      if (unit.isDefeated()) continue;
      const alive = unit.getAliveSoldiers();
      if (alive.length === 0) continue;

      const inMelee = alive.some(s => s.state === 'engaged');
      if (!inMelee) continue;

      const center = unit.getCenter();
      const { allyCount, enemyCount } = BattleAssessment.localCounts(
        center.x, center.z, allSoldiers, teamId,
        AIConfig.localSuperiorityRadius
      );
      if (allyCount === 0) continue;

      const ratio = enemyCount / allyCount;
      if (ratio < AIConfig.reinforceLocalOutnumberRatio) continue;
      if (ratio > AIConfig.reinforcementMaxWinnableRatio) continue;

      const nearestEnemyType = this._nearestEnemyWeaponType(
        center, allSoldiers, teamId, AIConfig.localSuperiorityRadius
      );

      const type = unitTypeOf(unit);
      const isRangedUnit = !!(type && isRanged(type));

      const cavMult = nearestEnemyType === 'cavalry'
        ? AIConfig.reinforcementCavalryThreatMult : 1.0;
      const rangedMult = isRangedUnit
        ? AIConfig.reinforcementRangedThreatMult : 1.0;

      out.push({
        unit,
        center,
        ratio,
        nearestEnemyType,
        score: ratio * cavMult * rangedMult
      });
    }
    return out;
  }

  // A helper is a free line unit: not defeated, not cavalry, not ranged,
  // not currently in melee, not fragile (A4), and (if intents were
  // supplied) in the seeking phase.
  static _collectHelpers(teamUnits, allSoldiers, intents) {
    const out = [];
    for (const unit of teamUnits) {
      if (unit.isDefeated()) continue;
      const type = unitTypeOf(unit);
      if (!type) continue;
      if (isCavalry(type)) continue;
      if (isRanged(type)) continue;

      if (isFragile(unit, AIConfig.fragileMoraleThreshold)) continue;

      if (intents) {
        const intent = intents.get(unit.id);
        if (intent.phase !== 'seeking') continue;
      }

      const alive = unit.getAliveSoldiers();
      if (alive.length === 0) continue;
      const inMelee = alive.some(
        s => s.state === 'engaged' || s.state === 'staggered'
      );
      if (inMelee) continue;

      out.push({
        unit,
        weaponType: type.weaponType,
        center: unit.getCenter()
      });
    }
    return out;
  }

  // Suitability of a helper for a given threat, scaled by a distance
  // falloff. Zero means out of range and the helper is not eligible.
  static _scoreHelper(helper, threat) {
    const dx = helper.center.x - threat.center.x;
    const dz = helper.center.z - threat.center.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= AIConfig.reinforceSearchRadius) return 0;

    const table = AIConfig.reinforcementSuitability[helper.weaponType];
    const suitability = (table && table[threat.nearestEnemyType]) ?? 1.0;

    // Linear falloff from 1.0 at distance 0 to 0.3 at reinforceSearchRadius.
    // Not zero at the edge because a suitable helper slightly further away
    // is still better than an unsuitable one nearby.
    const falloff = 1 - (dist / AIConfig.reinforceSearchRadius) * 0.7;

    return suitability * falloff;
  }

  // Type of the single nearest living enemy to a point. "Nearest" rather
  // than "most numerous" because the immediate threat is what a helper
  // would be walking into — a screen of friendly-adjacent spears five
  // units back is not the fight the ally is losing right now.
  static _nearestEnemyWeaponType(center, allSoldiers, teamId, radius) {
    const radiusSq = radius * radius;
    let nearestDistSq = Infinity;
    let nearestType = null;
    for (const s of allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.teamId === teamId) continue;
      const dx = s.pos.x - center.x;
      const dz = s.pos.z - center.z;
      const dSq = dx * dx + dz * dz;
      if (dSq > radiusSq) continue;
      if (dSq < nearestDistSq) {
        nearestDistSq = dSq;
        nearestType = s.unitTypeDef.weaponType;
      }
    }
    return nearestType;
  }
}
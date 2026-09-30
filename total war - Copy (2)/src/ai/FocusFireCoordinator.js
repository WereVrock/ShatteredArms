// Team-level archer target assignment. Without this, RangedCombatSystem's
// per-soldier "ranged" targeting (set by TargetingSystem, nearest enemy per
// soldier) means archer damage is smeared across whatever's nearest to each
// individual archer — no concentration, so nothing actually dies to arrow
// fire in a reasonable time.
//
// This does NOT bypass TargetingSystem or RangedCombatSystem — those still
// own actual hit/damage resolution. What this does is set focusTargetUnitId
// on friendly archer UNITS (the same mechanism the player's right-click
// "attack that unit" order uses — see Unit.issueAttackOrder), so every
// archer in that unit chases/fires-at the nearest soldier of the SAME
// chosen enemy unit, per the existing focus-target branch in
// TargetingSystem.update(). Re-picking a team-wide focus target this way
// concentrates fire without adding a second competing targeting system.
import { AIConfig } from '../config/AIConfig.js';
import { WeightedSelect } from './WeightedSelect.js';

export class FocusFireCoordinator {
  // archerUnits: this team's ranged units (not defeated).
  // enemyUnits: living enemy units.
  // postureProfile: optional C3 posture profile (AIConfig.posture.press /
  // .hold). Defaults to .hold's behavior (wounded-only tier 1 preference,
  // matching pre-C3 output) when omitted, so existing callers are unaffected.
  static assign(archerUnits, enemyUnits, objectiveUnit, postureProfile) {
    if (archerUnits.length === 0 || enemyUnits.length === 0) return;

    let target = null;
    if (objectiveUnit && !objectiveUnit.isDefeated()) {
      const ec = objectiveUnit.getCenter();
      const reachable = archerUnits.some(a => {
        if (a.isDefeated()) return false;
        const ac = a.getCenter();
        const dx = ec.x - ac.x;
        const dz = ec.z - ac.z;
        return dx * dx + dz * dz <= 25 * 25;
      });
      if (reachable) target = objectiveUnit;
    }

    if (!target) {
      target = this._pickFocusTarget(archerUnits, enemyUnits, postureProfile);
    }
    if (!target) return;

    for (const archerUnit of archerUnits) {
      if (archerUnit.isDefeated()) continue;
      // Set aiFocusTargetUnitId directly, NOT via issueAttackOrder.
      //
      // issueAttackOrder has a movement side effect — it clears the
      // march destination and makes Unit.update drag the formation
      // anchor toward the focus unit's center. That is correct for a
      // player right-click ("march at that unit and fight it") but
      // wrong for AI focus fire, because SkirmisherBehavior is
      // simultaneously issuing move orders to hold the archer at
      // standoff / hug-line positions. The two fought: every focus-fire
      // update pulled archers forward, every skirmisher update pushed
      // them back, and the archers oscillated between the line and the
      // enemy instead of standing anywhere.
      //
      // aiFocusTargetUnitId carries the targeting preference without
      // the movement side effect, so TargetingSystem still concentrates
      // every archer's fire on the same chosen unit while the archer's
      // position stays under SkirmisherBehavior's sole control.
      if (archerUnit.aiFocusTargetUnitId !== target.id) {
        archerUnit.aiFocusTargetUnitId = target.id;
      }
    }
  }

  static _pickFocusTarget(archerUnits, enemyUnits, postureProfile) {
    const alive = enemyUnits.filter(u => !u.isDefeated());
    if (alive.length === 0) return null;

    // Only consider enemy units actually reachable by at least one archer
    // unit's current volley range — otherwise we'd focus-fire something no
    // archer can currently hit, wasting the whole mechanism.
    const reachable = alive.filter(enemy => {
      const ec = enemy.getCenter();
      return archerUnits.some(a => {
        if (a.isDefeated()) return false;
        const ac = a.getCenter();
        const dx = ec.x - ac.x;
        const dz = ec.z - ac.z;
        // Generous reach check (rangedRange lives in CombatConfig, not
        // AIConfig; approximate with a wide radius here since this is only
        // a candidate filter — actual fire eligibility is still fully
        // owned by RangedCombatSystem regardless of what we pick).
        return dx * dx + dz * dz <= 25 * 25;
      });
    });
    const pool = reachable.length > 0 ? reachable : alive;

    // Tier 1: already-wounded units (below focusFireLowHpFraction avg HP) —
    // finishing wounded units off denies the enemy any chance of that unit
    // recovering fatigue/reforming.
    const wounded = pool.filter(u => this._avgHpFraction(u) <= AIConfig.focusFireLowHpFraction);

    // C3: hold (or no profile supplied) keeps the original strict-tier
    // behavior — wounded targets always win outright when any exist. Press
    // instead throws tier-1 AND tier-2 into one WeightedSelect pool so an
    // aggressive team sometimes opens fire on a fresh unshielded target
    // instead of always finishing the same wounded one, per B4's "retrofit
    // beyond the plan scheduler" requirement.
    const woundedOnly = !postureProfile || postureProfile.focusFireWoundedOnly !== false;

    if (woundedOnly) {
      if (wounded.length > 0) {
        return this._nearestToArcherCentroid(wounded, archerUnits);
      }
      const unshielded = this._unshieldedOf(pool);
      if (unshielded.length > 0) {
        return this._nearestToArcherCentroid(unshielded, archerUnits);
      }
      return this._nearestToArcherCentroid(pool, archerUnits);
    }

    const unshielded = this._unshieldedOf(pool);
    const widenedPool = wounded.length > 0 || unshielded.length > 0
      ? this._dedupeUnits([...wounded, ...unshielded])
      : pool;

    return this._weightedNearestToArcherCentroid(widenedPool, archerUnits, wounded);
  }

  static _unshieldedOf(pool) {
    // Unshielded or already-shield-broken units — arrows are wasted
    // against a raised shield; prefer targets where every hit counts.
    return pool.filter(u => {
      const soldiers = u.getAliveSoldiers();
      if (soldiers.length === 0) return false;
      const shieldless = soldiers.filter(s => !s.hasShield).length;
      return shieldless / soldiers.length >= 0.5;
    });
  }

  static _dedupeUnits(units) {
    const seen = new Set();
    const out = [];
    for (const u of units) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      out.push(u);
    }
    return out;
  }

  // C3/B4: weighted pick across a widened candidate pool, scored by
  // (closeness to archer centroid) with a bonus for being in the wounded
  // set, so wounded targets are still favored on average but not always
  // chosen deterministically.
  static _weightedNearestToArcherCentroid(candidates, archerUnits, woundedSet) {
    if (candidates.length === 0) return null;
    const woundedIds = new Set(woundedSet.map(u => u.id));

    let sx = 0, sz = 0, count = 0;
    for (const a of archerUnits) {
      if (a.isDefeated()) continue;
      const c = a.getCenter();
      sx += c.x; sz += c.z; count++;
    }
    if (count === 0) return candidates[0];
    const cx = sx / count;
    const cz = sz / count;

    let maxDist = 1;
    const dists = candidates.map(u => {
      const c = u.getCenter();
      const dx = c.x - cx, dz = c.z - cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > maxDist) maxDist = d;
      return d;
    });

    return WeightedSelect.pick(candidates, {
      getScore: (u) => {
        const idx = candidates.indexOf(u);
        const proximityScore = 1 - (dists[idx] / maxDist); // 0..1, closer = higher
        const woundedBonus = woundedIds.has(u.id) ? 0.5 : 0;
        return proximityScore + woundedBonus;
      },
      qualityFloorFraction: 0.7,
      temperature: 0.5
    });
  }

  static _avgHpFraction(unit) {
    const soldiers = unit.getAliveSoldiers();
    if (soldiers.length === 0) return 1;
    return soldiers.reduce((sum, s) => sum + s.hp / s.maxHp, 0) / soldiers.length;
  }

  static _nearestToArcherCentroid(candidates, archerUnits) {
    let sx = 0, sz = 0, count = 0;
    for (const a of archerUnits) {
      if (a.isDefeated()) continue;
      const c = a.getCenter();
      sx += c.x;
      sz += c.z;
      count++;
    }
    if (count === 0) return candidates[0];
    const cx = sx / count;
    const cz = sz / count;

    let best = null;
    let bestDist = Infinity;
    for (const u of candidates) {
      const c = u.getCenter();
      const dx = c.x - cx;
      const dz = c.z - cz;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = u;
      }
    }
    return best;
  }
}
// Team-level objective planner. This is the missing "plan to win" layer:
// previously, weak-point concentration (EnemyLineAnalysis), reinforcement
// (_reinforcementOverride), cavalry targeting (FlankerBehavior), and archer
// focus fire (FocusFireCoordinator) each independently picked their own
// notion of "best target" — four uncoordinated heuristics that could (and
// did) point different parts of the team at different enemy units
// simultaneously. That produces exactly the reported symptom: half the
// infantry chasing an "unoccupied" flank target while the front line goes
// unpressed, cavalry charging alone with no infantry support, archers
// possibly focusing yet another target entirely.
//
// WinPlanner computes ONE objective per planning cycle: which single enemy
// unit the whole team should collapse first. Every other subsystem now
// consults this objective FIRST and only falls back to its own independent
// logic if the objective doesn't apply to it (e.g. a unit already locked in
// its own local melee shouldn't abandon it to chase the team objective).
//
// Selection criteria, in order:
//   1. Must be a genuinely weak target: EnemyLineAnalysis-style scoring
//      (alive count + HP), but ALSO must be one that's actually reachable/
//      engageable soon — see "already contested" exclusion below.
//   2. EXCLUDES units that are undefended simply because nothing has
//      reached them yet (not "weak", just "not yet fought") UNLESS the
//      team has a genuine, safe path to concentrate there — approximated
//      by requiring the candidate to be within reasonable reach of at
//      least reinforcementMinSupportUnits of our own currently-idle/
//      seeking units, so we don't send a fraction of the line on a lonely
//      flanking errand while the rest fights alone.
//   3. Prefers targets NOT currently well-positioned to brace (uses
//      ChargeReadiness-style facing math at the unit level) so cavalry
//      commitments and the team objective agree with each other instead
//      of fighting for different targets.
import { AIConfig } from '../config/AIConfig.js';
import { EnemyLineAnalysis } from './EnemyLineAnalysis.js';
import { AIDebugLog } from './AIDebugLog.js';

export class WinPlanner {
  // Returns { objectiveUnit: Unit|null, supportingUnitIds: Set<number> }
  static plan(teamUnits, enemyUnits, formation, teamIdForLog, tickForLog) {
    const eligibleEnemies = enemyUnits.filter(u => !u.isDefeated());
    if (eligibleEnemies.length === 0) {
      return { objectiveUnit: null };
    }

    const axis = formation ? formation.getLineAxis(teamUnits, enemyUnits) : null;
    const analysis = new EnemyLineAnalysis(eligibleEnemies, axis, AIConfig.enemyLineSliceWidth);

    // Rank ALL enemy units (not just the single weakest slice) by a
    // combined score so we can reject a "weak" candidate that fails the
    // contested/reachability check and fall through to the next-best,
    // rather than giving up on planning entirely.
    const scored = eligibleEnemies
      .map(u => ({ unit: u, score: this._scoreCandidate(u, teamUnits) }))
      .filter(e => e.score !== null)
      .sort((a, b) => a.score - b.score);

    for (const candidate of scored) {
      if (this._hasEnoughReach(candidate.unit, teamUnits)) {
        AIDebugLog.objective(tickForLog || 0, teamIdForLog || '?', `${candidate.unit.id} (score=${candidate.score.toFixed(2)}, reach OK)`);
        return { objectiveUnit: candidate.unit };
      }
    }

    // Nothing passed the reach check (e.g. very early in the battle, teams
    // still approaching) — fall back to the analysis's raw weakest unit if
    // one exists, so early-game still has SOME shared objective rather than
    // none.
    const fallback = analysis.getWeakestUnit();
    AIDebugLog.objective(tickForLog || 0, teamIdForLog || '?', fallback ? `${fallback.id} (fallback, no candidate had reach)` : 'NONE');
    return { objectiveUnit: fallback || null };
  }

  // Lower score = more attractive target. Combines alive-count/HP strength
  // (weaker = better) with a rough "how contested is this already" signal —
  // a unit already fully engaged by us is a poor NEW objective (we're
  // already committed there; the point of WinPlanner is to pick where to
  // send UNCOMMITTED force, not re-describe an existing fight).
  static _scoreCandidate(enemyUnit, teamUnits) {
    const soldiers = enemyUnit.getAliveSoldiers();
    if (soldiers.length === 0) return null;

    const hpFracSum = soldiers.reduce((sum, s) => sum + s.hp / s.maxHp, 0);
    const strength = soldiers.length * (0.5 + 0.5 * (hpFracSum / soldiers.length));

    const alreadyEngagedByUs = teamUnits.some(t =>
      !t.isDefeated() && t.getAliveSoldiers().some(s => s.state === 'engaged' && this._targetsUnit(s, enemyUnit))
    );
    // Slightly deprioritize (not exclude) already-engaged targets — still a
    // valid objective to REINFORCE, just not the first choice for a fresh
    // team-wide push when an untouched weak point might exist.
    const engagementPenalty = alreadyEngagedByUs ? 0 : -0.5;

    return strength + engagementPenalty;
  }

  static _targetsUnit(soldier, unit) {
    return unit.getAliveSoldiers().some(s => s.id === soldier.targetId);
  }

  // Reachability/support check: requires at least
  // reinforcementMinSupportUnits of our team's units to be within
  // reasonable distance of this candidate — this is the direct fix for
  // "half the infantry flanks an unoccupied target alone": a candidate only
  // becomes the shared objective if enough of the team can plausibly
  // converge on it, not just whichever single unit happens to be closest.
  static _hasEnoughReach(enemyUnit, teamUnits) {
    const center = enemyUnit.getCenter();
    let supportCount = 0;
    for (const t of teamUnits) {
      if (t.isDefeated()) continue;
      const c = t.getCenter();
      const dx = c.x - center.x;
      const dz = c.z - center.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= AIConfig.winPlannerSupportRadius) {
        supportCount++;
        if (supportCount >= AIConfig.winPlannerMinSupportUnits) return true;
      }
    }
    return false;
  }
}
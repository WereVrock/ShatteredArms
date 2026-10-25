// ===== routingSpearsVsCavWithLine.js =====
// Same shape as cavChasesRoutingSpears, but with a small blue line unit
// added to the roster. The line unit exists for one reason: to make
// FlankerBehavior._shouldMassCharge return false.
//
// cavChasesRoutingSpears is pure cavalry, which triggers the mass-charge
// branch — that branch commits WITHOUT calling ChargeReadiness.assess at
// all (see FlankerBehavior._decideSeeking). So the previous scenario
// tested routing-chase priority (Fix 2) and routing-can't-brace in
// CombatResolutionSystem (Fix 1b), but never exercised the routing guard
// in ChargeReadiness._willBeFacingInTime (Fix 1a) because assess was
// never called.
//
// Adding one blue melee unit flips _shouldMassCharge to false (there is
// now a melee line), which forces the cav through the regular
// _decideSeeking path. That path calls ChargeReadiness.assess on the
// candidate target, which is where Fix 1a lives.
//
// What to look for in the log:
//   [AI][charge][tN] assess cav=blue-cav-1 target=red-spear-routing ...
//     impact=0/N corridor=0 => clean=true
//   This line is the direct evidence that Fix 1a works. If the assess
//   line reports impact=3/3 against a fully routing spear, the routing
//   guard in _willBeFacingInTime is not firing.
//
// What would indicate a failure:
//   - No assess line at all (mass-charge bypass is still active, so the
//     line unit didn't register as a melee line).
//   - assess line shows impact>0 against red-spear-routing (routing
//     soldiers are still being sampled as brace candidates).
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'routing-spears-vs-cav-with-line',
  name: 'Cavalry chases routing spears (with line, exercises ChargeReadiness)',
  description:
    'Variant of "Cavalry chases routing spearmen" with a small blue ' +
    'melee line added so FlankerBehavior._shouldMassCharge returns false ' +
    'and ChargeReadiness.assess is actually called. This is the scenario ' +
    'that validates Fix 1a — routing soldiers excluded from the brace ' +
    'prediction — which the pure-cav variant could not reach. Look for ' +
    '[AI][charge] assess ... impact=0/N ... clean=true against ' +
    'red-spear-routing. Failure mode: assess reports impact=3/3 (routing ' +
    'defenders still counted as potential bracers).',
  maxTicks: 900,
  aiTeams: ['blue'],
  build() {
    const units = [
      // The star of the test.
      unit('blue-cav-1', 'blue', 'horsemen', 0, -10, FACE_SOUTH),

      // The line unit whose only job is to defeat the mass-charge branch.
      // Parked at the corner so it doesn't reach the fight in time to
      // contaminate the result — 40 units of lateral offset plus the
      // cav's clean charge should resolve first.
      unit('blue-line-1', 'blue', 'spearman', 40, -10, FACE_SOUTH),

      // Primary target — same as the pure-cav variant.
      unit('red-spear-routing', 'red', 'spearman', 0, 6, FACE_NORTH),

      // The weaker live unit that WinPlanner prefers as the shared
      // objective. Deliberately 8 soldiers to red-spear-routing's 15.
      unit('red-spear-live', 'red', 'spearman', 0, 12, FACE_NORTH, { rows: 2, cols: 4 })
    ];

    // Pre-route red-spear-routing exactly as in cavChasesRoutingSpears.
    const routing = units.find(u => u.id === 'red-spear-routing');
    for (const s of routing.soldiers) {
      s.state = 'routing';
      s.isRouting = true;
      s.morale = -200;
      s.routCountThisBattle = 1;
      s.targetId = null;
    }

    return units;
  }
};
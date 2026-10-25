// ===== cavChasesRoutingSpears.js =====
// Regression test for the routing-chase fixes:
//   1. FlankerBehavior._decideSeeking — routing-chase priority now runs
//      BEFORE the shared-objective shortcut. Previously the objective
//      check lived at the top, so a live spear unit that WinPlanner
//      selected permanently short-circuited the routing-chase branch
//      that lives inside _pickFlankTarget.
//   2. ChargeReadiness._willBeFacingInTime — routing / shattered defenders
//      are excluded from the brace prediction. Previously a routing
//      spearman was treated as a defender that "would brace in time"
//      (available turn budget at long range clips to ~1000°, so nearly
//      every spear at every angle reads as bracing), and the charge was
//      refused every cycle.
//   3. CombatResolutionSystem._isBracedSpearman — a routing / shattered
//      defender cannot brace, so the charge gets its full bonus and
//      throw even if the defender somehow reaches the brace check.
//
// Setup:
//   - One AI-controlled blue cavalry unit.
//   - One red spear unit that starts FULLY ROUTING (all soldiers) — the
//     primary target. Placed within cavalryRoutingChaseRadius of the cav.
//   - One red spear unit that is alive, not routing, and DELIBERATELY
//     weaker than the routing one (8 soldiers vs 15). This makes
//     WinPlanner prefer it as the shared objective, so the objective
//     shortcut in the OLD _decideSeeking would have targeted the live
//     unit and refused every charge against it.
//
// What this test distinguishes:
//   OLD behavior (before fixes):
//     - Objective = red-spear-live (weaker score). Blue cav targets it.
//     - ChargeReadiness against the live spear: 3/3 defenders "would
//       brace in time" at long range. clean=false, repeat forever.
//     - Cav hovers at flank slot. Routing spearmen walk off the map.
//   NEW behavior (after fixes):
//     - Routing-chase priority fires FIRST. Cav targets red-spear-routing.
//     - ChargeReadiness excludes routing defenders from the sample:
//       impact=0/N, clean=true. COMMIT.
//     - Charge lands, deaths accumulate, routing unit is destroyed or
//       driven into the 20% shatter floor.
//
// Failure modes to watch for:
//   - Cav never commits. 'charge' lines with target=red-spear-routing and
//     clean=false reason="defenders likely to turn and brace before
//     contact" with impact>0 means _willBeFacingInTime is still counting
//     routing defenders.
//   - Cav targets red-spear-live instead. The routing-chase priority is
//     not outranking the objective in _decideSeeking.
//   - Cav charges but is braced, taking counter-damage from routers.
//     _isBracedSpearman is not honoring the routing/shattered guard.
//   - Routing unit's end alive count is high (>5). The cav never closed.
//
// Expected health line: ranged[fire=0] (pure melee). melee death > 0.
// red-spear-routing should end at 0 or near-0 alive.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'cav-chases-routing-spears',
  name: 'Cavalry chases routing spearmen',
  description:
    'REGRESSION for routing-chase priority and "routing soldiers cannot ' +
    'brace". One AI-controlled blue cavalry unit faces a pre-routed red ' +
    'spear unit (all soldiers start routing with deep-negative morale) and ' +
    'a LIVE red spear unit that is deliberately WEAKER (8 soldiers vs 15) ' +
    'so WinPlanner prefers it as the shared objective. On the old code the ' +
    'objective shortcut in FlankerBehavior._decideSeeking targeted the ' +
    'live unit, ChargeReadiness refused every cycle against a "braced" ' +
    'spear wall, and the cav hovered at its flank slot while the routers ' +
    'walked off the map. On the fixed code the routing-chase priority ' +
    'fires first, ChargeReadiness reads routing defenders as unable to ' +
    'brace, and the cav runs down the routers. Health line: ' +
    'red-spear-routing should end at 0 or near-0 alive; ranged[fire=0] ' +
    'is expected (pure melee).',
  maxTicks: 900,
  aiTeams: ['blue'],
  build() {
    const units = [
      unit('blue-cav-1', 'blue', 'horsemen', 0, -10, FACE_SOUTH),

      // Primary target. Placed at (0, 6) so it starts well inside
      // cavalryRoutingChaseRadius (18.0) from blue-cav-1's starting
      // position — the routing-chase branch in FlankerBehavior cannot
      // fire at all if the router starts out of that radius.
      unit('red-spear-routing', 'red', 'spearman', 0, 6, FACE_NORTH),

      // Distractor / shared objective. Deliberately weakened to 8
      // soldiers so EnemyLineAnalysis scores it LOWER than the 15-strong
      // routing unit, which makes WinPlanner hand this unit to TeamAI as
      // the team objective. That is the condition under which the old
      // objective-shortcut path in _decideSeeking would have targeted
      // this unit and refused every charge against it — the exact
      // failure mode this scenario exists to catch.
      unit('red-spear-live', 'red', 'spearman', 0, 12, FACE_NORTH, { rows: 2, cols: 4 })
    ];

    // Pre-route red-spear-routing. Morale is pushed deeply negative so
    // that the 0.8/tick routing regen (regenPerTick + routingRegenBonus)
    // cannot bring the soldiers back over the 92 rally threshold inside
    // the test window: 900 ticks * 0.8 = 720 recovery budget, and -200
    // leaves a comfortable margin. routCountThisBattle is pre-bumped to
    // 1 so the auto-shatter-on-second-rout path is not triggered by the
    // regen race — we want the unit to stay routing for as long as it
    // takes the cavalry to close, not to shatter on its own.
    //
    // Also set isRouting = true so MoraleSystem's normal routing
    // processing (and the flee-direction computation in MovementSystem)
    // treat these soldiers as genuinely routing rather than as idle
    // soldiers with a low morale value.
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
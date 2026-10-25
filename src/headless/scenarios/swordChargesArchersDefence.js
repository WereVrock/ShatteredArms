// ===== swordChargesArchersDefence.js =====
// Tests the swordsman anti-archer rule in the DEFENCE case — a swordsman
// holding position on defence stance punishes an archer that wanders into
// its range.
//
// Why the setup is shaped this way:
//
//   - Blue must be on defence stance. That requires BOTH
//     strengthRatio < offenceStrengthRatio (1.0) AND own ranged power > 0.
//     A team with zero ranged units is force-flipped to offence by
//     BattleAssessment._shouldFlipForArcherPressure the moment the enemy
//     fields any archer. So blue carries a full 15-archer unit to satisfy
//     the ranged-parity check. Placed at (30,-10), out of range of
//     anything, it will not interfere with the melee that develops.
//
//   - Blue ratio: (15 swordsman + 15 archer) / (3*15 spears + 15 archer)
//     = 30/60 = 0.5 → defence. Blue ranged power = 15 archer soldiers,
//     red ranged power = 15 archer soldiers → no flip.
//
//   - Red is NOT AI-driven. The archer is placed at (0,15) and given a
//     scripted move order at tick 0 to walk to (0,-5). It walks south
//     past the swordsman's (0,-10) position and comes within swordrush
//     range (12 units) at around tick 250. Without the script the red
//     archer would stand off at 16.5 and never enter the trigger radius —
//     the mechanic only fires when the archer can't maintain standoff,
//     which is exactly the case a script simulates cleanly.
//
// What to look for in the log:
//   [AI][swordrush][tNNN] unit=blue-sword-1 charge-archer=red-archer-1 dist=...
//   fired around t=250, followed by the swordsman's ORDER line changing
//   from a hold to a walk toward the archer. By t=400 the swordsman
//   should be in melee and the archer should have taken damage.
//
// What would indicate a failure:
//   - swordrush never fires (unit class gate or range gate is broken).
//   - The swordsman never moves off its defence hold (swordrush is being
//     shadowed by the stance check).
//   - The swordsman fires swordrush but never actually closes distance
//     (intent stickiness is broken and it re-derives a hold each cycle).
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'sword-charges-archers-defence',
  name: 'Swordsman charges archers (defence stance)',
  description:
    'DEFENCE case. Blue is on defence stance (ratio 0.5, ranged parity ' +
    'to avoid the archer-pressure flip). One blue swordsman holds at ' +
    '(0,-10). A red archer at (0,15) is scripted to walk south to (0,-5), ' +
    'passing through the swordsman\'s 12-unit swordrush radius. Expected: ' +
    'swordrush fires around t=250, the swordsman breaks formation and ' +
    'charges, melee contact by t=400. Failure modes: swordrush never ' +
    'fires; swordsman never moves; swordsman fires but never closes.',
  maxTicks: 700,
  aiTeams: ['blue'],
  scriptedOrders: [
    { unitId: 'red-archer-1', atTick: 0, x: 0, z: -5, facing: FACE_NORTH }
  ],
  build() {
    return [
      // Blue: swordsman that should do the charging, plus a full archer
      // unit placed far off to the side whose only job is to keep blue's
      // ranged power non-zero so the stance flip doesn't fire.
      unit('blue-sword-1', 'blue', 'swordsman', 0, -10, FACE_SOUTH),
      unit('blue-archer-1', 'blue', 'archer', 30, -10, FACE_SOUTH),

      // Red: three spearmen in a row at (x,15) that never move (red has
      // no AI). Their only job is to bulk up red's roster so blue's
      // strengthRatio is low enough to land on defence.
      unit('red-spear-1', 'red', 'spearman', -8, 15, FACE_NORTH),
      unit('red-spear-2', 'red', 'spearman', 0, 15, FACE_NORTH),
      unit('red-spear-3', 'red', 'spearman', 8, 15, FACE_NORTH),

      // The scripted archer. Walks from (0,15) to (0,-5) at march-anchor
      // speed (~1.3 units/sec). Reaches the swordsman's 12-unit boundary
      // at around tick 250.
      unit('red-archer-1', 'red', 'archer', 0, 15, FACE_NORTH)
    ];
  }
};
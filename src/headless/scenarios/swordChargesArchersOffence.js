// ===== swordChargesArchersOffence.js =====
// Tests the swordsman anti-archer rule in the OFFENCE case — a swordsman
// following the line in cohesion approach, with an archer sitting near
// its forward path. The swordsman should divert from its line-cohesion
// goal onto the archer rather than continuing toward the enemy mean.
//
// Why the setup is shaped this way:
//
//   - Blue is a bare swordsman (15) facing a red spear + archer (30).
//     Ratio 0.5 → defence, but blue has no ranged units so the flip in
//     BattleAssessment._shouldFlipForArcherPressure fires → offence.
//     Either way the swordsman is advancing, which is what this test
//     needs.
//
//   - Red is NOT AI-driven so its units don't move. The archer sits at
//     (20,5) — well off the swordsman's straight-line path at first,
//     then crossed as the swordsman walks toward the enemy mean.
//
//   - The red spear at (20,30) anchors the enemy mean at (20,17.5), so
//     blue's cohesion goal is (20,16.1). The swordsman walks from
//     (0,-10) to (20,16.1). Its closest approach to the archer at (20,5)
//     is ~10.2 units, well inside the 12-unit swordrush trigger — but
//     only around 45% of the way along its walk, so the swordrush is a
//     genuine mid-approach diversion rather than a start-of-walk pickup.
//
// What to look for in the log:
//   [AI][swordrush][tNNN] unit=blue-sword-1 charge-archer=red-archer-1 dist=...
//   fired somewhere around t=300 (partway through the swordsman's walk,
//   well before it reaches its cohesion goal). After the swordrush fires,
//   the swordsman's ORDER lines should point at the archer's live center
//   rather than at (20,16.1).
//
// What would indicate a failure:
//   - swordrush fires but the swordsman's subsequent orders still target
//     the cohesion slot (intent.targetUnitId isn't being honored by
//     _resolveTarget on the fall-through cycle).
//   - swordrush never fires (the trigger radius is being measured from
//     the wrong unit or the unit-class gate is rejecting the swordsman).
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'sword-charges-archers-offence',
  name: 'Swordsman charges archers (offence stance)',
  description:
    'OFFENCE case. Blue fields a bare swordsman; ratio 0.5 flips it to ' +
    'offence. Red (no AI) has a spear at (20,30) and an archer at (20,5). ' +
    'Blue\'s cohesion goal is (20,16.1), and the swordsman\'s straight-line ' +
    'path passes within ~10 units of the archer mid-walk. Expected: ' +
    'swordrush fires around t=300, mid-approach, and the swordsman\'s ' +
    'subsequent orders divert from the cohesion slot to the archer. ' +
    'Failure modes: swordrush never fires; fires but doesn\'t change the ' +
    'follow-through orders.',
  maxTicks: 900,
  aiTeams: ['blue'],
  build() {
    return [
      unit('blue-sword-1', 'blue', 'swordsman', 0, -10, FACE_SOUTH),

      // Red spear anchors the enemy mean. Without it, the cohesion goal
      // would be the archer's position and the swordsman's walk would be
      // straight at the archer — the swordrush would then be a no-op that
      // happens to log. With the spear present, the cohesion goal is off
      // to the side and the swordrush is a genuine diversion.
      unit('red-spear-1', 'red', 'spearman', 20, 30, FACE_NORTH),

      // The archer the swordsman should pick up. Sits off the cohesion
      // path at start, is crossed mid-walk.
      unit('red-archer-1', 'red', 'archer', 20, 5, FACE_NORTH)
    ];
  }
};
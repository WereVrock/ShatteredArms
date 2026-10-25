// Detects an incoming charge and sets the threatened soldier's
// DESIRED facing toward it — this is the "will your men see the charge
// coming" reaction from Total War. It does NOT rotate `facing` directly;
// FacingSystem still owns the actual bounded-rate turn, so a soldier who
// notices a flank charge only gets the CHANCE to turn and brace in time,
// not a free instant snap.
//
// Runs BEFORE FacingSystem each tick (see BattleSimulation tick order) so
// FacingSystem always sees this tick's freshest desired facing before it
// moves `facing` toward it.
//
// Only affects soldiers who aren't already actively oriented by something
// more urgent: engaged/ranged soldiers already face their target (handled
// in FacingSystem, which takes priority regardless — see there), so this
// system only needs to act on idle/marching/impetuous/staggered-recovering
// soldiers who would otherwise hold formation facing with no idea a charge
// is coming.
import { CombatConfig } from '../config/CombatConfig.js';
import { toSimSpeed } from '../config/SpeedScale.js';
import { isCavalry } from '../config/UnitClasses.js';

export class ThreatFacingSystem {
  update(allSoldiers) {
    // This system is the single owner of _threatFacingSetThisTick: it resets
    // the flag to false for every soldier at the start of its own pass, then
    // sets it true only for soldiers it actually assigns a threat-facing to
    // this tick. FacingSystem only ever READS the flag, never writes it, so
    // there is exactly one place that decides "was a threat facing set this
    // tick" and no cross-system ordering to get wrong.
    for (const s of allSoldiers) {
      s._threatFacingSetThisTick = false;
    }

    // Build a lightweight list of active chargers once per tick rather than
    // scanning all soldiers per soldier — still O(n*m) worst case but m is
    // normally small (few cavalry units), and this only runs the outer loop
    // over soldiers who can actually benefit from reacting.
    const chargers = [];
    for (const s of allSoldiers) {
      if (!s.isAlive()) continue;
      if (!isCavalry(s.unitTypeDef)) continue;
      if (s.currentSpeed < toSimSpeed(CombatConfig.threatFacing.detectSpeedThreshold)) continue;
      chargers.push(s);
    }
    if (chargers.length === 0) return;

    const detectRadiusSq = CombatConfig.threatFacing.detectRadius * CombatConfig.threatFacing.detectRadius;

    for (const soldier of allSoldiers) {
      if (!soldier.isAlive()) continue;
      // Already actively facing something more immediate — engaged/ranged
      // combat facing (set in FacingSystem) takes priority and this system
      // must not override it with a threat that hasn't reached melee yet.
      if (soldier.state === 'engaged' || soldier.state === 'ranged') continue;
      // Airborne/knockedDown soldiers can't meaningfully react.
      if (soldier.state === 'knockedDown') continue;
      if (soldier.airborneTicksLeft > 0) continue;

      let nearest = null;
      let nearestDistSq = Infinity;

      for (const charger of chargers) {
        if (charger.teamId === soldier.teamId) continue;
        const dx = charger.pos.x - soldier.pos.x;
        const dz = charger.pos.z - soldier.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq > detectRadiusSq) continue;
        if (dSq < nearestDistSq) {
          nearestDistSq = dSq;
          nearest = charger;
        }
      }

      if (!nearest) continue;

      soldier.desiredFacing = Math.atan2(
        nearest.pos.x - soldier.pos.x,
        nearest.pos.z - soldier.pos.z
      );
      soldier._threatFacingSetThisTick = true;
    }
  }
}
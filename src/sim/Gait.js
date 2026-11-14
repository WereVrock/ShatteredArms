// Pure helpers for the walk / run gaits. No state.
//
// Walking: every soldier moves at walkSpeed() (design space).
// Running: effectiveMoveSpeed * runSpeedMult(type).
// Routers, shattered soldiers and thralls keep their previous pace (x1.0),
// so rout behaviour is unchanged.
//
// The multiplier from speedMult() is folded into soldier.terrainSpeedMult by
// MovementSystem._applyTerrain, so surfaceMoveSpeed, actualMoveSpeed and the
// march anchor all see it without further changes.
import { CombatConfig } from '../config/CombatConfig.js';
import { RunConfig } from '../config/RunConfig.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { isMounted } from '../config/UnitClasses.js';

let _walkSpeed = null;

function walkSpeed() {
  if (_walkSpeed !== null) return _walkSpeed;
  if (typeof RunConfig.walkSpeed === 'number') {
    _walkSpeed = RunConfig.walkSpeed;
  } else {
    const sp = UnitTypes.spearman;
    _walkSpeed = sp.baseMoveSpeed *
      (sp.hasShield ? CombatConfig.shield.moveSpeedMult : 1) *
      CombatConfig.spearHandling.moveSpeedMult;
  }
  return _walkSpeed;
}

export const Gait = {
  walkSpeed,

  // Can a unit of this type (and undead flag) run at all?
  typeCanRun(typeDef, isUndead) {
    if (!typeDef) return false;
    if (isUndead && !(RunConfig.undeadMountedCanRun && isMounted(typeDef))) return false;
    return true;
  },

  unitCanRun(unit) {
    const typeDef = unit.soldiers[0]?.unitTypeDef;
    // Crew-served units walk as one body (the carriers set the pace) unless
    // the shooters are released from their carriers. See CrewPairing.
    if (typeDef && typeDef.crew && !unit.crewDontWaitActive) return false;
    // Chargob units walk with their beasts until the beasts are abandoned.
    if (typeDef && typeDef.chargob && !unit.chargobAbandoned) return false;
    return Gait.typeCanRun(typeDef, unit.isUndead);
  },

  soldierCanRun(soldier) {
    if (soldier.isThrall) return false;
    // Carriers lug the weapon and never run.
    if (soldier.crewRole === 'carrier') return false;
    if (soldier.unitTypeDef.chargobBeast === true) return false;
    return Gait.typeCanRun(soldier.unitTypeDef, soldier.isUndead);
  },

  runSpeedMult(typeDef) {
    if (typeDef && typeof typeDef.runSpeedMult === 'number') return typeDef.runSpeedMult;
    return isMounted(typeDef) ? RunConfig.mountedRunMult : RunConfig.infantryRunMult;
  },

  runDrainMult(soldier) {
    return isMounted(soldier.unitTypeDef)
      ? RunConfig.drainMultMounted
      : RunConfig.drainMultInfantry;
  },

  // Multiplier applied on top of the terrain surface multiplier.
  speedMult(soldier) {
    if (soldier.isThrall) return 1;
    // A charging chargob beast runs at its full run speed.
    // A chargob beast runs only while charging; in every other state it
    // walks, whatever the unit's gait says.
    if (soldier.unitTypeDef.chargobBeast === true) {
      if (soldier.state === 'routing' || soldier.state === 'shattered') return 1;
      if (soldier.chargeActive === true) return Gait.runSpeedMult(soldier.unitTypeDef);
      const effBeast = soldier.effectiveMoveSpeed;
      return effBeast > 0 ? walkSpeed() / effBeast : 1;
    }
    if (soldier.state === 'routing' || soldier.state === 'shattered') return 1;
    // Unleashed and wild hounds never walk.
    if (soldier.houndMode === 'attacking' || soldier.houndMode === 'rogue') {
      return Gait.runSpeedMult(soldier.unitTypeDef);
    }
    if (soldier.gaitRunning) return Gait.runSpeedMult(soldier.unitTypeDef);
    const eff = soldier.effectiveMoveSpeed;
    return eff > 0 ? walkSpeed() / eff : 1;
  },

  // Design-space speed (no terrain) a soldier would move at in the given gait.
  // For AI estimates: pass running = true for a pessimistic read of what a
  // soldier is capable of.
  designSpeed(soldier, running) {
    const eff = soldier.effectiveMoveSpeed;
    if (running && Gait.soldierCanRun(soldier)) {
      return eff * Gait.runSpeedMult(soldier.unitTypeDef);
    }
    return walkSpeed();
  },

  // Spears must stay raised while running and for spearLowerDelayTicks after.
  // Consumed by the spear handling code.
  spearsHeldUp(soldier) {
    return !!soldier.gaitRunning || (soldier.gaitHoldTicks | 0) > 0;
  }
};
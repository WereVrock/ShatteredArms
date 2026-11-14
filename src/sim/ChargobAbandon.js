import { CombatConfig } from '../config/CombatConfig.js';

// "Abandon chargob beasts" (player button). One-way: the beasts leave the
// player's control. Right away they only stand still. A beast that has no
// living handler within abandonRange is orphaned (latched, beast.beastOrphaned):
// it behaves as if every handler were dead, which ChargobSystem turns into the
// wild-charge rule with 0 handlers. Handlers may run after the abandon (see
// Gait.unitCanRun) and fight freely (unit.chargobHold is off).

export const ChargobAbandon = {
  // True while the unit still has a beast to abandon.
  canAbandon(unit) {
    if (unit.companionKind !== 'chargob' || unit.chargobAbandoned || unit.leavingBattle) return false;
    const companions = unit.companions;
    for (let i = 0; i < companions.length; i++) {
      const c = companions[i];
      if (c.isAlive() && c.state !== 'routing' && c.state !== 'shattered') return true;
    }
    return false;
  },

  abandon(unit) {
    if (!ChargobAbandon.canAbandon(unit)) return false;
    unit.chargobAbandoned = true;
    unit.chargobWanted = 0;
    unit._pokeJobs = [];
    unit._herdTasks = [];
    unit._beastTurn = null;
    unit.chargobHold = false;
    for (let i = 0; i < unit.soldiers.length; i++) unit.soldiers[i].herdAnchorId = null;
    return true;
  },

  // True when no living handler is within abandonRange of the beast.
  isFarFromHandlers(unit, beast) {
    const r = CombatConfig.chargob.abandonRange;
    const r2 = r * r;
    const soldiers = unit.soldiers;
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s.isAlive()) continue;
      const dx = s.pos.x - beast.pos.x;
      const dz = s.pos.z - beast.pos.z;
      if (dx * dx + dz * dz <= r2) return false;
    }
    return true;
  }
};
import { CombatConfig } from '../config/CombatConfig.js';

// Orderly withdrawal of a whole unit ("leave battle"), available to every
// unit. Every living soldier becomes 'shattered' (cannot rally, walks to the
// map edge, gets extracted by RoutingExtractionSystem and recorded for the
// campaign like any escapee, so the unit returns for the next battle).
// isRouting is left alone on purpose: MoraleSystem skips shattered soldiers
// entirely, and an orderly withdrawal must not spread rout panic.
//
// Each soldier is flagged `withdrawing`: MovementSystem lets them move
// faster than a rout, and RoutingExtractionSystem records them as withdrawn
// (the campaign does not drop a withdrawn unit for being small).
//
// The exit is the NEAREST map edge from the unit's centre; all soldiers of
// the unit share that direction.

function nearestEdgeDirection(center) {
  const b = CombatConfig.mapBounds;
  const dMinX = center.x - b.minX;
  const dMaxX = b.maxX - center.x;
  const dMinZ = center.z - b.minZ;
  const dMaxZ = b.maxZ - center.z;
  const m = Math.min(dMinX, dMaxX, dMinZ, dMaxZ);
  if (m === dMinX) return { x: -1, z: 0 };
  if (m === dMaxX) return { x: 1, z: 0 };
  if (m === dMinZ) return { x: 0, z: -1 };
  return { x: 0, z: 1 };
}

export const BattleWithdrawal = {
  // Returns true when the withdrawal started.
  withdraw(unit) {
    if (unit.leavingBattle) return false;
    const alive = unit.getAliveSoldiers();
    if (alive.length === 0) return false;

    const dir = nearestEdgeDirection(unit.getCenter());
    unit.leavingBattle = true;

    unit.hasActiveOrder = false;
    unit.orderTarget = null;
    unit._marchDestination = null;
    unit.focusTargetUnitId = null;
    unit.aiFocusTargetUnitId = null;
    unit._fleeDirection = { x: dir.x, z: dir.z };

    for (let i = 0; i < alive.length; i++) {
      const s = alive[i];
      s.state = 'shattered';
      s.withdrawing = true;
      s.targetId = null;
      s.contactTargetId = null;
      s.fleeDirection = { x: dir.x, z: dir.z };
    }
    // The hounds leave with their handlers.
    for (const h of unit.companions) {
      if (!h.isAlive()) continue;
      h.state = 'shattered';
      h.withdrawing = true;
      h.targetId = null;
      h.contactTargetId = null;
      h.fleeDirection = { x: dir.x, z: dir.z };
    }
    return true;
  }
};
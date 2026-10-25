import { CombatConfig } from '../config/CombatConfig.js';

// Holds every non-fleeing soldier inside CombatConfig.mapBounds. This is
// what makes the yellow border strip a real rule rather than decoration:
// no marching, charging, engaged, or thrown soldier can step outside it.
//
// Runs LAST in BattleSimulation.tick(), after CollisionSystem and
// CombatResolutionSystem — both of those can nudge positions (collision
// push, non-charge mass shove, brace knockback). Clamping after them
// means the final position every soldier occupies at end of tick is
// inside the box (or deliberately outside it, for routers).
//
// Routing and shattered soldiers are exempt by design: they must be able
// to leave the field so RoutingExtractionSystem.update() can record their
// escape and set their state to 'extracted'. Dead and extracted soldiers
// are skipped too (dead bodies can lie anywhere; extracted soldiers are
// already off the map and Soldier.isAlive() is already false for them).
//
// Clamps position only. Does NOT zero currentSpeed, knockbackVel, or
// touch movedThisTick — a soldier pinned against the boundary who was
// mid-step still reads as having moved this tick, which is correct:
// they tried, the map edge stopped them, and FacingSystem should still
// turn them toward the direction they were pushing.
export class BoundsSystem {
update(allSoldiers) {
const b = CombatConfig.mapBounds;
for (const s of allSoldiers) {
if (!s.isAlive()) continue;
if (s.state === 'routing' || s.state === 'shattered') continue;

if (s.pos.x < b.minX) s.pos.x = b.minX;
else if (s.pos.x > b.maxX) s.pos.x = b.maxX;

if (s.pos.z < b.minZ) s.pos.z = b.minZ;
else if (s.pos.z > b.maxZ) s.pos.z = b.maxZ;
}
}
}
// ===== ContactAttackSystem.js =====
// Detects melee contacts for soldiers under an active movement order.
//
// A soldier marching or charging toward a destination who physically
// walks into an enemy attacks them WITHOUT stopping, without leaving
// its ordered path, and without entering the 'engaged' state. The swing
// is a passing attack: one tick of combat resolution against the
// contact, then the soldier continues its order.
//
// Behaviour:
//   - Soldier must be in 'marching' or 'impetuous' state. Idle,
//     engaged, staggered, routing, shattered, and knocked-down soldiers
//     are not affected.
//   - Enemy must be within CombatConfig.engagementRange — the same
//     radius the sim already uses to decide when a soldier is
//     'engaged', so "in contact" means the same thing in both places.
//   - Enemy must be inside the soldier's FORWARD ARC, measured against
//     moveFacing (where the soldier is walking, not where its body
//     happens to point mid-turn). Arc half-width is
//     CombatConfig.passingAttack.forwardArcDeg.
//
// When more than one enemy qualifies, the NEAREST wins — the soldier
// swings at whoever is actually in its path. If contact is broken
// (enemy dies, moves out of range, or slides out of the forward arc)
// the contact is cleared and the soldier resumes pure movement toward
// its order.
//
// The contact is exposed as soldier.contactTargetId, which
// CombatResolutionSystem reads as the defender for that soldier's
// attack this tick. A per-contact contactChargeBonusSpent flag lets
// the FIRST swing on a fresh contact use the charge rules (bonus
// damage, throw, knockdown) and every subsequent swing fall back to
// normal melee, so a cavalryman sweeping through a formation lands one
// momentum hit per enemy rather than re-throwing the same man every
// tick.
//
// Runs after MovementSystem and CollisionSystem (so all position
// changes — voluntary movement, collision push, thrown-soldier
// integration — are already applied) and before
// CombatResolutionSystem, which reads the contact set here.
//
// Does NOT move the soldier. A passing attack is a passive read of
// what is already inside melee reach; the soldier makes no extra step
// toward the contact and resumes its ordered path the moment contact
// is lost.
import { CombatConfig } from '../config/CombatConfig.js';

export class ContactAttackSystem {
  constructor(spatialGrid) {
    this.spatialGrid = spatialGrid;
  }

  update(allSoldiers) {
    const cfg = CombatConfig.passingAttack;
    const rangeSq = CombatConfig.engagementRange * CombatConfig.engagementRange;
    const arcRad = cfg.forwardArcDeg * Math.PI / 180;

    for (const soldier of allSoldiers) {
      if (!soldier.isAlive()) continue;

      // Only marching and impetuous soldiers make passing attacks.
      // Anyone else has their contact cleared so a soldier who
      // transitioned into engaged / routing / etc. does not carry a
      // stale contact into the next tick.
      if (soldier.state !== 'marching' && soldier.state !== 'impetuous') {
        if (soldier.contactTargetId !== null) {
          soldier.contactTargetId = null;
          soldier.contactChargeBonusSpent = false;
        }
        continue;
      }

      const nearby = this.spatialGrid.queryNearby(
        soldier.pos.x, soldier.pos.z, 1
      );
      const moveFacing = soldier.moveFacing;

      let bestId = null;
      let bestDistSq = Infinity;

      for (const other of nearby) {
        if (other === soldier) continue;
        if (other.teamId === soldier.teamId) continue;
        if (!other.isAlive()) continue;

        const dx = other.pos.x - soldier.pos.x;
        const dz = other.pos.z - soldier.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq > rangeSq) continue;
        if (dSq >= bestDistSq) continue;

        // Forward-arc gate against moveFacing — the walk direction,
        // not the soldier's physical facing. A soldier mid-turn has
        // not yet looked where it is going, but it IS going there,
        // and the swing should track the ordered direction, not the
        // lagging body.
        const toEnemy = Math.atan2(dx, dz);
        let diff = toEnemy - moveFacing;
        diff = ((diff + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        if (Math.abs(diff) > arcRad) continue;

        bestDistSq = dSq;
        bestId = other.id;
      }

      // Contact-change detection. A new contact — including the
      // transition from no-contact to contact, and any switch from one
      // enemy to another — resets the charge-bonus-spent flag so the
      // first swing on the fresh contact can charge. Staying in
      // contact with the same enemy preserves the flag.
      if (bestId !== soldier.contactTargetId) {
        soldier.contactTargetId = bestId;
        soldier.contactChargeBonusSpent = false;
      }
    }
  }
}
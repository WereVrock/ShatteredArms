import { CombatConfig } from '../config/CombatConfig.js';

// Physical collision between soldiers. Runs after MovementSystem so that any
// voluntary movement has already been applied; the collision pass then pushes
// overlapping pairs apart.
//
// Uses the shared SpatialGrid. Cell size is 2.0, query radius 1 cell covers
// ±2 world units of neighbourhood — more than enough for a 0.5 separation
// threshold, and cheap.
//
// Push is split by inverse mass: two colliding soldiers each take a share of
// the correction proportional to the OTHER's mass over the total. A cavalry
// man (mass 4.5) hitting an archer (0.9) shoves the archer 83% of the overlap
// and barely moves itself.
//
// Knocked-down soldiers are skipped — they are on the ground and don't shove
// or get shoved. Dead soldiers are excluded (isAlive() check).
//
// Does NOT set movedThisTick on the pushed soldiers: being shoved is not
// voluntary movement, so FacingSystem won't turn them to face the shove
// direction, and a braced spearman stays braced while being pressed.
export class CollisionSystem {
  constructor(spatialGrid) {
    this.spatialGrid = spatialGrid;
  }

update(allSoldiers) {
    // Default radius for any unit type that doesn't declare collisionRadius.
    // Two default soldiers therefore still separate at exactly minSeparation.
    const defaultRadius = CombatConfig.collision.minSeparation / 2;

    for (const a of allSoldiers) {
      if (!a.isAlive()) continue;
      if (a.state === 'knockedDown') continue;

      const radiusA = a.unitTypeDef.collisionRadius ?? defaultRadius;
      const nearby = this.spatialGrid.queryNearby(a.pos.x, a.pos.z, 1);

      for (const b of nearby) {
        if (b === a) continue;
        if (!b.isAlive()) continue;
        if (b.state === 'knockedDown') continue;
        // Process each pair once. Lower id wins the tie so the outer loop
        // owns the pair and the inner loop skips it.
        if (a.id > b.id) continue;

        // Pair separation is the sum of both radii, so a horseman shoves
        // further out than a footman without changing infantry-vs-infantry.
        const radiusB = b.unitTypeDef.collisionRadius ?? defaultRadius;
        const minSep = radiusA + radiusB;
        const minSepSq = minSep * minSep;

        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq >= minSepSq) continue;

        // Extremely rare co-location — nudge them apart along +X.
        if (dSq < 0.0001) {
          a.pos.x -= 0.01;
          b.pos.x += 0.01;
          continue;
        }

        const d = Math.sqrt(dSq);
        const overlap = minSep - d;
        const nx = dx / d;
        const nz = dz / d;

        const massA = a.effectiveMass;
        const massB = b.effectiveMass;
        const totalMass = massA + massB;

        // Each soldier is pushed by the OTHER's mass share. Heavy attacker
        // pushes light defender far; light attacker barely moves heavy one.
        const pushA = overlap * (massB / totalMass);
        const pushB = overlap * (massA / totalMass);

        a.pos.x -= nx * pushA;
        a.pos.z -= nz * pushA;
        b.pos.x += nx * pushB;
        b.pos.z += nz * pushB;
      }
    }
  }
}
// A rectangular deployment area for one team, expressed in world space but
// with a local (lateral, depth) coordinate frame aligned to the battle line:
//
//   forward : unit vector from the team's spawn mean toward the enemy mean
//   right   : perpendicular to forward (fwdZ, -fwdX), matching
//             BattleLineFormation.getLineAxis's convention
//
// lateral : signed offset along `right`
// depth   : signed offset along `forward` (positive = toward the enemy)
//
// Depth is ASYMMETRIC. frontDepth is the extent on the +forward side;
// backDepth is the extent on the -forward side. A zone can therefore extend
// much further behind the team's mean position than in front of it, which
// is what gives the player rear maneuvering room without pushing the
// formation's front edge closer to the enemy.
//
// The zone owns the conversions the rest of the deployment system needs:
// toWorld(lateral, depth) and toLocal(x, z). Also provides contains() and
// toWorldClamped() so player-unit placement and template layouts both stay
// inside the rectangle without duplicating the projection math.
export class DeploymentZone {
  constructor({ centerX, centerZ, halfLateral, frontDepth, backDepth, rightX, rightZ, forwardX, forwardZ }) {
    this.centerX = centerX;
    this.centerZ = centerZ;
    this.halfLateral = halfLateral;
    this.frontDepth = frontDepth;
    this.backDepth = backDepth;
    this.rightX = rightX;
    this.rightZ = rightZ;
    this.forwardX = forwardX;
    this.forwardZ = forwardZ;
  }

  toWorld(lateral, depth) {
    return {
      x: this.centerX + this.rightX * lateral + this.forwardX * depth,
      z: this.centerZ + this.rightZ * lateral + this.forwardZ * depth
    };
  }

  toLocal(x, z) {
    const dx = x - this.centerX;
    const dz = z - this.centerZ;
    return {
      lateral: dx * this.rightX + dz * this.rightZ,
      depth: dx * this.forwardX + dz * this.forwardZ
    };
  }

  contains(x, z) {
    const { lateral, depth } = this.toLocal(x, z);
    return Math.abs(lateral) <= this.halfLateral &&
           depth >= -this.backDepth &&
           depth <= this.frontDepth;
  }

  // Returns the world position of (lateral, depth) after clamping both
  // coordinates into the rectangle. Used by template layout so a row that
  // would overflow the zone is pulled back to the edge rather than placed
  // outside it.
  toWorldClamped(lateral, depth) {
    const cl = Math.max(-this.halfLateral, Math.min(this.halfLateral, lateral));
    const cd = Math.max(-this.backDepth, Math.min(this.frontDepth, depth));
    return this.toWorld(cl, cd);
  }

  // World-space corners, ordered back-left, back-right, front-right,
  // front-left. Consumed by DeploymentZoneView to build the ground quad.
  getCornersWorld() {
    return [
      this.toWorld(-this.halfLateral, -this.backDepth),
      this.toWorld(this.halfLateral, -this.backDepth),
      this.toWorld(this.halfLateral, this.frontDepth),
      this.toWorld(-this.halfLateral, this.frontDepth)
    ];
  }
}
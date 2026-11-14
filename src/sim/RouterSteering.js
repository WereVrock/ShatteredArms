// Keeps routing soldiers from running into lakes, walls and rock fields.
//
// A router flees along its unit's shared flee direction. Every REEVAL ticks
// (staggered by id) it probes ahead against the nav clearance grid (O(1) per
// probe) and picks the first open heading from a fan of angles, remembering
// the choice in soldier.fleeSteer. Each soldier prefers one side
// (fleeSteerSign) so a unit does not flip-flop at a wall.
// No allocation: the caller's target object is edited in place.

const ANGLES = [0, 0.61, 1.22, 1.9];
const PROBE_NEAR = 2.5;
const PROBE_FAR = 5.0;
const MIN_CLEARANCE = 0.35;
const REEVAL = 4;

export class RouterSteering {
  apply(soldier, targetPos, terrain, tick, lookahead) {
    const fx = soldier.fleeDirection.x;
    const fz = soldier.fleeDirection.z;
    const px = soldier.pos.x;
    const pz = soldier.pos.z;

    if (((tick + soldier.id) % REEVAL) === 0) {
      soldier.fleeSteer = this._choose(soldier, terrain, px, pz, fx, fz);
    }
    const a = soldier.fleeSteer;
    if (a === 0) return;

    const c = Math.cos(a), s = Math.sin(a);
    targetPos.x = px + (fx * c - fz * s) * lookahead;
    targetPos.z = pz + (fx * s + fz * c) * lookahead;
  }

  _choose(soldier, terrain, px, pz, fx, fz) {
    const sign = soldier.fleeSteerSign;
    for (let k = 0; k < ANGLES.length; k++) {
      for (let q = 0; q < 2; q++) {
        if (k === 0 && q === 1) break;
        const ang = ANGLES[k] * (q === 0 ? sign : -sign);
        const c = Math.cos(ang), s = Math.sin(ang);
        const dx = fx * c - fz * s;
        const dz = fx * s + fz * c;
        if (terrain.navClearanceAt(px + dx * PROBE_NEAR, pz + dz * PROBE_NEAR) >= MIN_CLEARANCE &&
            terrain.navClearanceAt(px + dx * PROBE_FAR, pz + dz * PROBE_FAR) >= MIN_CLEARANCE) {
          return ang;
        }
      }
    }
    // Boxed in: slide sideways along whatever is in the way.
    return 1.57 * sign;
  }
}
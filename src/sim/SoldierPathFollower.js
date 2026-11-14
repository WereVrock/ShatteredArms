// Per-soldier waypoint steering for the double-click "direct march".
//
// The unit holds ONE path (Unit._directPath). Each soldier keeps its own
// progress index into it, so soldiers ignore the formation but still route
// around obstacles. The last path point is the destination anchor: reaching
// it hands the soldier over to its formation slot.
//
// Cheap by design: no allocation, and the line-of-sight shortcut only runs
// every LOS_INTERVAL ticks per soldier, staggered by soldier id.

const WAYPOINT_REACH_SQ = 3.0 * 3.0;
const LOS_INTERVAL = 8;
const SOLDIER_CLEARANCE = 0.5;
// Line-of-sight shortcuts are only tested over this distance (squared).
// Far soldiers just follow the A* waypoints, which already encode the
// cost-aware route. This bounds the sample count per LOS test.
const LOS_MAX_DIST_SQ = 150 * 150;

export class SoldierPathFollower {
  // Returns the point the soldier should walk toward this tick: a waypoint
  // object, or soldier.formationSlot itself once the route is clear.
steer(soldier, unit, terrain, tick) {
    const path = unit._directPath;
    const slot = soldier.formationSlot;
    const n = path.length;
    if (n < 2) return slot;

    if (soldier.pathStamp !== unit._directPathStamp) {
      soldier.pathStamp = unit._directPathStamp;
      soldier.pathIdx = 0;
    }

    const px = soldier.pos.x;
    const pz = soldier.pos.z;
    let idx = soldier.pathIdx;

    while (idx < n - 1) {
      const w = path[idx];
      const dx = w.x - px, dz = w.z - pz;
      if (dx * dx + dz * dz <= WAYPOINT_REACH_SQ) idx++;
      else break;
    }

    if (idx < n - 1 && ((tick + soldier.id) % LOS_INTERVAL) === 0) {
      const mounted = soldier.isMountedType;
      const sdx = slot.x - px, sdz = slot.z - pz;
      if (sdx * sdx + sdz * sdz <= LOS_MAX_DIST_SQ &&
          terrain.lineClear(px, pz, slot.x, slot.z, SOLDIER_CLEARANCE, mounted)) {
        idx = n - 1;
      } else if (idx + 1 < n - 1) {
        const nx = path[idx + 1];
        const ndx = nx.x - px, ndz = nx.z - pz;
        if (ndx * ndx + ndz * ndz <= LOS_MAX_DIST_SQ &&
            terrain.lineClear(px, pz, nx.x, nx.z, SOLDIER_CLEARANCE, mounted)) {
          idx++;
        }
      }
    }

    soldier.pathIdx = idx;
    return idx >= n - 1 ? slot : path[idx];
  }
}
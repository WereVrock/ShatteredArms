// Unit-level path for the double-click direct march. Kept out of Unit.js.
// Soldiers walk it individually through SoldierPathFollower.

// Soldiers move individually, so the path only needs single-soldier clearance.
const DIRECT_CLEARANCE = 0.6;

let stampCounter = 0;

export const UnitDirectMarch = {
  // Computes the path once per order. No-op without terrain or when a path exists.
  ensurePath(unit, target, terrain) {
    if (!terrain || unit._directPath !== null) return;
    const c = unit.getCenter();
    const res = terrain.findPath(c.x, c.z, target.x, target.z, {
      clearance: DIRECT_CLEARANCE,
      mounted: unit._isMountedUnit()
    });
    unit._directPath = (res.points && res.points.length)
      ? res.points
      : [{ x: target.x, z: target.z }];
    unit._directPathStamp = ++stampCounter;
  }
};
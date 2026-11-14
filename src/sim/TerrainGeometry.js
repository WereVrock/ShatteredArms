import { ObstacleKind } from '../config/TerrainConfig.js';

const _cp = { x: 0, z: 0 };

// Writes the closest point on segment (x1,z1)-(x2,z2) to `out`; returns t in [0,1].
export function closestOnSegment(px, pz, x1, z1, x2, z2, out) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - x1) * dx + (pz - z1) * dz) / l2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  out.x = x1 + dx * t;
  out.z = z1 + dz * t;
  return t;
}

// Distance from a point to an obstacle's surface (negative = inside).
export function obstacleSignedDistance(o, x, z) {
  if (o.kind === ObstacleKind.WALL) {
    closestOnSegment(x, z, o.x1, o.z1, o.x2, o.z2, _cp);
    return Math.hypot(x - _cp.x, z - _cp.z) - o.thickness * 0.5;
  }
  return Math.hypot(x - o.x, z - o.z) - o.r;
}
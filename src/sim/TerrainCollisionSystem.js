import { ObstacleKind, TerrainConfig } from '../config/TerrainConfig.js';
import { closestOnSegment } from './TerrainGeometry.js';

// Hard terrain constraints: pushes soldiers out of trees/rocks/walls and
// keeps them out of blocked cells (deep water). Runs after CollisionSystem
// (so soldier-vs-soldier shoves cannot push anyone into a rock) and again
// right before BoundsSystem.
//
// Routing soldiers are NOT exempt: a router slides along obstacles instead
// of running through them. Position only; speed/flags are untouched.
export class TerrainCollisionSystem {
  constructor(terrain = null) {
    this.terrain = terrain;
    this._buf = [];
    this._cp = { x: 0, z: 0 };
  }

  update(allSoldiers) {
    const t = this.terrain;
    if (!t) return;
    const buf = this._buf;
    const hasBlocked = t.hasBlockedCells;
    const hasObstacles = t.obstacles.length > 0;
    if (!hasBlocked && !hasObstacles) return;

    for (let i = 0; i < allSoldiers.length; i++) {
      const s = allSoldiers[i];
      if (!s.isAlive()) continue;

      if (hasObstacles) {
        const radius = s.unitTypeDef.collisionRadius ?? TerrainConfig.defaultSoldierRadius;
        t.queryObstacles(s.pos.x, s.pos.z, radius, buf);
        if (buf.length > 0) {
          for (let pass = 0; pass < 2; pass++) {
            let moved = false;
            for (let k = 0; k < buf.length; k++) {
              if (this._pushOut(s, buf[k], radius)) moved = true;
            }
            if (!moved) break;
          }
        }
      }

      if (hasBlocked) this._resolveBlocked(s, t);
    }
  }

  _pushOut(s, o, radius) {
    let cx, cz, minD;
    if (o.kind === ObstacleKind.WALL) {
      closestOnSegment(s.pos.x, s.pos.z, o.x1, o.z1, o.x2, o.z2, this._cp);
      cx = this._cp.x; cz = this._cp.z;
      minD = o.thickness * 0.5 + radius;
    } else {
      cx = o.x; cz = o.z;
      minD = o.r + radius;
    }
    const dx = s.pos.x - cx;
    const dz = s.pos.z - cz;
    const dSq = dx * dx + dz * dz;
    if (dSq >= minD * minD) return false;

    if (dSq < 1e-8) {
      // Exactly on the centre line: push along the wall normal (or +x).
      let nx = 1, nz = 0;
      if (o.kind === ObstacleKind.WALL) {
        const wx = o.x2 - o.x1, wz = o.z2 - o.z1;
        const wl = Math.hypot(wx, wz) || 1;
        nx = -wz / wl; nz = wx / wl;
      }
      s.pos.x = cx + nx * minD;
      s.pos.z = cz + nz * minD;
      return true;
    }
    const d = Math.sqrt(dSq);
    s.pos.x = cx + (dx / d) * minD;
    s.pos.z = cz + (dz / d) * minD;
    return true;
  }

  // Blocked terrain cells (deep water): revert to the last safe position,
  // sliding along one axis when possible.
  _resolveBlocked(s, t) {
    const x = s.pos.x, z = s.pos.z;
    if (!t.isBlocked(x, z)) {
      s.terrainSafeX = x;
      s.terrainSafeZ = z;
      return;
    }
    const px = s.terrainSafeX, pz = s.terrainSafeZ;
    if (!t.isBlocked(px, z)) s.pos.x = px;
    else if (!t.isBlocked(x, pz)) s.pos.z = pz;
    else { s.pos.x = px; s.pos.z = pz; }
  }
}
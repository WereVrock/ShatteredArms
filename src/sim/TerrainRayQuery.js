import { ObstacleKind, TerrainConfig } from '../config/TerrainConfig.js';
import { closestOnSegment } from './TerrainGeometry.js';

export const HitKind = Object.freeze({ GROUND: 'ground', TREE: 'tree', ROCK: 'rock', WALL: 'wall' });

// Ground picking (mouse -> world) steps this far, then bisects.
const PICK_STEP = 1.0;
const PICK_REFINE = 8;
// Projectile segments are sampled this finely (arrows move ~0.6 units/tick).
const PROJECTILE_STEP = 0.4;
const ARROW_RADIUS = 0.08;

// 3D queries against the heightfield and the obstacles. Allocation-free:
// results are written into caller-supplied `out` objects.
//
//   groundPick   - ray vs heightfield. For mouse orders and selection.
//   segmentHit   - one projectile step vs ground, trunks, rocks and walls.
//   lineOfSight  - true when nothing blocks the segment.
export class TerrainRayQuery {
  constructor(terrain) {
    this.terrain = terrain;
    this._buf = [];
    this._cp = { x: 0, z: 0 };
    this._scratch = { x: 0, y: 0, z: 0, kind: null, obstacle: null };
  }

  // out: { x, y, z }. Returns false when the ray misses within maxDist.
  groundPick(ox, oy, oz, dx, dy, dz, maxDist, out) {
    const t = this.terrain;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return false;
    dx /= len; dy /= len; dz /= len;

    if (!t.hasElevation) {
      if (dy >= -1e-9) return false;
      const s = -oy / dy;
      if (s < 0 || s > maxDist) return false;
      out.x = ox + dx * s; out.y = 0; out.z = oz + dz * s;
      return true;
    }

    let prevS = 0;
    for (let s = PICK_STEP; s <= maxDist; s += PICK_STEP) {
      const x = ox + dx * s, y = oy + dy * s, z = oz + dz * s;
      if (y <= t.heightAt(x, z)) {
        let lo = prevS, hi = s;
        for (let k = 0; k < PICK_REFINE; k++) {
          const mid = (lo + hi) * 0.5;
          if (oy + dy * mid > t.heightAt(ox + dx * mid, oz + dz * mid)) lo = mid; else hi = mid;
        }
        out.x = ox + dx * hi;
        out.z = oz + dz * hi;
        out.y = t.heightAt(out.x, out.z);
        return true;
      }
      prevS = s;
    }
    return false;
  }

  // out: { x, y, z, kind, obstacle }. Returns true on a hit.
  segmentHit(ax, ay, az, bx, by, bz, out) {
    const t = this.terrain;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const n = Math.max(1, Math.ceil(len / PROJECTILE_STEP));

    let cands = null;
    if (t.obstacles.length > 0) {
      t.queryObstacles((ax + bx) * 0.5, (az + bz) * 0.5, len * 0.5 + 1, this._buf);
      if (this._buf.length > 0) cands = this._buf;
    }
    const elevated = t.hasElevation;

    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const x = ax + dx * f, y = ay + dy * f, z = az + dz * f;

      if (elevated && y < t.heightAt(x, z)) {
        out.x = x; out.y = y; out.z = z; out.kind = HitKind.GROUND; out.obstacle = null;
        return true;
      }
      if (cands !== null) {
        for (let i = 0; i < cands.length; i++) {
          const kind = this._obstacleHit(cands[i], x, y, z);
          if (kind !== null) {
            out.x = x; out.y = y; out.z = z; out.kind = kind; out.obstacle = cands[i];
            return true;
          }
        }
      }
    }
    return false;
  }

  lineOfSight(ax, ay, az, bx, by, bz) {
    return !this.segmentHit(ax, ay, az, bx, by, bz, this._scratch);
  }

_obstacleHit(o, x, y, z) {
    const t = this.terrain;
    if (o.kind === ObstacleKind.WALL) {
      closestOnSegment(x, z, o.x1, o.z1, o.x2, o.z2, this._cp);
      const dx = x - this._cp.x, dz = z - this._cp.z;
      const reach = o.thickness * 0.5 + ARROW_RADIUS;
      if (dx * dx + dz * dz > reach * reach) return null;
      return y <= t.heightAt(this._cp.x, this._cp.z) + o.height ? HitKind.WALL : null;
    }
    const dx = x - o.x, dz = z - o.z;
    const d2 = dx * dx + dz * dz;
    const gh = t.heightAt(o.x, o.z);
    if (o.kind === ObstacleKind.TREE) {
      // Only the trunk stops arrows; they pass through foliage.
      const reach = o.r + ARROW_RADIUS;
      if (d2 > reach * reach) return null;
      return (y >= gh && y <= gh + TerrainConfig.tree.trunkHeight * o.scale) ? HitKind.TREE : null;
    }
    if (o.kind === ObstacleKind.PALM) {
      const reach = o.r + ARROW_RADIUS;
      if (d2 > reach * reach) return null;
      return (y >= gh && y <= gh + TerrainConfig.palm.trunkHeight * o.scale) ? HitKind.TREE : null;
    }
    if (o.kind === ObstacleKind.COLUMN) {
      const reach = o.r + ARROW_RADIUS;
      if (d2 > reach * reach) return null;
      return (y >= gh && y <= gh + o.height) ? HitKind.WALL : null;
    }
    if (o.kind === ObstacleKind.CACTUS) {
      const reach = o.r + ARROW_RADIUS;
      if (d2 > reach * reach) return null;
      return (y >= gh && y <= gh + TerrainConfig.cactus.height * o.scale) ? HitKind.TREE : null;
    }
    if (o.kind === ObstacleKind.RUIN) {
      const reach = o.r + ARROW_RADIUS;
      if (d2 > reach * reach) return null;
      return (y >= gh && y <= gh + o.height) ? HitKind.ROCK : null;
    }
    if (o.kind === ObstacleKind.SCENERY) {
      const reach = o.r + ARROW_RADIUS;
      if (d2 > reach * reach) return null;
      return (y >= gh && y <= gh + o.height) ? HitKind.ROCK : null;
    }
    // BUSH is deliberately low; arrows pass over it.
    if (d2 > o.r * o.r) return null;
    return y <= gh + o.r * TerrainConfig.rock.heightFactor ? HitKind.ROCK : null;
  }
}
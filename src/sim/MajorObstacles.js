import { ObstacleKind } from '../config/TerrainConfig.js';
import { obstacleSignedDistance } from './TerrainGeometry.js';

// What counts as a real blocker for formations and unit-level pathing.
// Walls, big rocks, blocked terrain (deep water) and the map edge shape routes
// and slots. Trees, bushes, cacti, palms, columns and small rocks do not:
// soldiers flow around those individually (SlotSteering + terrain collision),
// so a forest never forces a detour or a squeezed column.

export const BIG_ROCK_RADIUS = 0.9;

const _buf = [];

export function isMajorObstacle(o) {
  if (o.kind === ObstacleKind.WALL) return true;
  return o.kind === ObstacleKind.ROCK && o.r >= BIG_ROCK_RADIUS;
}

// True when a soldier-sized body at (x, z) with `clearance` would be inside
// the map edge, blocked terrain, a wall or a big rock.
export function isSolidAt(terrain, x, z, clearance) {
  if (terrain.cellIndexAt(x, z) < 0) return true;
  if (terrain.isBlocked(x, z)) return true;
  if (terrain.obstacles.length === 0) return false;
  terrain.queryObstacles(x, z, clearance, _buf);
  for (let i = 0; i < _buf.length; i++) {
    const o = _buf[i];
    if (!isMajorObstacle(o)) continue;
    if (obstacleSignedDistance(o, x, z) < clearance) return true;
  }
  return false;
}
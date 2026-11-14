import { TerrainConfig } from '../config/TerrainConfig.js';
import { obstacleSignedDistance } from './TerrainGeometry.js';

// Puts units on valid ground AFTER the terrain exists (nothing is cleared
// for them). A soldier is blocked when he stands in a blocked cell (deep
// water), inside a tree, rock or wall, or outside the map.
//
// settleUnit, in order:
//   1. Nothing blocked -> untouched.
//   2. Shift the WHOLE formation (soldiers, slots, anchors) to the nearest
//      offset where every soldier is free. Shape and facing are kept.
//   3. Still blocked soldiers (no such offset within maxShift) are nudged
//      individually to the nearest free spot.
// Deterministic, so multiplayer peers settle identically.

const _buf = [];

function radiusOf(soldier) {
  return soldier.unitTypeDef.collisionRadius ?? TerrainConfig.defaultSoldierRadius;
}

function isFree(terrain, x, z, radius) {
  if (terrain.cellIndexAt(x, z) < 0) return false;
  if (terrain.isBlocked(x, z)) return false;
  if (terrain.obstacles.length === 0) return true;
  const clearance = radius + TerrainConfig.placement.margin;
  terrain.queryObstacles(x, z, clearance, _buf);
  for (let k = 0; k < _buf.length; k++) {
    if (obstacleSignedDistance(_buf[k], x, z) < clearance) return false;
  }
  return true;
}

function anyBlocked(soldiers, radii, terrain) {
  for (let i = 0; i < soldiers.length; i++) {
    const p = soldiers[i].pos;
    if (!isFree(terrain, p.x, p.z, radii[i])) return true;
  }
  return false;
}

function allFreeAt(soldiers, radii, terrain, dx, dz) {
  for (let i = 0; i < soldiers.length; i++) {
    const p = soldiers[i].pos;
    if (!isFree(terrain, p.x + dx, p.z + dz, radii[i])) return false;
  }
  return true;
}

// Smallest-distance offset (searched in square rings) that frees everyone.
function findShift(soldiers, radii, terrain) {
  const cfg = TerrainConfig.placement;
  const step = cfg.shiftStep;
  const maxRing = Math.floor(cfg.maxShift / step);

  for (let k = 1; k <= maxRing; k++) {
    let best = null;
    let bestD = Infinity;
    for (let i = -k; i <= k; i++) {
      for (let j = -k; j <= k; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== k) continue;
        const dx = i * step;
        const dz = j * step;
        const d = dx * dx + dz * dz;
        if (d >= bestD) continue;
        if (allFreeAt(soldiers, radii, terrain, dx, dz)) {
          best = { x: dx, z: dz };
          bestD = d;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

function translateUnit(unit, dx, dz) {
  for (const s of unit.soldiers) {
    if (!s.isAlive()) continue;
    s.pos.x += dx;
    s.pos.z += dz;
    s.formationSlot = { x: s.formationSlot.x + dx, z: s.formationSlot.z + dz };
  }
  unit.formationOrigin = { x: unit.formationOrigin.x + dx, z: unit.formationOrigin.z + dz };
  unit.formationMarchOrigin = {
    x: unit.formationMarchOrigin.x + dx,
    z: unit.formationMarchOrigin.z + dz
  };
}

function nearestFree(terrain, x, z, radius) {
  const cfg = TerrainConfig.placement;
  const step = cfg.nudgeStep;
  for (let r = step; r <= cfg.maxNudge; r += step) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * r) / step));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI;
      const nx = x + Math.cos(a) * r;
      const nz = z + Math.sin(a) * r;
      if (isFree(terrain, nx, nz, radius)) return { x: nx, z: nz };
    }
  }
  return null;
}

export const TerrainPlacement = {
  isFree,

  // Returns true when the unit was moved.
  settleUnit(unit, terrain) {
    const soldiers = unit.getAliveSoldiers();
    if (soldiers.length === 0) return false;
    const radii = soldiers.map(radiusOf);
    if (!anyBlocked(soldiers, radii, terrain)) return false;

    const shift = TerrainConfig.placement.shiftFormation
      ? findShift(soldiers, radii, terrain)
      : null;
    if (shift) translateUnit(unit, shift.x, shift.z);

    // Stragglers (no whole-formation spot, or a spot that was not exact).
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (isFree(terrain, s.pos.x, s.pos.z, radii[i])) continue;
      const spot = nearestFree(terrain, s.pos.x, s.pos.z, radii[i]);
      if (spot) {
        s.pos.x = spot.x;
        s.pos.z = spot.z;
      }
    }

    // TerrainCollisionSystem reverts soldiers in blocked cells to this.
    for (const s of soldiers) {
      s.terrainSafeX = s.pos.x;
      s.terrainSafeZ = s.pos.z;
    }
    return true;
  },

  settleUnits(units, terrain) {
    for (let i = 0; i < units.length; i++) {
      TerrainPlacement.settleUnit(units[i], terrain);
    }
  }
};
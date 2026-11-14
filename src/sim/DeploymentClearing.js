import { TerrainConfig } from '../config/TerrainConfig.js';

// Keeps the ground under the armies open without erasing the rest of the
// battlefield.
//
// The previous rule wiped every cell of both deployment zones. Zones are
// large, so the only terrain left was the strip between them: all
// obstacles in one line in the middle of the map. Now only two things are
// cleared:
//   1. the padded footprint of every unit, anywhere (unitMargin);
//   2. the part of a deployment zone within zoneBuffer of a unit, so a
//      player can nudge units around inside their zone without landing in
//      a lake.
// The rest of each zone keeps its terrain.
//
// Pure function of (units, zones), so multiplayer peers clear identically.

function paddedBoxes(units, margin) {
  const boxes = [];
  for (const u of units) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of u.soldiers) {
      if (!s.isAlive()) continue;
      if (s.pos.x < minX) minX = s.pos.x;
      if (s.pos.x > maxX) maxX = s.pos.x;
      if (s.pos.z < minZ) minZ = s.pos.z;
      if (s.pos.z > maxZ) maxZ = s.pos.z;
    }
    if (minX === Infinity) continue;
    boxes.push({
      minX: minX - margin, maxX: maxX + margin,
      minZ: minZ - margin, maxZ: maxZ + margin
    });
  }
  return boxes;
}

function inAnyBox(boxes, x, z) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return true;
  }
  return false;
}

function inAnyZone(zones, x, z) {
  for (let i = 0; i < zones.length; i++) {
    if (zones[i].contains(x, z)) return true;
  }
  return false;
}

export const DeploymentClearing = {
  apply(terrain, units, zones) {
    const cfg = TerrainConfig.deploymentClearing;

    if (zones.length > 0) {
      const boxes = paddedBoxes(units, cfg.zoneBuffer);
      if (boxes.length > 0) {
        terrain.clearWhere((x, z) => inAnyBox(boxes, x, z) && inAnyZone(zones, x, z));
      }
    }

    terrain.clearAroundUnits(units, cfg.unitMargin);
  }
};
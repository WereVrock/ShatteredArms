import { TerrainPlacement } from './TerrainPlacement.js';
import { TerrainConfig } from '../config/TerrainConfig.js';

// Per-soldier reactive steering for slot-followers. When the short stretch
// ahead of a soldier is blocked (tree, rock, wall, water), the soldier walks
// toward a point a bit to the side instead of pushing into it. No pathfinding:
// it only looks ~1.4 units ahead, so it is cheap, and the soldier still heads
// for its own slot, so the unit does not split.
//
// The decision is re-evaluated every EVAL_INTERVAL ticks per soldier
// (staggered by id) and cached as an angle on the soldier (steerAngle), so it
// does not flicker between ticks. The previous side is preferred, which stops
// a soldier flipping left and right in front of an obstacle.

const EVAL_INTERVAL = 4;
const LOOK_NEAR = 0.6;
const LOOK_FAR = 1.4;
const ANGLES = [0.6, 1.2, 1.8];   // about 35, 70 and 105 degrees
const STRAIGHT_DIST = 1.2;        // closer than this to the slot: just walk in

export class SlotSteering {
  constructor() {
    this._out = { x: 0, z: 0 };
  }

  // Returns a waypoint object (reused, valid until the next call) when the
  // soldier should detour, otherwise null (walk straight to the slot).
  steer(soldier, slot, terrain, tick) {
    const px = soldier.pos.x;
    const pz = soldier.pos.z;
    const dx = slot.x - px;
    const dz = slot.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 < STRAIGHT_DIST * STRAIGHT_DIST) {
      soldier.steerAngle = 0;
      return null;
    }

    const d = Math.sqrt(d2);
    const hx = dx / d;
    const hz = dz / d;
    const radius = soldier.unitTypeDef.collisionRadius ?? TerrainConfig.defaultSoldierRadius;
    let angle = soldier.steerAngle || 0;

    if (((tick + soldier.id) % EVAL_INTERVAL) === 0) {
      if (SlotSteering._clear(terrain, px, pz, hx, hz, radius)) {
        angle = 0;
      } else {
        const side = angle < 0 ? -1 : 1;
        let found = false;
        for (let i = 0; i < ANGLES.length && !found; i++) {
          for (let k = 0; k < 2; k++) {
            const a = ANGLES[i] * (k === 0 ? side : -side);
            const c = Math.cos(a);
            const s = Math.sin(a);
            if (SlotSteering._clear(terrain, px, pz, hx * c - hz * s, hx * s + hz * c, radius)) {
              angle = a;
              found = true;
              break;
            }
          }
        }
        // Nothing clear: keep the old angle and let terrain collision slide.
      }
      soldier.steerAngle = angle;
    }

    if (angle === 0) return null;

    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this._out.x = px + (hx * c - hz * s) * LOOK_FAR;
    this._out.z = pz + (hx * s + hz * c) * LOOK_FAR;
    return this._out;
  }

  static _clear(terrain, px, pz, hx, hz, radius) {
    return TerrainPlacement.isFree(terrain, px + hx * LOOK_NEAR, pz + hz * LOOK_NEAR, radius) &&
      TerrainPlacement.isFree(terrain, px + hx * LOOK_FAR, pz + hz * LOOK_FAR, radius);
  }
}
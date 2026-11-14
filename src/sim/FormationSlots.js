import { FormationDisorder } from './FormationDisorder.js';
import { SpearWall } from './SpearWall.js';
import { isSolidAt } from './MajorObstacles.js';
import { FormationSpine } from './FormationSpine.js';
import { TerrainConfig } from '../config/TerrainConfig.js';

// Computes every soldier's formationSlot for one unit. Extracted from
// Unit._applyFormationAt so the unit file stays about orders and state.
//
// Three things happen on top of the plain rotated grid:
//
//  1. BEND. While the unit follows a detour path, slots blend from the straight
//     block toward the path spine (FormationSpine), so a long column follows a
//     corridor instead of poking into the walls. The blend ramps in and out, so
//     the shape changes smoothly. The whole unit bends together, nobody splits.
//
//  2. FREE GROUND. A slot standing inside a tree, rock, wall or water is moved
//     individually: first slid sideways toward the row centre, then (rarely)
//     to the nearest free spot. The unit itself is NEVER relocated.
//     Re-evaluated every RELOCATE_INTERVAL ticks per soldier (staggered by id),
//     and the result is cached on the soldier.
//
//  3. The existing per-soldier discipline jitter, spear-wall buckling and the
//     lateral pass-through spread.
//
// Local frame (same as before): lateral axis (cos f, -sin f), forward axis
// (sin f, cos f); slot = origin + lx * lateral + lz * forward.

const BLEND_UP_PER_SEC = 0.4;
const BLEND_DOWN_PER_SEC = 0.6;
const SPINE_MARGIN = 3;          // extra spine length for jitter / wall offsets
const RELOCATE_INTERVAL = 3;     // ticks between free-ground re-checks per soldier
const SEARCH_BUDGET = 16;        // free-spot searches per unit per tick
const SLIDE_FRACTIONS = [0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0];
const SPOT_STEP = 1.0;
const SPOT_RINGS = 8;

const _spot = { x: 0, z: 0 };

// Nearest free point around (x, z), written to _spot.
function findFreeSpot(terrain, x, z, radius) {
  for (let ring = 1; ring <= SPOT_RINGS; ring++) {
    const rad = ring * SPOT_STEP;
    const n = ring * 8;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 6.283185307179586;
      const nx = x + Math.cos(a) * rad;
      const nz = z + Math.sin(a) * rad;
      if (!isSolidAt(terrain, nx, nz, radius)) {
        _spot.x = nx;
        _spot.z = nz;
        return true;
      }
    }
  }
  return false;
}

// Re-evaluates one soldier's free-ground adjustment. Writes slotScale
// (lateral compression, 1 = none) and slotShiftX/Z onto the soldier.
// Returns true when it spent a free-spot search.
function relocate(s, terrain, bx, bz, ux, uz, lx, allowSearch) {
  const r = s.unitTypeDef.collisionRadius ?? TerrainConfig.defaultSoldierRadius;
  let scale = 1;
  let hx = 0;
  let hz = 0;
  let searched = false;

  // Trees, bushes and small rocks are NOT checked here: a slot behind a tree
  // stays where it is and the soldier walks round the trunk to it.
  if (isSolidAt(terrain, bx + ux * lx, bz + uz * lx, r)) {
    scale = -1;
    for (let i = 0; i < SLIDE_FRACTIONS.length; i++) {
      const f = SLIDE_FRACTIONS[i];
      if (!isSolidAt(terrain, bx + ux * lx * f, bz + uz * lx * f, r)) {
        scale = f;
        break;
      }
    }
    if (scale < 0) {
      // Even the row centre is blocked.
      scale = 0;
      if (allowSearch) {
        searched = true;
        if (findFreeSpot(terrain, bx, bz, r)) {
          hx = _spot.x - bx;
          hz = _spot.z - bz;
        }
      } else {
        hx = s.slotShiftX || 0;
        hz = s.slotShiftZ || 0;
      }
    }
  }

  s.slotScale = scale;
  s.slotShiftX = hx;
  s.slotShiftZ = hz;
  return searched;
}

export const FormationSlots = {
  // alive may be null (computed here). deltaSeconds = 0 means an instant
  // placement (deployment drag): no blend change, every soldier re-evaluated now.
  apply(unit, originX, originZ, facing, terrain = null, alive = null, deltaSeconds = 0) {
    const soldiers = alive || unit.getAliveSoldiers();
    const count = soldiers.length;
    if (count === 0) return;

    const immediate = !(deltaSeconds > 0);
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    const spread = unit._spreadFactor ?? 1.0;
    const disorderCtx = unit._disorderContext();

    // --- bend blend ---
    let blend = unit._spineBlend || 0;
    if (!immediate) {
      if (terrain !== null && FormationSpine.hasDetour(unit)) {
        blend = Math.min(1, blend + BLEND_UP_PER_SEC * deltaSeconds);
      } else if (blend > 0) {
        blend = Math.max(0, blend - BLEND_DOWN_PER_SEC * deltaSeconds);
      }
      unit._spineBlend = blend;
    }

    let spine = null;
    if (blend > 0 && terrain !== null) {
      const spacing = unit.getFormationSpacing();
      const cols = Math.max(1, Math.min(unit.formationCols || 1, count));
      const depth = (Math.ceil(count / cols) - 1) * spacing + SPINE_MARGIN;
      spine = FormationSpine.build(unit, depth);
    }
    const X = spine ? spine.px : null;
    const Z = spine ? spine.pz : null;
    const TX = spine ? spine.tx : null;
    const TZ = spine ? spine.tz : null;
    const step = spine ? spine.step : 1;
    const last = spine ? spine.n - 1 : 0;

    // --- free-ground relocation ---
    const reloc = terrain !== null &&
      (terrain.obstacles.length > 0 || terrain.hasBlockedCells);
    const tick = unit._slotTick = (unit._slotTick + 1) | 0;
    let budget = SEARCH_BUDGET;

    for (let k = 0; k < count; k++) {
      const s = soldiers[k];
      const off = s.formationOffset;
      const jit = FormationDisorder.forSoldier(s, disorderCtx);
      const wall = SpearWall.disorderOffset(s);
      const lx = (off.x + jit.x + wall.x) * spread;
      const lz = off.z + jit.z + wall.z;

      // Row centre (b) and lateral unit vector (u): straight block first.
      let bx = originX + lz * sin;
      let bz = originZ + lz * cos;
      let ux = cos;
      let uz = -sin;

      if (spine !== null) {
        let sx, sz, tx, tz;
        const u = lz / step;
        if (u <= 0) {
          tx = TX[0]; tz = TZ[0];
          sx = X[0] + tx * lz;
          sz = Z[0] + tz * lz;
        } else if (u >= last) {
          const over = lz - last * step;
          tx = TX[last]; tz = TZ[last];
          sx = X[last] + tx * over;
          sz = Z[last] + tz * over;
        } else {
          const i = u | 0;
          const f = u - i;
          sx = X[i] + (X[i + 1] - X[i]) * f;
          sz = Z[i] + (Z[i + 1] - Z[i]) * f;
          tx = TX[i] + (TX[i + 1] - TX[i]) * f;
          tz = TZ[i] + (TZ[i + 1] - TZ[i]) * f;
          const tl = Math.sqrt(tx * tx + tz * tz) || 1;
          tx /= tl;
          tz /= tl;
        }
        bx += (sx - bx) * blend;
        bz += (sz - bz) * blend;
        // Spine lateral axis is (tz, -tx), the same convention as (cos, -sin).
        const nx = ux + (tz - ux) * blend;
        const nz = uz + (-tx - uz) * blend;
        const nl = Math.sqrt(nx * nx + nz * nz) || 1;
        ux = nx / nl;
        uz = nz / nl;
      }

      let scale = 1;
      let shX = 0;
      let shZ = 0;
      if (reloc) {
        if (immediate || s.slotScale === undefined ||
            ((tick + s.id) % RELOCATE_INTERVAL) === 0) {
          const canSearch = immediate || budget > 0;
          if (relocate(s, terrain, bx, bz, ux, uz, lx, canSearch) && !immediate) budget--;
        }
        scale = s.slotScale;
        shX = s.slotShiftX;
        shZ = s.slotShiftZ;
      }

      s.formationSlot = {
        x: bx + ux * lx * scale + shX,
        z: bz + uz * lx * scale + shZ
      };
    }
  }
};
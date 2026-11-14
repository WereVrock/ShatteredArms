import { AIConfig } from '../config/AIConfig.js';
import { isSpearmen } from '../config/UnitClasses.js';
import { isSolidAt } from '../sim/MajorObstacles.js';
import { slopeSpeedFactor } from '../sim/TerrainLocomotion.js';
import { SpearWallSystem } from '../sim/SpearWallSystem.js';

// AI-facing terrain queries. Stateless apart from one small per-unit hold-spot
// memory. Everything here takes `terrain` as a parameter and treats null as
// "flat ground": with no terrain every function returns the neutral answer, so
// callers never need their own null checks beyond passing it through.
//
// All functions are cheap (a handful of samples) and allocation-light, because
// they run inside decision cycles.
//
// Tunables can be overridden from AIConfig (names noted below); the fallbacks
// here are used when AIConfig does not define them.

// --- goal snapping ---
const GOAL_RINGS = 10;
const GOAL_STEP = 2.0;
const GOAL_CLEARANCE = 0.6;

// --- route / lane sampling ---
const ROUTE_STEP = 6;
const ROUTE_MAX_SAMPLES = 12;
const ROUTE_MIN_FACTOR = 0.25;
const ROUTE_BLOCKED_FACTOR = 0.5;   // blocked sample = a detour, not a wall
const LANE_REACH = 24;              // how much of the approach is judged for a charge
const LANE_MAX_SAMPLES = 9;

// --- defensive hold spot ---
const HOLD_GOOD_ENOUGH = 0.8;       // ground at least this good: stay
const HOLD_MARGIN = 0.15;           // a new spot must beat the current one by this
const HOLD_RADII = [4, 8, 12];
const HOLD_ANGLES = 12;
const HOLD_MAX_FORWARD = 2;         // never advance toward the enemy while repositioning
const HOLD_ARRIVE_SQ = 2.5 * 2.5;
const HOLD_LEAVE_SQ = 6 * 6;        // moved this far from a settled spot: forget it
const HEIGHT_WEIGHT = 0.03;
const HEIGHT_BONUS_CAP = 0.3;

const _goal = { x: 0, z: 0 };
const _spear = new SpearWallSystem();
const _holds = new WeakMap();

// Speed multiplier at a point along a heading, or -1 when the point is blocked.
function sampleSpeed(terrain, x, z, ux, uz, mounted, gait) {
  if (terrain.isBlocked(x, z)) return -1;
  let f = terrain.speedMultAt(x, z, mounted, gait);
  if (terrain.hasElevation) {
    f *= slopeSpeedFactor(terrain.slopeAlong(x, z, ux, uz), mounted);
  }
  return f;
}

export const TerrainSense = {
  // Moves (x, z) off ground a formation cannot stand on (deep water, walls,
  // big rocks, map edge) to the nearest free point. Returns a SHARED object:
  // copy the values before calling again. Unchanged when already free, or when
  // nothing free exists within GOAL_RINGS * GOAL_STEP.
  freeGoal(terrain, x, z) {
    _goal.x = x;
    _goal.z = z;
    if (!terrain) return _goal;
    if (!isSolidAt(terrain, x, z, GOAL_CLEARANCE)) return _goal;

    for (let ring = 1; ring <= GOAL_RINGS; ring++) {
      const rad = ring * GOAL_STEP;
      const n = 6 + ring * 2;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 6.283185307179586;
        const nx = x + Math.cos(a) * rad;
        const nz = z + Math.sin(a) * rad;
        if (!isSolidAt(terrain, nx, nz, GOAL_CLEARANCE)) {
          _goal.x = nx;
          _goal.z = nz;
          return _goal;
        }
      }
    }
    return _goal;
  },

  // Average speed factor (walk gait, slope included) along the straight route
  // a -> b. 1 on flat open ground, lower through mud, water, forest floor or
  // uphill. Blocked samples count as a detour (ROUTE_BLOCKED_FACTOR).
  routeSpeedFactor(terrain, a, b, mounted) {
    if (!terrain) return 1;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1) return 1;
    const ux = dx / len;
    const uz = dz / len;
    const n = Math.min(ROUTE_MAX_SAMPLES, Math.max(2, Math.ceil(len / ROUTE_STEP)));

    let sum = 0;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const s = sampleSpeed(terrain, a.x + dx * f, a.z + dz * f, ux, uz, mounted, 'walk');
      sum += s < 0 ? ROUTE_BLOCKED_FACTOR : s;
    }
    const avg = sum / n;
    return avg < ROUTE_MIN_FACTOR ? ROUTE_MIN_FACTOR : avg;
  },

  // Can a mounted charge from cav to def still build and keep speed over its
  // last LANE_REACH units? False on blocked ground or when the average run-gait
  // speed factor falls under AIConfig.chargeLaneMinSpeedFactor (default 0.65).
  chargeLaneClean(terrain, cav, def, dist) {
    if (!terrain) return true;
    const reach = Math.min(dist, LANE_REACH);
    if (reach < 4 || dist < 0.001) return true;

    const ux = (def.x - cav.x) / dist;
    const uz = (def.z - cav.z) / dist;
    const n = Math.min(LANE_MAX_SAMPLES, Math.max(2, Math.ceil(reach / 3)));

    let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = dist - reach * ((i + 0.5) / n);
      const s = sampleSpeed(terrain, cav.x + ux * t, cav.z + uz * t, ux, uz, true, 'run');
      if (s < 0) return false;
      sum += s;
    }
    const minFactor = AIConfig.chargeLaneMinSpeedFactor ?? 0.65;
    return sum / n >= minFactor;
  },

  // How good a place this is to stand and fight, roughly 0..1.3. 0 = unusable.
  // Spearmen use the spear-wall integrity measurement (ground type, slope,
  // nearby obstacles); everyone else uses walking speed and open space. A small
  // bonus for height.
  groundQuality(terrain, x, z, spear) {
    if (isSolidAt(terrain, x, z, 0.5)) return 0;

    let q;
    if (spear) {
      q = _spear.integrityAt(x, z, terrain);
    } else {
      const speed = terrain.speedMultAt(x, z, false, 'walk');
      const cl = terrain.navClearanceAt(x, z);
      const open = cl < 0 ? 0 : (cl >= 3 ? 1 : 0.6 + cl * 0.1333);
      q = (speed > 1 ? 1 : speed) * open;
    }

    return q + TerrainSense.heightBonus(terrain, x, z);
  },

  // Small bonus for standing high, 0..HEIGHT_BONUS_CAP. Part of groundQuality;
  // exposed so callers that replace the ground-type part with their own
  // measurement (WinPlanner uses real wall integrity) keep the same height term.
  heightBonus(terrain, x, z) {
    let bonus = terrain.heightAt(x, z) * HEIGHT_WEIGHT;
    if (bonus < 0) bonus = 0; else if (bonus > HEIGHT_BONUS_CAP) bonus = HEIGHT_BONUS_CAP;
    return bonus;
  },

  // Average LIVE spear-wall integrity (0..1, what SpearWallSystem wrote on the
  // soldiers) over a unit's living, non-routing spearmen, or null when the unit
  // has none. This is the real, eased and unit-blended value, not the ground
  // estimate groundQuality makes for a point.
  unitWallIntegrity(unit) {
    let sum = 0;
    let n = 0;
    const alive = unit.getAliveSoldiers();
    for (let i = 0; i < alive.length; i++) {
      const s = alive[i];
      if (s.isRouting) continue;
      if (!isSpearmen(s.unitTypeDef)) continue;
      sum += s.spearWallIntegrity;
      n++;
    }
    return n > 0 ? sum / n : null;
  },

  // Defensive hold position. Returns a spot { x, z } the unit should move to
  // because it stands on poor ground, or null to hold where it is.
  //
  // Remembered per unit so it cannot thrash: a chosen spot is returned until
  // the unit arrives; a unit that stands on good ground (or has no better ground
  // nearby) is recorded as settled and not re-searched until it has moved
  // HOLD_LEAVE away. `forward` is the line's forward axis; the search never
  // moves the unit more than HOLD_MAX_FORWARD toward the enemy.
  holdSpot(terrain, unit, center, forward, spear) {
    if (!terrain || !forward) return null;

    const st = _holds.get(unit);
    if (st) {
      const dx = st.x - center.x;
      const dz = st.z - center.z;
      const d2 = dx * dx + dz * dz;
      if (!st.done) {
        if (d2 > HOLD_ARRIVE_SQ) return st;
        st.done = true;
        return null;
      }
      if (d2 <= HOLD_LEAVE_SQ) return null;
      _holds.delete(unit);
    }

    const q0 = TerrainSense.groundQuality(terrain, center.x, center.z, spear);
    if (q0 >= HOLD_GOOD_ENOUGH) {
      _holds.set(unit, { x: center.x, z: center.z, done: true });
      return null;
    }

    let best = null;
    let bestQ = q0 + HOLD_MARGIN;
    for (let r = 0; r < HOLD_RADII.length; r++) {
      const rad = HOLD_RADII[r];
      for (let k = 0; k < HOLD_ANGLES; k++) {
        const a = (k / HOLD_ANGLES) * 6.283185307179586;
        const ox = Math.cos(a) * rad;
        const oz = Math.sin(a) * rad;
        if (ox * forward.x + oz * forward.z > HOLD_MAX_FORWARD) continue;
        const nx = center.x + ox;
        const nz = center.z + oz;
        const q = TerrainSense.groundQuality(terrain, nx, nz, spear);
        if (q > bestQ) {
          bestQ = q;
          best = { x: nx, z: nz };
        }
      }
    }

    if (best) {
      const spot = { x: best.x, z: best.z, done: false };
      _holds.set(unit, spot);
      return spot;
    }
    _holds.set(unit, { x: center.x, z: center.z, done: true });
    return null;
  }
};
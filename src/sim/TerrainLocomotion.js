import { TerrainConfig } from '../config/TerrainConfig.js';

// Slope -> movement consequences. Pure functions, no allocation.
const E = TerrainConfig.elevation;

// Best speed multiplier slopes can give (gentle downhill). Pathfinding uses
// it to keep its heuristic optimistic.
export const MAX_SLOPE_FACTOR = E.maxSpeedFactor;

// slope = rise / run along the direction of travel (positive = uphill).
export function slopeSpeedFactor(slope, mounted) {
  const k = mounted ? E.toblerKMounted : E.toblerK;
  const f = Math.exp(-k * (Math.abs(slope + E.toblerOffset) - E.toblerOffset));
  if (f < E.minSpeedFactor) return E.minSpeedFactor;
  return f > E.maxSpeedFactor ? E.maxSpeedFactor : f;
}

// Multiplier on walking fatigue drain. Only climbing costs extra.
export function climbFatigueMult(slope) {
  if (!(slope > 0)) return 1;
  const m = 1 + slope * E.climbFatigueFactor;
  return m > E.climbFatigueCap ? E.climbFatigueCap : m;
}
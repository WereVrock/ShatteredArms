// ===== helpers.js =====
// Shared helpers for headless scenario definitions. Every scenario file
// imports `unit` and the facing constants from here so the boilerplate
// lives in one place.
import { FormationFactory } from '../../sim/FormationFactory.js';
import { UnitTypes } from '../../config/UnitTypes.js';

// Facing convention (matches main.js): atan2(dx, dz).
//   0          → +Z  (south)
//   Math.PI    → -Z  (north)
//   Math.PI/2  → +X  (east)
//  -Math.PI/2  → -X  (west)
export const FACE_SOUTH = 0;
export const FACE_NORTH = Math.PI;
export const FACE_EAST  = Math.PI / 2;
export const FACE_WEST  = -Math.PI / 2;

export function unit(id, teamId, typeKey, x, z, facing, opts = {}) {
  return FormationFactory.createGridUnit({
    id,
    teamId,
    unitTypeDef: UnitTypes[typeKey],
    originX: x,
    originZ: z,
    facing,
    rows: opts.rows ?? 3,
    cols: opts.cols ?? 5,
    spacing: opts.spacing ?? 0.7,
    isUndead: !!opts.isUndead
  });
}

// Auto-numbering: strips any existing numeric prefix from each scenario's
// `name` and applies the current array index. Called ONCE by index.js after
// the SCENARIOS array is assembled, so the displayed number can never drift
// out of sync with array order. Never hand-write "NN - " prefixes into a
// scenario file; they will be stripped on load.
const _NAME_PREFIX_RE = /^\d+\s*-\s*/;
export function numberScenarios(scenarios) {
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    s.name = String(i + 1).padStart(2, '0') + ' - ' + s.name.replace(_NAME_PREFIX_RE, '');
  }
}
// Shared helpers for unit-level AI behaviors. Kept stateless so behaviors
// stay pure and easy to test.

import { AIConfig } from '../config/AIConfig.js';

export function nearestUnit(sourceUnit, candidateUnits) {
  const center = sourceUnit.getCenter();
  let best = null;
  let bestDist = Infinity;

  for (const candidate of candidateUnits) {
    const c = candidate.getCenter();
    const dx = c.x - center.x;
    const dz = c.z - center.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }

  return best;
}

// Returns the vector + facing from unit A's center to unit B's center.
// facing is in the same convention used elsewhere (atan2(x, z)).
export function centerTowardUnit(sourceUnit, targetUnit) {
  const a = sourceUnit.getCenter();
  const b = targetUnit.getCenter();
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  return { dx, dz, dist, facing: Math.atan2(dx, dz) };
}

export function unitTypeOf(unit) {
  return unit.soldiers[0]?.unitTypeDef || null;
}

// Average morale fraction (0..1) across a unit's currently-living soldiers.
// Returns 1 (treated as healthy) for a unit with no living soldiers — a
// defeated/empty unit should never register as "fragile" since it isn't
// eligible for anything that reads this in the first place.
export function averageMorale(unit) {
  const alive = unit.getAliveSoldiers();
  if (alive.length === 0) return 100;
  let sum = 0;
  for (const s of alive) sum += s.morale;
  return sum / alive.length;
}

// A4: is this unit's average morale below the fragile threshold? Pure read,
// no side effects — callers decide what to do with the answer (exclude from
// roles, exclude from reinforcement dispatch, route to fallback behavior).
//
// Two guards added on top of the bare average-morale read:
//
//   1. Loss guard. A unit that has lost almost nothing is not collapsed, no
//      matter what a momentary morale reading says. The flag is only
//      meaningful once the unit has actually taken casualties.
//
//   2. Routing guard. A unit with one routing soldier out of fifteen has
//      an average dragged down but is not broken. Requiring a minimum
//      routing fraction before flagging matches the intent of the flag
//      ("this unit is failing") rather than the letter of the raw read
//      ("average morale is below X").
//
// Without these, a transient morale dip on a fresh unit routes it to the
// reserve line, which yanks soldiers off the front and cascades into more
// morale loss. The guards exist because the flag's OUTPUT (a fallback
// order that removes the unit from the fight) is much stronger than its
// INPUT (an average-morale snapshot), and a strong action should require
// strong evidence.
export function isFragile(unit, fragileThreshold) {
  const alive = unit.getAliveSoldiers();
  if (alive.length === 0) return false;

  // Guard 1: require a minimum loss fraction.
  const deployed = unit.soldiers.length;
  if (deployed > 0) {
    const lossFraction = 1 - alive.length / deployed;
    if (lossFraction < AIConfig.fragileMinLossFraction) return false;
  }

  // Guard 2: require a minimum routing fraction.
  let routing = 0;
  for (const s of alive) {
    if (s.isRouting) routing++;
  }
  const routingFraction = routing / alive.length;
  if (routingFraction < AIConfig.fragileMinRoutingFraction) return false;

  return averageMorale(unit) < fragileThreshold;
}
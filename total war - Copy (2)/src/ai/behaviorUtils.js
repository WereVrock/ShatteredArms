// Shared helpers for unit-level AI behaviors. Kept stateless so behaviors
// stay pure and easy to test.

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
export function isFragile(unit, fragileThreshold) {
  return averageMorale(unit) < fragileThreshold;
}
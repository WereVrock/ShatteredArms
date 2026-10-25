// ===== UnitHistoryFields.js =====
// Unit-level field descriptors for UnitHistoryTracker. Split out of the
// tracker so the tracker's diffing machinery (unit-level + per-soldier +
// aggregation) reads as one file, and the descriptors read as another.
//
// Each descriptor is:
//   key       unique id, used as the snapshot map key
//   label     display name shown in the history row
//   snapshot  (unit, aliveSoldiers) => string; the current formatted value
//   changed   optional (prevStr, nowStr) => bool; default is !==
//   explain   (prevStr, nowStr) => string; the human-readable description
//
// snapshot always returns a STRING so comparisons and displays share one
// representation. explain receives the two formatted strings, so it never
// has to reach back into the unit for a value that has already been
// normalized.
//
// These are UNIT-level fields. Per-soldier events (damage, morale with
// source breakdown, kills, deaths, routing) are produced by the tracker's
// per-soldier pass, not here.

function fmtSigned(delta) {
  return delta > 0 ? `+${delta}` : String(delta);
}

// Threshold for morale/stamina change events, in the field's own units
// (0-100 scale). 3 is high enough that normal regeneration and single-
// tick combat pressure do not spam the log, low enough that a meaningful
// slide (the kind that precedes a rout) shows up promptly.
const MORALE_DELTA = 3;
const STAMINA_DELTA = 5;

// Formation facing is radians internally but shown in degrees. A wobble
// of a fraction of a degree happens constantly as soldiers rotate at
// their bounded turn rate; only report when the rounded degree value
// moves by this much.
const FACING_DEG_DELTA = 5;

export const UNIT_FIELDS = [
  {
    key: 'hasActiveOrder',
    label: 'Order state',
    snapshot: u => u.hasActiveOrder ? 'active' : 'none',
    explain: (from, to) => to === 'active'
      ? 'Unit has an active move order. Soldiers march toward the destination '
      + 'as a block, holding formation until each one individually reaches its '
      + 'breakoff range from the destination.'
      : 'Move order cleared. Either the unit arrived at its destination, the '
      + 'order was cancelled (Stop), or it was replaced by a new order. '
      + 'Without an active order the block holds its current position.'
  },
  {
    key: 'orderTarget',
    label: 'Move destination',
    snapshot: u => u.orderTarget
      ? `(${u.orderTarget.x.toFixed(1)}, ${u.orderTarget.z.toFixed(1)})`
      : 'none',
    explain: (from, to) => to === 'none'
      ? `Order target cleared (was ${from}).`
      : `Order target changed from ${from} to ${to}. The formation anchor `
      + `advances toward the new destination every tick; individual soldiers `
      + `follow their slots until their own breakoff range is reached.`
  },
  {
    key: 'focusTargetUnitId',
    label: 'Attack focus (player)',
    snapshot: u => u.focusTargetUnitId ?? 'none',
    explain: (from, to) => {
      if (to === 'none') {
        return `Attack focus cleared (was ${from}). The target unit was `
          + `destroyed, the order was replaced, or a move order overrode it.`;
      }
      return `Attack focus set on ${to}. Every soldier in this unit prefers `
        + `the nearest living soldier of ${to} as its target, and the unit's `
        + `march anchor now tracks that unit's live center (this is the `
        + `player-attack-order field, unlike aiFocusTargetUnitId).`;
    }
  },
  {
    key: 'aiFocusTargetUnitId',
    label: 'Attack focus (AI)',
    snapshot: u => u.aiFocusTargetUnitId ?? 'none',
    explain: (from, to) => {
      if (to === 'none') {
        return `AI focus cleared (was ${from}).`;
      }
      return `AI assigned aiFocusTarget ${to}. Soldiers prefer that unit's `
        + `soldiers as targets, but the unit's march anchor is NOT affected — `
        + `the block does not advance toward the target. This is the AI-only `
        + `focus field, distinct from the player-attack-order focus above.`;
    }
  },
  {
    key: 'fireAtWill',
    label: 'Fire at will',
    snapshot: u => u.fireAtWill ? 'on' : 'off',
    explain: (from, to) => to === 'on'
      ? 'Fire-at-will turned ON. Ranged soldiers in this unit will engage '
      + 'any enemy within range on their own.'
      : 'Fire-at-will turned OFF. Ranged soldiers will only fire at a unit '
      + 'that has been explicitly clicked (attack focus is set).'
  },
  {
    key: 'formationFacingDeg',
    label: 'Formation facing',
    snapshot: u => String(Math.round(u.formationFacing * 180 / Math.PI)),
    changed: (a, b) => Math.abs(Number(a) - Number(b)) >= FACING_DEG_DELTA,
    explain: (from, to) => {
      const delta = Number(to) - Number(from);
      const dir = delta > 0 ? 'clockwise' : 'counter-clockwise';
      return `Formation rotated ${Math.abs(delta)}° ${dir} (${from}° → ${to}°). `
        + `This is the unit's TARGET orientation. Individual soldiers rotate `
        + `toward it at their own bounded turn rate, so a large rotation here `
        + `can take several ticks before every soldier is facing the new way.`;
    }
  },
  {
    key: 'formationCols',
    label: 'Formation width',
    snapshot: u => String(u.formationCols),
    explain: (from, to) => {
      const d = Number(to) - Number(from);
      return `Formation column count changed from ${from} to ${to} `
        + `(${fmtSigned(d)}). Columns × soldier spacing = the unit's frontage. `
        + `Larger column counts mean a wider, shallower formation; smaller `
        + `counts mean a deeper one. Changed by an explicit formation drag or `
        + `a width-drag order, never by a plain move or attack order.`;
    }
  },
  {
    key: 'aliveCount',
    label: 'Alive soldiers',
    snapshot: (u, alive) => String(alive.length),
    explain: (from, to) => {
      const d = Number(to) - Number(from);
      return d < 0
        ? `Lost ${-d} soldier(s) this frame (${from} → ${to}). Dead soldiers `
          + `never return; extracted routers are also removed from the alive `
          + `count. The unit's formation has been reflowed onto a smaller grid.`
        : `Alive count rose from ${from} to ${to}. This should not happen in `
          + `normal play — investigate.`;
    }
  },
  {
    key: 'engagedCount',
    label: 'Soldiers in melee',
    snapshot: (u, alive) => {
      let n = 0;
      for (const s of alive) {
        if (s.state === 'engaged' || s.state === 'staggered') n++;
      }
      return String(n);
    },
    explain: (from, to) => {
      const d = Number(to) - Number(from);
      return d > 0
        ? `+${d} soldier(s) entered melee (${from} → ${to}). They acquired an `
          + `enemy within engagement range and transitioned to 'engaged' state. `
          + `Staggered soldiers are counted here too — they were fighting and `
          + `got staggered by a hit or an arrow.`
        : `${-d} soldier(s) left melee (${from} → ${to}). Either the target `
          + `died, the soldier was pulled away by an order, or the unit was `
          + `issued a Stop.`;
    }
  },
  {
    key: 'routingCount',
    label: 'Routing soldiers',
    snapshot: (u, alive) => {
      let n = 0;
      for (const s of alive) {
        if (s.state === 'routing' || s.state === 'shattered') n++;
      }
      return String(n);
    },
    explain: (from, to) => {
      const d = Number(to) - Number(from);
      return d > 0
        ? `+${d} soldier(s) broke and are routing or shattered (${from} → ${to}). `
          + `A soldier enters routing when their morale reaches 0. Shattered `
          + `is terminal — the soldier will not rally and runs for the map edge `
          + `to extract.`
        : `${-d} soldier(s) left routing (${from} → ${to}). Either they `
          + `rallied (morale recovered above the rally threshold), were `
          + `extracted off the map, or were killed in flight.`;
    }
  },
  {
    key: 'avgMorale',
    label: 'Average morale',
    snapshot: (u, alive) => {
      if (!alive.length) return '0.0';
      let sum = 0;
      for (const s of alive) sum += s.morale;
      return (sum / alive.length).toFixed(1);
    },
    changed: (a, b) => Math.abs(Number(a) - Number(b)) >= MORALE_DELTA,
    explain: (from, to) => {
      const d = Number(to) - Number(from);
      return d > 0
        ? `Average morale rose ${fmtSigned(+d.toFixed(1))} (${from} → ${to}). `
          + `Soldiers are recovering — most likely out of combat, not flanked, `
          + `and no nearby ally is routing. Morale regen only ticks while a `
          + `soldier is NOT engaged / staggered / shooting.`
        : `Average morale fell ${fmtSigned(+d.toFixed(1))} (${from} → ${to}). `
          + `Pressure is building. For per-soldier sources see the morale-loss `
          + `entries below; they name the specific contributors (casualties, `
          + `outnumbered, flanked, ally rout, damage taken).`;
    }
  },
  {
    key: 'avgFatigue',
    label: 'Average stamina',
    snapshot: (u, alive) => {
      if (!alive.length) return '0.0';
      let sum = 0;
      for (const s of alive) sum += s.fatigue;
      return (sum / alive.length).toFixed(1);
    },
    changed: (a, b) => Math.abs(Number(a) - Number(b)) >= STAMINA_DELTA,
    explain: (from, to) => {
      const d = Number(to) - Number(from);
      return d > 0
        ? `Average stamina rose ${fmtSigned(+d.toFixed(1))} (${from} → ${to}). `
          + `Soldiers are resting — stamina only regenerates for a soldier in `
          + `'idle' state who did not move this tick.`
        : `Average stamina fell ${fmtSigned(+d.toFixed(1))} (${from} → ${to}). `
          + `Soldiers are tiring. Every attack swing, block attempt, arrow `
          + `loosed, and walked tick drains stamina; low stamina reduces `
          + `block chance and attack accuracy.`;
    }
  }
];
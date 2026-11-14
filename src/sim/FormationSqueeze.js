import { FormationSpine } from './FormationSpine.js';
import { isSolidAt } from './MajorObstacles.js';

// Unit-level formation squeeze. A marching unit measures how wide the corridor
// is along its own spine (anchor -> front rank + lookahead, following the path
// around bends) and narrows its column count to fit, then widens again once the
// corridor opens. The whole unit changes shape together: every slot still
// hangs off the one march anchor, so the unit stays uniform and does not split.
//
// Rules:
//  - Only major blockers count (see MajorObstacles): walls, big rocks, deep
//    water, map edge. Trees and small rocks never squeeze a unit.
//  - The unit never narrows below MIN_WIDTH_FRACTION of its normal width, so a
//    big unit does not become one endless column. Where the corridor is
//    narrower than that, slots slide inward (FormationSlots) as space allows.
//  - The FINAL formation is never changed: the unit returns to its full shape
//    when the order clears, when the anchor is within SETTLE_DISTANCE of the
//    destination, when a soldier breaks off to chase, and while rushing
//    (direct march).
//  - Nothing narrows while anyone is in melee.
//
// State lives in a WeakMap so Unit carries no extra fields. If anything else
// changes unit.formationCols (a player width drag, deployment), that value
// becomes the new "wanted" column count.

const EVAL_INTERVAL = 4;        // ticks between corridor scans
const WIDEN_HOLD_EVALS = 3;     // scans a wider corridor must be seen before widening
const WIDEN_MIN_GAIN = 2;       // widening smaller than this many columns is ignored
const MIN_COLS = 3;             // absolute floor
const MIN_WIDTH_FRACTION = 0.5; // never narrower than this share of the normal width
const SETTLE_DISTANCE = 12;     // within this of the destination: restore full shape
const PROBE_STEP = 1.0;         // lateral probe step
const SCAN_STEP = 1.0;          // spacing of scan points along the spine
const MAX_SCAN_POINTS = 48;     // cap on scan points for very deep formations
const LOOKAHEAD = 8;            // units scanned beyond the front rank
const PROBE_CLEARANCE = 0.4;    // soldier body radius plus margin
const MAX_REFINE = 3;           // rescans per evaluation (narrower grid = deeper footprint)

const _state = new WeakMap();

function stateFor(unit) {
  let st = _state.get(unit);
  if (!st) {
    st = { base: unit.formationCols, applied: unit.formationCols, tick: 0, wideEvals: 0 };
    _state.set(unit, st);
  }
  return st;
}

function inMelee(alive) {
  for (let i = 0; i < alive.length; i++) {
    const s = alive[i].state;
    if (s === 'engaged' || s === 'staggered') return true;
  }
  return false;
}

// True when the unit should be in its normal formation: no order, a rush, the
// final approach, or a chase where soldiers have already broken off.
function shouldBeFull(unit) {
  if (unit._directMarch) return true;
  if (unit.focusTargetUnitId) return unit._marchReleased.size > 0;
  if (!unit.hasActiveOrder) return true;
  const d = unit._marchDestination;
  if (!d) return true;
  const a = unit.formationMarchOrigin;
  const dx = d.x - a.x;
  const dz = d.z - a.z;
  return dx * dx + dz * dz <= SETTLE_DISTANCE * SETTLE_DISTANCE;
}

// Distance (multiple of PROBE_STEP) that stays non-solid from (px, pz) along (dx, dz).
function freeExtent(terrain, px, pz, dx, dz, reach) {
  let d = 0;
  while (d + PROBE_STEP <= reach) {
    const nd = d + PROBE_STEP;
    if (isSolidAt(terrain, px + dx * nd, pz + dz * nd, PROBE_CLEARANCE)) break;
    d = nd;
  }
  return d;
}

// Smallest symmetric half-width over the scan points of the spine.
// Infinity when no scan point was usable (treated as "no information").
function corridorHalfWidth(terrain, sp, reach) {
  const stride = Math.max(1, Math.round(SCAN_STEP / sp.step), Math.ceil(sp.n / MAX_SCAN_POINTS));
  let half = Infinity;
  for (let i = 0; i < sp.n; i += stride) {
    const x = sp.px[i];
    const z = sp.pz[i];
    if (isSolidAt(terrain, x, z, PROBE_CLEARANCE)) continue;
    // Spine lateral axis, same convention as FormationSlots.
    const lx = sp.tz[i];
    const lz = -sp.tx[i];
    const left = freeExtent(terrain, x, z, -lx, -lz, reach);
    const right = freeExtent(terrain, x, z, lx, lz, reach);
    const m = left < right ? left : right;
    if (m < half) half = m;
    if (half <= 0) break;
  }
  return half;
}

// Column count that fits the corridor, between the width floor and `cap`.
function fitCols(unit, terrain, count, spacing, cap) {
  const floorCols = Math.min(cap, Math.max(MIN_COLS, Math.ceil(cap * MIN_WIDTH_FRACTION)));
  const reach = cap * spacing * 0.5 + PROBE_STEP;

  let cols = cap;
  for (let i = 0; i < MAX_REFINE; i++) {
    const length = (Math.ceil(count / cols) - 1) * spacing + LOOKAHEAD;
    const sp = FormationSpine.build(unit, length);
    const half = corridorHalfWidth(terrain, sp, reach);
    let fit = cap;
    if (half !== Infinity) fit = Math.floor((half * 2) / spacing) + 1;
    if (fit > cap) fit = cap;
    if (fit < floorCols) fit = floorCols;
    if (fit >= cols) break;
    cols = fit;
  }
  return cols;
}

function applyCols(unit, st, cols, fullCols) {
  unit.formationCols = cols;
  st.applied = cols;
  unit._applyExistingShape();
  // The unit's nominal width stays the full width, so path clearance, the
  // order-destination reveal and later orders do not see the temporary squeeze.
  unit.currentWidthUnits = fullCols * unit.getFormationSpacing();
}

export const FormationSqueeze = {
  // Called once per tick from Unit.update, right before slots are recomputed.
  update(unit, alive, terrain) {
    if (!terrain) return;
    if (terrain.obstacles.length === 0 && !terrain.hasBlockedCells) return;

    const st = stateFor(unit);
    if (unit.formationCols !== st.applied) {
      // Someone else reshaped the unit: that is the new wanted shape.
      st.base = unit.formationCols;
      st.applied = unit.formationCols;
      st.wideEvals = 0;
    }

    const count = alive.length;
    const cap = Math.max(1, Math.min(st.base, count));
    const current = Math.min(st.applied, cap);

    // Final formation / rush: back to the full shape right away.
    if (shouldBeFull(unit)) {
      if (current < cap) applyCols(unit, st, cap, cap);
      st.wideEvals = 0;
      return;
    }

    st.tick++;
    if (st.tick % EVAL_INTERVAL !== 0) return;
    if (inMelee(alive)) return;

    // Discipline limits (minimum columns, no stub back row) still apply.
    const wanted = unit._constrainFormationCols(
      fitCols(unit, terrain, count, unit.getFormationSpacing(), cap)
    );

    if (wanted < current) {
      applyCols(unit, st, wanted, cap);
      st.wideEvals = 0;
      return;
    }

    if (wanted > current && (wanted - current >= WIDEN_MIN_GAIN || wanted >= cap)) {
      st.wideEvals++;
      if (st.wideEvals >= WIDEN_HOLD_EVALS) {
        applyCols(unit, st, wanted, cap);
        st.wideEvals = 0;
      }
      return;
    }

    st.wideEvals = 0;
  }
};
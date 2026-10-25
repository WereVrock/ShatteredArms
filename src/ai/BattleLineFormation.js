// Plans a coherent battle line for one team. Given the team's units and
// the enemy units, produces a per-unit "context" describing where on the
// team's line that unit should sit:
//
//   role:          'front' | 'support' | 'flank' | 'reserve'
//   lateralOffset: signed distance along the line's right-hand axis
//   depthOffset:   distance behind the line anchor (positive = further back)
//   forward:       unit vector from team center toward enemy center
//   right:         unit vector perpendicular to forward (the line axis)
//   lineFacing:    angle the line faces (atan2 convention)
//
// Reserve: a fraction of front-line-eligible (non-cavalry, non-ranged)
// units are now held out of the initial front-line slot assignment
// entirely and given a 'reserve' role instead, holding position behind the
// line rather than committing to a formation slot from tick one. TeamAI is
// responsible for deploying them (releasing to normal front-line behavior)
// when a gap opens or reinforcement is needed — this class only computes
// WHERE the reserve holds, not when it deploys (that's a live-battle
// decision, not a static formation layout concern).
//
// getLineAxis() exposes the same right/forward axis used here so
// EnemyLineAnalysis can bucket the enemy line consistently with how this
// class buckets our own.
//
// Stateless. Called once per TeamAI decision, not every sim tick.

import { AIConfig } from '../config/AIConfig.js';
import { DeploymentConfig } from '../config/DeploymentConfig.js';
import { isCavalry, isRanged } from '../config/UnitClasses.js';
import { unitTypeOf } from './behaviorUtils.js';

export class BattleLineFormation {
computeContexts(teamUnits, enemyUnits) {
    const map = new Map();
    if (teamUnits.length === 0 || enemyUnits.length === 0) return map;

    const axis = this.getLineAxis(teamUnits, enemyUnits);
    if (!axis) return map;

    const { fwdX, fwdZ, rightX, rightZ, lineFacing } = axis;

    const { front, reserve, support, flank } = this._classify(teamUnits, rightX, rightZ);

    // _assignLineRole now returns the row's half-span (centre to outermost
    // unit's outer edge including gaps), so the flank placement can sit
    // outside the WIDEST of the two front rows. Previously it used
    // frontCount * scalar spacing, which did not reflect the row's real
    // footprint once widths were respected.
    const frontHalfSpan = this._assignLineRole(map, front, 'front', {
      depthOffset: 0,
      fwdX, fwdZ, rightX, rightZ, lineFacing
    });
    this._assignNeighbors(map, front, fwdX, fwdZ);

    this._assignReserveRole(map, reserve, {
      fwdX, fwdZ, rightX, rightZ, lineFacing
    });

    const supportHalfSpan = this._assignLineRole(map, support, 'support', {
      depthOffset: AIConfig.supportDepth,
      fwdX, fwdZ, rightX, rightZ, lineFacing
    });
    this._assignNeighbors(map, support, fwdX, fwdZ);

    this._assignFlankRole(map, flank, Math.max(frontHalfSpan, supportHalfSpan), {
      fwdX, fwdZ, rightX, rightZ, lineFacing
    });

    return map;
  }

  // Exposed separately so EnemyLineAnalysis can bucket the ENEMY's units
  // along the same axis our own line uses, keeping "left"/"right" and
  // slice boundaries consistent between our formation and our weak-point
  // reads of the enemy.
  getLineAxis(teamUnits, enemyUnits) {
    const teamCenter = this._meanCenter(teamUnits);
    const enemyCenter = this._meanCenter(enemyUnits);

    const dx = enemyCenter.x - teamCenter.x;
    const dz = enemyCenter.z - teamCenter.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.001) return null;

    const fwdX = dx / dist;
    const fwdZ = dz / dist;
    const rightX = fwdZ;
    const rightZ = -fwdX;
    const lineFacing = Math.atan2(fwdX, fwdZ);

    return {
      fwdX, fwdZ, rightX, rightZ, lineFacing,
      forward: { x: fwdX, z: fwdZ },
      right: { x: rightX, z: rightZ }
    };
  }

_classify(teamUnits, rightX, rightZ) {
    const frontEligible = [];
    const support = [];
    const flank = [];

    for (const u of teamUnits) {
      if (u.isDefeated()) continue;
      const type = unitTypeOf(u);
      if (!type) { frontEligible.push(u); continue; }
      if (isCavalry(type)) flank.push(u);
      else if (isRanged(type)) support.push(u);
      else frontEligible.push(u);
    }

    // Sort by lateral position along the line's right axis, NOT by id.
    //
    // Sorting by id assigns line slots by spawn ORDER, not spawn POSITION:
    // a unit that spawned on the left with a high id gets a right-side
    // slot, and one that spawned on the right with a low id gets a
    // left-side slot. Both units then cross the entire formation to reach
    // their assigned slots — exactly the "left unit walks right, right
    // unit walks left" symptom.
    //
    // This mirrors the same fix in StandardDeployment.computePlacements:
    // a formation system's job is to arrange units INTO a line, not to
    // shuffle which side of that line each unit belongs on relative to
    // where it started.
    //
    // rightX/rightZ are supplied by the caller (computeContexts, which
    // already has them from getLineAxis) — the same right-axis convention
    // used everywhere else in this class.
    const byLateral = (a, b) => {
      const ca = a.getCenter();
      const cb = b.getCenter();
      const la = ca.x * rightX + ca.z * rightZ;
      const lb = cb.x * rightX + cb.z * rightZ;
      return la - lb;
    };
    frontEligible.sort(byLateral);
    support.sort(byLateral);
    flank.sort(byLateral);

    // Reserve carve-out: take from the CENTRE of the sorted front list so
    // the front line doesn't develop a one-sided gap (previously the
    // lowest-id units were taken, which happened to be the leftmost after
    // an id sort but would now be the leftmost after a lateral sort — a
    // visible asymmetry the reserve role wasn't designed for).
    const reserveCount = Math.floor(frontEligible.length * AIConfig.reserveFraction);
    const reserve = [];
    const front = [];
    if (reserveCount > 0) {
      const start = Math.floor((frontEligible.length - reserveCount) / 2);
      for (let i = 0; i < frontEligible.length; i++) {
        if (i >= start && i < start + reserveCount) reserve.push(frontEligible[i]);
        else front.push(frontEligible[i]);
      }
    } else {
      front.push(...frontEligible);
    }

    return { front, reserve, support, flank };
  }

// Lateral offsets are computed from each unit's currentWidthUnits plus a
  // per-pair gap of DeploymentConfig.unitGapFactor * min(width_i, width_{i+1})
  // — the SAME layout DeploymentConfig / StandardDeployment.computeRowLayout
  // produced at deployment time. This is what preserves the deployment
  // gaps (the lanes archers withdraw through, and the visual spacing
  // between a wide spear block and its narrow neighbour) when the line is
  // re-formed during the approach.
  //
  // Prior to this, the lateral step was a fixed scalar per unit, so a wide
  // spear block and a narrow archer unit were placed equally far apart —
  // visually correct only if all units were the same width. In practice
  // that collapsed every real inter-unit gap to a uniform spacing, which is
  // exactly the "line move removes the gaps" symptom.
  //
  // Returns the row's half-span (centre to outermost outer edge, including
  // end units' full width) so callers can place things (e.g. the flank
  // column) outside the widest row.
  _assignLineRole(map, units, role, opts) {
    const { depthOffset, fwdX, fwdZ, rightX, rightZ, lineFacing } = opts;
    const n = units.length;
    if (n === 0) return 0;

    const { offsets, halfSpan } = this._computeLineSlots(
      units, DeploymentConfig.unitGapFactor
    );

    for (let i = 0; i < n; i++) {
      map.set(units[i].id, {
        role,
        lateralOffset: offsets[i],
        depthOffset,
        forward: { x: fwdX, z: fwdZ },
        right: { x: rightX, z: rightZ },
        lineFacing
      });
    }
    return halfSpan;
  }

  // The canonical width-and-gap layout for a row of units. Mirrors the
  // deployment-time layout in StandardDeployment.computeRowLayout — same
  // widths source (currentWidthUnits, floored at 1), same per-pair gap
  // formula (gapFactor * min(width_i, width_{i+1})), same half-span
  // centring. Keeping these two layouts identical is what makes the
  // formation slots match the deployment positions, so gaps survive the
  // line's re-form.
  //
  // Returns { offsets, halfSpan }:
  //   offsets[i] — signed lateral offset of unit i's CENTRE from the row's
  //                centre, ordered left-to-right in the input array.
  //   halfSpan   — distance from row centre to the outermost edge of the
  //                end units (half the row's full width including gaps).
  //
  // Does NOT clamp to a zone — unlike the deployment layout, the formation
  // has no zone. If the deployment clamped the gap because the zone was
  // tight, the formation row will be very slightly wider than the deployed
  // layout; the units will then settle a fraction of a unit apart. That
  // edge case is acceptable given the alternative (formation must know
  // about zone geometry, which is a deployment concern).
  _computeLineSlots(units, gapFactor) {
    const n = units.length;
    if (n === 0) return { offsets: [], halfSpan: 0 };

    const widths = units.map(u => Math.max(u.currentWidthUnits || 3, 1));

    let sumWidths = 0;
    for (const w of widths) sumWidths += w;

    let sumMinWidths = 0;
    for (let i = 0; i < n - 1; i++) {
      sumMinWidths += Math.min(widths[i], widths[i + 1]);
    }

    const actualSpan = sumWidths + gapFactor * sumMinWidths;
    const halfSpan = actualSpan / 2;

    const offsets = [];
    let cursor = -halfSpan;
    for (let i = 0; i < n; i++) {
      offsets.push(cursor + widths[i] / 2);
      cursor += widths[i];
      if (i < n - 1) {
        cursor += gapFactor * Math.min(widths[i], widths[i + 1]);
      }
    }

    return { offsets, halfSpan };
  }

// Reserve units are given a context so downstream code (TeamAI) can find
  // their holding position, but their role is explicitly 'reserve' —
  // LineBehavior/TeamAI treat this role as "hold, don't advance" until
  // TeamAI explicitly deploys the unit (at which point it's simply treated
  // as a normal front unit for that decision cycle; no separate reserve
  // logic needed once deployed).
// Same width-and-gap layout as _assignLineRole — reserve units were
  // carved out of the front-eligible pool, so they have the same width
  // distribution as the front row. Using the same layout keeps reserve
  // slots visually consistent with what the front row would have looked
  // like had those units stayed in it.
  _assignReserveRole(map, units, opts) {
    const { fwdX, fwdZ, rightX, rightZ, lineFacing } = opts;
    const n = units.length;
    if (n === 0) return;

    const { offsets } = this._computeLineSlots(
      units, DeploymentConfig.unitGapFactor
    );

    for (let i = 0; i < n; i++) {
      map.set(units[i].id, {
        role: 'reserve',
        lateralOffset: offsets[i],
        depthOffset: AIConfig.reserveHoldDepth,
        forward: { x: fwdX, z: fwdZ },
        right: { x: rightX, z: rightZ },
        lineFacing
      });
    }
  }

// frontHalfSpan is the half-span of the widest front row (see
  // computeContexts — it takes max(frontHalfSpan, supportHalfSpan)). The
  // first flank unit sits at frontHalfSpan + flankLateralOffset, so the
  // cavalry wing clears the entire front line, not merely a frontCount-
  // based estimate that ignored unit widths.
  _assignFlankRole(map, units, frontHalfSpan, opts) {
    const { fwdX, fwdZ, rightX, rightZ, lineFacing } = opts;
    const n = units.length;
    if (n === 0) return;

    // Cavalry step between units stays scalar — the flank is a distinct
    // wing, and its internal spacing is independent of the line's width-
    // and-gap layout. lineUnitSpacing is the same value used before; only
    // the STARTING lateral (frontHalfSpan) is now width-aware.
    const flankStep = AIConfig.lineUnitSpacing;
    const outerStart = frontHalfSpan + AIConfig.flankLateralOffset;

    // All cavalry deploy on a single flank (right side by default),
    // stacked laterally outward from the line's edge. Previously the
    // assignment alternated left/right, which split the cavalry into
    // two weaker groups and made it easy for the enemy to defeat each
    // in detail. One concentrated flank is the hammer posture the rest
    // of the AI is built around.
    const side = 1;
    for (let i = 0; i < n; i++) {
      const lateral = side * (outerStart + i * flankStep);
      map.set(units[i].id, {
        role: 'flank',
        lateralOffset: lateral,
        depthOffset: AIConfig.flankDepth,
        forward: { x: fwdX, z: fwdZ },
        right: { x: rightX, z: rightZ },
        lineFacing
      });
    }
  }

  // A1: for each unit in a role group, snapshot the forward-axis position
  // of its immediate neighbours along the line (the units one index either
  // side in the role-sorted array — same role, adjacent lateralOffset).
  // Stored on the context as `neighborForwardMedian`. Flank/cavalry units
  // are deliberately not passed through here: A3 owns cavalry coordination.
  //
  // Positions are snapshotted at context-computation time. computeContexts
  // runs once per TeamAI decision cycle and nothing moves within a cycle,
  // so the snapshot is valid for the whole cycle the cap is applied in.
  //
  // Edge cases: a line's end unit has one neighbour (median = that
  // neighbour's forward); a sole line unit has none and is left unset
  // (LineBehavior treats unset as "no cap, no group to cohere with").
  _assignNeighbors(map, units, forwardX, forwardZ) {
    const n = units.length;
    if (n === 0) return;

    const forwards = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = units[i].getCenter();
      forwards[i] = c.x * forwardX + c.z * forwardZ;
    }

    for (let i = 0; i < n; i++) {
      const ctx = map.get(units[i].id);
      if (!ctx) continue;

      const neighborForwards = [];
      if (i > 0) neighborForwards.push(forwards[i - 1]);
      if (i < n - 1) neighborForwards.push(forwards[i + 1]);

      if (neighborForwards.length === 0) {
        ctx.neighborForwardMedian = null;
      } else {
        neighborForwards.sort((a, b) => a - b);
        ctx.neighborForwardMedian = neighborForwards[Math.floor(neighborForwards.length / 2)];
      }
    }
  }

  _meanCenter(units) {
    let sx = 0, sz = 0, count = 0;
    for (const u of units) {
      if (u.isDefeated()) continue;
      const c = u.getCenter();
      sx += c.x;
      sz += c.z;
      count++;
    }
    if (count === 0) return { x: 0, z: 0 };
    return { x: sx / count, z: sz / count };
  }
}
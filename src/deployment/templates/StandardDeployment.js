// Standard line-of-battle deployment.
//
// Layout, from the enemy's perspective (looking at our army):
//
//     [A]   [A]   [A]   [A]         <- archers, front row, half-unit gaps between them
//   [Sw] [Sw] [Sp] [Sp] [Sp] [Sw]    <- spears centre, swords flanks
//   [Cav]                        [Cav]  <- cavalry split across both flanks
//
// Row depths are fractions of the zone's FRONT depth (see DeploymentConfig),
// so the formation's front edge always sits the same distance from the
// team's mean position regardless of how much extra back-room the zone has.
//
// Inter-unit spacing is computed at placement time from each unit's
// currentWidthUnits: the gap between two adjacent units is
// unitGapFactor × the smaller of the two widths. Spacing therefore scales
// with roster size automatically — a wide 5-column unit leaves a wider lane
// beside it than a narrow 3-column one, and a row never looks cramped or
// sparse depending on which units happen to be in it.
//
// Cavalry split evenly across both flanks. Each side forms a column that
// steps backward from the row's depth, spaced by cavalryColumnGapFactor —
// wider than the row spacing, so a flank reads as a distinct wing. When the
// cavalry count is odd, the extra unit goes to cavalryFlankSide.
//
// To add a new template: export an object with the same shape
// ({ id, name, computePlacements(units, zone, ctx) -> placements[] }) and
// register it with DeploymentPlanner. The planner handles zone sizing and
// template selection; templates own only the layout itself.
import { DeploymentConfig } from '../../config/DeploymentConfig.js';
import { isCavalry, isRanged } from '../../config/UnitClasses.js';
import { unitTypeOf } from '../../ai/behaviorUtils.js';

export const StandardDeployment = {
  id: 'standard',
  name: 'Standard Line',

  computePlacements(units, zone, ctx) {
    const alive = units.filter(u => !u.isDefeated());
    if (alive.length === 0) return [];

    // Sort each role group by each unit's INITIAL LATERAL POSITION in the
    // deployment zone's frame, not by unit id.
    //
    // The template's job is to arrange units into a line — it must not
    // shuffle which side of that line a unit sits on relative to where
    // the scenario placed it. Sorting by id can flip a pair of units
    // whenever id order doesn't match starting positions (e.g. sword-1
    // starts on the right, sword-2 on the left): the template then
    // teleports sword-1 left and sword-2 right, producing a scrambled
    // deployment that reads as the AI "moving the left unit to the right
    // and the right unit to the left".
    //
    // lateralOf returns signed distance along the zone's "right" axis —
    // larger value = further toward the team's own right. Ties are left
    // to Array.sort's stability, which preserves the array order units
    // were passed in.
    const lateralOf = (u) => {
      const c = u.getCenter();
      return zone.toLocal(c.x, c.z).lateral;
    };
    const byLateral = (a, b) => lateralOf(a) - lateralOf(b);

    const cavalry = [];
    const ranged = [];
    const spear = [];
    const sword = [];
    const other = [];

    for (const u of alive) {
      const t = unitTypeOf(u);
      if (!t) { other.push(u); continue; }
      if (isCavalry(t)) { cavalry.push(u); continue; }
      if (isRanged(t)) { ranged.push(u); continue; }
      if (t.weaponType === 'spear') { spear.push(u); continue; }
      if (t.weaponType === 'sword') { sword.push(u); continue; }
      other.push(u);
    }

    cavalry.sort(byLateral);
    ranged.sort(byLateral);
    spear.sort(byLateral);
    sword.sort(byLateral);
    other.sort(byLateral);

    // Swords split evenly between the two flanks of the spear block.
    const halfSwords = Math.floor(sword.length / 2);
    const leftSwords = sword.slice(0, halfSwords);
    const rightSwords = sword.slice(halfSwords);
    const lineRow = [...leftSwords, ...spear, ...rightSwords, ...other];

    // Depths are anchored to the zone's FRONT depth so adding back-room
    // never moves the formation. D is the reference scale for every row.
    const D = zone.frontDepth;
    const facing = Math.atan2(zone.forwardX, zone.forwardZ);

    const placements = [];

    // Cavalry sit at cavalryEdgeMargin beyond the widest row's edge, so
    // the wings are separated from the line by more than a row gap.
    const lineLayout = computeRowLayout(lineRow, zone);
    const archerLayout = computeRowLayout(ranged, zone);
    const flankLateral =
      Math.max(lineLayout.halfSpan, archerLayout.halfSpan) +
      DeploymentConfig.cavalryEdgeMargin;

    layoutRow(
      placements, ranged, zone, archerLayout,
      D * DeploymentConfig.archerDepthFactor,
      facing
    );

    layoutRow(
      placements, lineRow, zone, lineLayout,
      D * DeploymentConfig.lineDepthFactor,
      facing
    );

    // Split cavalry across both flanks. Preferred side takes the extra unit
    // on an odd count; both sides step backward from the same base depth,
    // so the two columns are mirror images of each other.
    // Cavalry are now sorted left-to-right by initial lateral position.
    // Split at the middle: leftmost half goes to the left flank,
    // rightmost half to the right flank. On an odd count the extra unit
    // goes to cavalryFlankSide (the "preferred" side) — same rule as the
    // previous id-based split, but expressed in terms of the lateral
    // split so a unit that started on the left flank stays on the left.
    const half = Math.floor(cavalry.length / 2);
    const odd = cavalry.length % 2 === 1;
    const preferredSideIsRight = DeploymentConfig.cavalryFlankSide === 1;

    const leftCount = (odd && !preferredSideIsRight) ? half + 1 : half;

    const leftCav = cavalry.slice(0, leftCount);
    const rightCav = cavalry.slice(leftCount);

    layoutCavalryFlank(
      placements, rightCav, zone, +1,
      flankLateral,
      D * DeploymentConfig.cavalryDepthFactor,
      facing
    );

    layoutCavalryFlank(
      placements, leftCav, zone, -1,
      flankLateral,
      D * DeploymentConfig.cavalryDepthFactor,
      facing
    );

    return placements;
  }
};

// Computes a row's layout once: per-unit offsets from the row's centre,
// and the row's half-span (centre to outermost unit's centre). If the row
// would overflow the zone's lateral extent, the GAP is shrunk (units keep
// their real widths) — a squeezed line reads as tight, not as overlapping.
//
// Shared by layoutRow (which uses offsets) and the flank placement (which
// needs halfSpan to know where the line actually ends).
function computeRowLayout(units, zone) {
  const n = units.length;
  if (n === 0) return { offsets: [], halfSpan: 0 };

  const widths = units.map(u => Math.max(u.currentWidthUnits || 3, 1));

  let sumWidths = 0;
  for (const w of widths) sumWidths += w;

  let sumMinWidths = 0;
  for (let i = 0; i < n - 1; i++) {
    sumMinWidths += Math.min(widths[i], widths[i + 1]);
  }

  const maxHalfLateral = Math.max(0, zone.halfLateral - DeploymentConfig.rowEdgeMargin);
  const maxSpan = maxHalfLateral * 2;

  let gapFactor = DeploymentConfig.unitGapFactor;
  if (n > 1 && sumMinWidths > 0) {
    const naturalSpan = sumWidths + gapFactor * sumMinWidths;
    if (naturalSpan > maxSpan) {
      gapFactor = Math.max(0, (maxSpan - sumWidths) / sumMinWidths);
    }
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

// Places each unit at (rowCentre + precomputed offset, depth). The row is
// already centred on lateral = 0 by computeRowLayout.
function layoutRow(placements, units, zone, layout, depth, facing) {
  const n = units.length;
  if (n === 0) return;

  for (let i = 0; i < n; i++) {
    const pos = zone.toWorldClamped(layout.offsets[i], depth);
    placements.push({ unit: units[i], x: pos.x, z: pos.z, facing });
  }
}

// Cavalry form a column along ONE flank, at the given lateral distance from
// centre. side is +1 (right) or -1 (left); flankLateral is the unsigned
// distance from the centreline. The first entry sits at baseDepth, and each
// subsequent entry steps further BACK by
//
//     width_i / 2 + cavalryColumnGapFactor × min(width_i, width_{i+1}) + width_{i+1} / 2
//
// so a wider cavalry unit gets a wider berth behind it. cavalryColumnGapFactor
// is intentionally independent of unitGapFactor — the flank wings can be
// spread wider than the line without disturbing row spacing.
function layoutCavalryFlank(placements, units, zone, side, flankLateral, baseDepth, facing) {
  const n = units.length;
  if (n === 0) return;

  const gapFactor = DeploymentConfig.cavalryColumnGapFactor;

  // Unit depth ≈ unit width (formations are roughly square). Approximation
  // is fine — the only thing it drives is how far apart the column entries
  // are, and being a little generous never hurts on an open flank.
  const widths = units.map(u => Math.max(u.currentWidthUnits || 3, 1));

  let depth = baseDepth;
  for (let i = 0; i < n; i++) {
    const lateral = side * flankLateral;
    const pos = zone.toWorldClamped(lateral, depth);
    placements.push({ unit: units[i], x: pos.x, z: pos.z, facing });

    if (i < n - 1) {
      const thisW = widths[i];
      const nextW = widths[i + 1];
      const gap = gapFactor * Math.min(thisW, nextW);
      depth -= thisW / 2 + gap + nextW / 2;
    }
  }
}
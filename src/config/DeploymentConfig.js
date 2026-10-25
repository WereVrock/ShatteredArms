// Tuning constants for the pre-battle deployment phase. Kept in config so
// the layout can be adjusted without touching placement logic, and so future
// deployment templates (refused flank, refused center, etc.) can share the
// zone-sizing constants while overriding their own row depths and spacings.
export const DeploymentConfig = {
  // --- Zone sizing ---
  // Zone is a rectangle centred on the team's spawn mean, oriented along the
  // line axis (forward = team mean -> enemy mean).
  //
  // Lateral extent (halfLateral) is deliberately MUCH wider than the
  // auto-formation needs: the template places a compact line in the centre,
  // and the extra lateral room is player-only maneuvering space.
  //
  // Depth is ASYMMETRIC: frontDepth extends toward the enemy, backDepth
  // extends away. The auto-formation is anchored to frontDepth (which
  // therefore acts as the "reference depth" for row placement), and
  // backDepth just provides extra room behind the line. Doubling backDepth
  // without touching frontDepth leaves the formation exactly where it was
  // and only grows the empty space behind it.
  minHalfLateral: 30,
  lateralPerUnit: 7.2,
  frontDepth: 9,
  backDepth: 18,

  // Multiplier on the spawn distance between the two teams' mean positions.
  // DeploymentPlanner._buildZone re-centers each team's zone along its
  // -forward axis so the two rectangles are separated by this multiple of
  // the original spacing — 1.5 pushes the deployable areas 1.5× further
  // apart. 1.0 reproduces the original behaviour (zones centred exactly on
  // each team's mean). Each team contributes half the extra gap, so the
  // shift is symmetric and neither side's front edge is favoured.
  // Units still spawn at their scenario positions; only the rectangle
  // they deploy inside moves.
  deploymentSeparationScale: 1.5,

  // --- Row depths (fraction of zone.frontDepth) ---
  // Positive = toward enemy (front), negative = behind (back).
  archerDepthFactor: 0.55,
  lineDepthFactor: -0.15,
  cavalryDepthFactor: -0.15,

  // --- Spacing ---
  // Gap between adjacent row units = unitGapFactor × the smaller of the two
  // neighbours' currentWidthUnits. 0.5 means each pair is separated by half
  // a unit's width. Unit widths come from Unit.currentWidthUnits at
  // placement time, so spacing scales with roster size automatically.
  unitGapFactor: 0.5,

  // --- Cavalry placement ---
  // Cavalry split evenly between the two flanks of the line, at the given
  // lateral distance beyond the widest row's edge. cavalryEdgeMargin is the
  // gap between the outermost row unit's edge and the innermost cavalry
  // column entry — larger here than a row gap so the two flanks read as
  // distinct wings, not as extensions of the line.
  //
  // cavalryColumnGapFactor controls spacing WITHIN each flank column,
  // independent of unitGapFactor so the column can be tuned wider or
  // tighter than the line without disturbing row spacing.
  //
  // cavalryFlankSide is the PREFERRED side: when the cavalry count is odd,
  // the odd unit goes to this flank (+1 = right, -1 = left). Even counts
  // split evenly, one half each side.
  cavalryEdgeMargin: 5.0,
  cavalryColumnGapFactor: 1.0,
  cavalryFlankSide: 1,

  // --- Edge margin for row units (keeps the outermost unit inside the zone) ---
  rowEdgeMargin: 0.75,

  // --- Zone visualisation ---
  playerZoneColor: 0x3a6ea5,
  enemyZoneColor: 0xa53a3a,
  zoneFillOpacity: 0.12,
  zoneOutlineOpacity: 0.7
};
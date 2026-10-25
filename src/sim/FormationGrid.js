// ===== FormationGrid.js =====
// Pure formation-grid geometry. No state, no soldiers, no world rotation:
// given a soldier count, a column count and a spacing, it returns each
// slot's local offset and rank. Unit uses it for the real layout and for
// the drag-preview ghost, so the two can never disagree.
//
// Local space matches Unit._applyFormationAt: x is lateral (left/right),
// z runs FORWARD toward the enemy. Row 0 is the BACK row; the last row is
// the FRONT row.
//
// Incomplete row rule: when count does not divide evenly by cols, the
// smaller row is placed at the BACK (row 0) and centered laterally behind
// the full rows. Every full row is in front of it, so the front line is
// always complete.
//
// Slots are returned in soldier index order: the first soldiers fill the
// back row, the last soldiers fill the front row.
export class FormationGrid {
  // Returns an array of { x, z, rank } with exactly `count` entries.
  // rank 0 = front rank, 1 = one behind it, and so on.
  static computeSlots(count, cols, spacing) {
    const slots = [];
    if (count <= 0) return slots;

    const safeCols = Math.max(1, Math.min(cols, count));
    const fullRows = Math.floor(count / safeCols);
    const remainder = count % safeCols;
    const totalRows = fullRows + (remainder > 0 ? 1 : 0);

    // Row lengths from back (index 0) to front.
    const rowLengths = [];
    if (remainder > 0) rowLengths.push(remainder);
    for (let i = 0; i < fullRows; i++) rowLengths.push(safeCols);

    for (let r = 0; r < totalRows; r++) {
      const rowLength = rowLengths[r];
      for (let c = 0; c < rowLength; c++) {
        slots.push({
          x: (c - (rowLength - 1) / 2) * spacing,
          z: r * spacing,
          rank: totalRows - 1 - r
        });
      }
    }
    return slots;
  }

  // Constrain a desired column count against a unit type's discipline
  // minimums. Returns the column count the formation is allowed to use
  // given `desiredCols`, `count` alive soldiers, and the type's discipline
  // tier (see CombatConfig.discipline).
  //
  // Rules, applied in order:
  //
  //   1. COLUMN FLOOR. cols may not be below minFormationCols. Capped by
  //      `count` so a 2-soldier remainder is not forced into 3 columns
  //      of which one is empty.
  //
  //   2. ROW FLOOR + NO STUB. Only when the unit is large enough to
  //      satisfy both minimums at once (count >= minCols * minRows). If
  //      the desired shape would produce fewer than minRows rows, OR
  //      would produce minRows+ rows but with a stub back row (fewer
  //      than half a full row), the column count is rebalanced to
  //      ceil(count / minRows) — the value that produces exactly
  //      minRows balanced rows.
  //
  // Extracted so Unit._constrainFormationCols, FormationFactory
  // .createGridUnit, and FormationFactory.createUnitWithCount all share
  // one implementation of the rule. The `config` argument is
  // CombatConfig; passed in rather than imported to keep this module
  // dependency-free (it is pure geometry today).
  static constrainColsForDiscipline(desiredCols, count, typeDef, config) {
    const n = Math.max(1, count);
    let cols = Math.max(1, Math.min(desiredCols, n));

    const disciplineKey = (typeDef && typeDef.discipline) || 'normal';
    const discCfg = config.discipline[disciplineKey]
      || config.discipline.normal;
    const minCols = discCfg.minFormationCols || 1;
    const minRows = discCfg.minFormationRows || 1;

    // Rule 1 — column floor.
    if (cols < minCols) cols = Math.min(n, minCols);

    // Rule 2 — row floor + no stub.
    if (minRows > 1 && n >= minCols * minRows) {
      // Stub check: any non-empty last row smaller than half a full row
      // counts as a stub. A last row of exactly minCols would otherwise
      // slip through (3 is not less than minCols 3), leaving low-
      // discipline units with a visibly stubby back row.
      const rowsNow = Math.ceil(n / cols);
      const remainder = n % cols;
      const hasStub = remainder > 0 && remainder * 2 < cols;
      if (rowsNow < minRows || hasStub) {
        cols = Math.min(n, Math.ceil(n / minRows));
        if (cols < minCols) cols = Math.min(n, minCols);
      }
    }

    return Math.max(1, Math.min(cols, n));
  }
}
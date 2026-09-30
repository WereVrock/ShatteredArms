import { Soldier } from './Soldier.js';
import { Unit } from './Unit.js';

// Builds a Unit with soldiers arranged in a grid formation. isUndead is set
// once on the Unit and passed down to every soldier — whole-unit trait, not
// a per-soldier random pick.
//
// Spacing: a unit type may declare formationSpacing (cavalry does, because
// mounts are longer than a footman's footprint). When present it overrides
// the caller's spacing argument, so every scenario builder gets the right
// grid without knowing about per-type spacing. Unit.getFormationSpacing
// reads the same field, so spawn positions and later re-layouts agree.
export class FormationFactory {
  static createGridUnit({ id, teamId, unitTypeDef, originX, originZ, facing, rows, cols, spacing: requestedSpacing, isUndead }) {
    const spacing = unitTypeDef.formationSpacing ?? requestedSpacing;
    const unit = new Unit({ id, teamId, formationFacing: facing, isUndead });

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = originX + (c - (cols - 1) / 2) * spacing;
        const z = originZ + r * spacing;
        const soldier = new Soldier({
          unitId: id,
          teamId,
          unitTypeDef,
          x,
          z,
          facing,
          isUndead
        });
        unit.addSoldier(soldier);
      }
    }

    unit.formationOrigin = { x: originX, z: originZ };
    unit.finalizeFormationOffsets(cols);

    return unit;
  }

  // Same grid-formation idea as createGridUnit, but for an arbitrary soldier
  // count that may not factor into a clean rows x cols rectangle. Rows are
  // built left-to-right, and the final row may be shorter — each row is
  // individually centred on its own width so the formation stays symmetric.
  // Used by the campaign to deploy depleted units at their surviving count.
  static createUnitWithCount({ id, teamId, unitTypeDef, originX, originZ, facing, count, spacing: requestedSpacing, isUndead }) {
    const spacing = unitTypeDef.formationSpacing ?? requestedSpacing;
    const unit = new Unit({ id, teamId, formationFacing: facing, isUndead });
    if (count <= 0) {
      unit.formationOrigin = { x: originX, z: originZ };
      return unit;
    }

    // Column count. A unit type may declare a preferred row count
    // (e.g. archers fight better in a wide, shallow line), in which case
    // cols = ceil(count / preferredRows) and the generic 5-wide cap is
    // lifted — an explicit preference overrides the square-ish default,
    // since a 2-row archer line of 12 is 6 wide and would otherwise be
    // clipped back to 5.
    let cols;
    if (unitTypeDef.preferredRows && unitTypeDef.preferredRows > 0) {
      cols = Math.max(1, Math.ceil(count / unitTypeDef.preferredRows));
    } else {
      cols = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(count * 1.6))));
    }
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);

    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const rowCount = Math.min(cols, count - r * cols);
      const localX = (c - (rowCount - 1) / 2) * spacing;
      const localZ = r * spacing;

      const rotatedX = localX * cos + localZ * sin;
      const rotatedZ = -localX * sin + localZ * cos;

      const soldier = new Soldier({
        unitId: id,
        teamId,
        unitTypeDef,
        x: originX + rotatedX,
        z: originZ + rotatedZ,
        facing,
        isUndead
      });
      soldier.formationOffset = { x: localX, z: localZ };
      unit.addSoldier(soldier);
    }

    unit.formationOrigin = { x: originX, z: originZ };
    // Record the column count so later shape-preserving operations
    // (Unit._applyExistingShape, called by every move/instant-move order,
    // including the ones issued by StandardDeployment) re-lay out the
    // soldiers as the same grid instead of collapsing them to the
    // constructor default of 1 column. See Unit.formationCols and
    // Unit._applyExistingShape.
    unit.formationCols = cols;
    unit.currentWidthUnits = cols * spacing;
    // Re-run the grid layout so the formationOffset values match what
    // _applyExistingShape will produce on the very next order. Both now
    // resolve to the same per-type spacing (Unit.getFormationSpacing).
    unit._layoutGrid(cols, spacing);
    return unit;
  }
}
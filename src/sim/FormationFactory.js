import { Soldier } from './Soldier.js';
import { Unit } from './Unit.js';
import { raceOf } from '../config/RaceConfig.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { FormationGrid } from './FormationGrid.js';

// Builds a Unit with soldiers arranged in a grid formation. isUndead is set
// once on the Unit and passed down to every soldier — whole-unit trait, not
// a per-soldier random pick.
//
// Spacing: a unit type may declare formationSpacing (cavalry does, because
// mounts are longer than a footman's footprint). When present it overrides
// the caller's spacing argument, so every scenario builder gets the right
// grid without knowing about per-type spacing. Unit.getFormationSpacing
// reads the same field, so spawn positions and later re-layouts agree.
//
// Race unit-size: a unit type's RACE may declare unitSizeMultiplier (see
// RaceConfig.js). When present, createGridUnit expands the rows x cols
// template to build a bigger unit — the scenario still declares a STANDARD
// size and the race does the rest. This is intentionally NOT applied by
// createUnitWithCount, where the caller passes an explicit surviving count
// (campaign path) and a multiplier would silently double it.
export class FormationFactory {
static createGridUnit({ id, teamId, unitTypeDef, originX, originZ, facing, rows, cols, spacing: requestedSpacing, isUndead }) {
    const spacing = unitTypeDef.formationSpacing ?? requestedSpacing;
    const unit = new Unit({ id, teamId, formationFacing: facing, isUndead });

    // Race unit-size multiplier. rows x cols is a STANDARD-size template —
    // "what a human unit of this archetype looks like". A race may build
    // larger units from the same template (goblins, unitSizeMultiplier
    // 2.0, build units with twice the soldiers). Applied by EXPANDING
    // COLUMNS first — rows are the formation's depth axis and the
    // scenario author chose that depth deliberately.
    //
    // The discipline clamp below then applies on top of the race
    // expansion: a low-discipline unit may be rebalanced so it is not
    // narrower than minFormationCols and not shallower than
    // minFormationRows, with no stub back row. The final column count
    // and the derived row count are what the placement loop below uses,
    // so a scenario-deployed unit starts in the shape it will fight in —
    // no post-deploy reformation.
    const sizeMult = raceOf(unitTypeDef).unitSizeMultiplier;
    const totalSoldiers = Math.max(1, Math.round(rows * cols * sizeMult));
    const baseCols = Math.max(1, Math.ceil(totalSoldiers / rows));

    const effectiveCols = FormationGrid.constrainColsForDiscipline(
      baseCols, totalSoldiers, unitTypeDef, CombatConfig
    );
    const effectiveRows = Math.ceil(totalSoldiers / effectiveCols);

    let placed = 0;
    for (let r = 0; r < effectiveRows && placed < totalSoldiers; r++) {
      const remaining = totalSoldiers - placed;
      const rowCols = Math.min(effectiveCols, remaining);
      for (let c = 0; c < rowCols; c++) {
        const x = originX + (c - (rowCols - 1) / 2) * spacing;
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
        placed++;
      }
    }

    unit.formationOrigin = { x: originX, z: originZ };
    unit.finalizeFormationOffsets(effectiveCols);

    return unit;
  }

  // Same grid-formation idea as createGridUnit, but for an arbitrary soldier
  // count that may not factor into a clean rows x cols rectangle. Rows are
  // built left-to-right, and the final row may be shorter — each row is
  // individually centred on its own width so the formation stays symmetric.
  // Used by the campaign to deploy depleted units at their surviving count.
  //
  // Does NOT apply the race unit-size multiplier: `count` here is an
  // explicit number (typically a surviving soldier count read back from the
  // extraction record) and doubling it would be wrong. A goblin unit
  // deployed at 30 survivors deploys with 30 goblins.
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
    // lifted. Otherwise the square-ish default applies.
    let baseCols;
    if (unitTypeDef.preferredRows && unitTypeDef.preferredRows > 0) {
      baseCols = Math.max(1, Math.ceil(count / unitTypeDef.preferredRows));
    } else {
      baseCols = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(count * 1.6))));
    }

    // Discipline clamp. Low-discipline units cannot be narrower than
    // minFormationCols or shallower than minFormationRows; when the row
    // floor applies, rows are rebalanced so there is no stub back row.
    // This overrides preferredRows — a low-discipline archer that
    // declares preferredRows: 2 is still widened to satisfy the row
    // floor. Same rule as the deployment path and the reshape path, so
    // scenario and campaign units deploy identically.
    const cols = FormationGrid.constrainColsForDiscipline(
      baseCols, count, unitTypeDef, CombatConfig
    );

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
    // finalizeFormationOffsets re-runs the clamp (idempotent — the
    // incoming cols are already clamped) and lays out the grid, setting
    // formationCols and currentWidthUnits. Using the shared method
    // rather than setting the fields manually keeps every caller on the
    // same code path.
    unit.finalizeFormationOffsets(cols);
    return unit;
  }
}
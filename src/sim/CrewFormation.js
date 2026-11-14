import { CombatConfig } from '../config/CombatConfig.js';
import { FormationGrid } from './FormationGrid.js';
import { FormationDisorder } from './FormationDisorder.js';
import { CrewPairing } from './CrewPairing.js';

// Formation layout of crew-served units (goblin megabowman). The grid is made
// of CELLS, not soldiers. A cell is one working pair: the shooter at the
// cell's slot and the carrier directly in front of it (CombatConfig.crew
// .pairGap ahead). An unpaired survivor takes a cell of its own.
//
// The unit type's formationSpacing is the CELL pitch (lateral distance between
// cells). Rows of cells are CombatConfig.crew.rowPitch apart. formationCols of
// a crew unit counts CELL columns.
//
// Both members of a cell share crewCellSeed and crewCellOffset; FormationDisorder
// uses them, so a pair wobbles as one body and cells never share a slot.
//
// Stateless. No side effects except writing formationOffset / formationRank /
// crewCellSeed / crewCellOffset in layout().

const SHOOTER = 'shooter';
const CARRIER = 'carrier';

function pairGap() {
  return CombatConfig.crew?.pairGap ?? 0.7;
}

function rowPitch() {
  return CombatConfig.crew?.rowPitch ?? 2.4;
}

// Groups soldiers into cells: pairs by their partner link, the rest alone.
function buildCells(soldiers) {
  const byId = new Map();
  for (let i = 0; i < soldiers.length; i++) byId.set(soldiers[i].id, soldiers[i]);

  const done = new Set();
  const cells = [];
  for (let i = 0; i < soldiers.length; i++) {
    const s = soldiers[i];
    if (done.has(s.id)) continue;
    done.add(s.id);

    let partner = null;
    if (s.crewPartnerId !== null && s.crewPartnerId !== undefined) {
      const p = byId.get(s.crewPartnerId);
      if (p && !done.has(p.id) && p.crewPartnerId === s.id && p.crewRole !== s.crewRole) {
        partner = p;
      }
    }

    if (partner) {
      done.add(partner.id);
      cells.push(s.crewRole === CARRIER
        ? { carrier: s, shooter: partner }
        : { carrier: partner, shooter: s });
    } else if (s.crewRole === CARRIER) {
      cells.push({ carrier: s, shooter: null });
    } else {
      cells.push({ carrier: null, shooter: s });
    }
  }
  return cells;
}

// Local slot of every cell (x lateral, z forward, rank 0 = front row), in
// FormationGrid order (back row first). `pitch` is the cell pitch.
function cellSlots(cellCount, cols, pitch) {
  const base = FormationGrid.computeSlots(cellCount, cols, pitch);
  let maxRank = 0;
  for (let i = 0; i < base.length; i++) if (base[i].rank > maxRank) maxRank = base[i].rank;
  const rp = rowPitch();
  return base.map(b => ({ x: b.x, z: (maxRank - b.rank) * rp, rank: b.rank }));
}

// Reorders cells so each lands on the slot on its own side of the
// formation: cells are sorted back to front in the formation frame, cut into
// the slots' row lengths, and sorted left to right inside each row.
function orderCells(unit, cells, slots) {
  const ax = unit.formationMarchOrigin.x;
  const az = unit.formationMarchOrigin.z;
  const cos = Math.cos(unit.formationFacing);
  const sin = Math.sin(unit.formationFacing);

  const keyed = cells.map((cell) => {
    const members = [];
    if (cell.shooter) members.push(cell.shooter);
    if (cell.carrier) members.push(cell.carrier);
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < members.length; i++) {
      mx += members[i].pos.x;
      mz += members[i].pos.z;
    }
    mx = mx / members.length - ax;
    mz = mz / members.length - az;
    return { cell, lx: mx * cos - mz * sin, lz: mx * sin + mz * cos };
  });
  keyed.sort((a, b) => a.lz - b.lz);

  const out = [];
  let i = 0;
  let s = 0;
  while (s < slots.length) {
    let e = s;
    while (e < slots.length && slots[e].z === slots[s].z) e++;
    const row = keyed.slice(i, i + (e - s));
    row.sort((a, b) => a.lx - b.lx);
    for (let k = 0; k < row.length; k++) out.push(row[k].cell);
    i += e - s;
    s = e;
  }
  return out;
}

function place(s, x, z, rank, seed, cellX, cellZ) {
  s.formationOffset = { x, z };
  s.formationRank = rank;
  s.crewCellSeed = seed;
  s.crewCellOffset = { x: cellX, z: cellZ };
  s._disciplineJitter = undefined;
}

export const CrewFormation = {
  // Number of cells the given soldiers form.
  cellCount(soldiers) {
    for (let i = 0; i < soldiers.length; i++) {
      if (soldiers[i].crewRole === null || soldiers[i].crewRole === undefined) {
        return Math.ceil(soldiers.length / 2);
      }
    }
    return buildCells(soldiers).length;
  },

  // Column count (of cells) for a fresh unit of `count` soldiers.
  columnsForCount(count, typeDef) {
    const cells = Math.max(1, Math.ceil(count / 2));
    let baseCols;
    if (typeDef.preferredRows && typeDef.preferredRows > 0) {
      // preferredRows counts SOLDIER rows; a cell is two of them.
      const cellRows = Math.max(1, Math.round(typeDef.preferredRows / 2));
      baseCols = Math.max(1, Math.ceil(cells / cellRows));
    } else {
      baseCols = Math.max(1, Math.ceil(Math.sqrt(cells * 1.6)));
    }
    return FormationGrid.constrainColsForDiscipline(baseCols, cells, typeDef, CombatConfig);
  },

  // Front row to back row distance. (Third argument, the cell pitch, is not
  // needed here; callers may still pass it.)
  depth(cells, cols) {
    const rows = Math.ceil(Math.max(1, cells) / Math.max(1, cols));
    return (rows - 1) * rowPitch() + pairGap();
  },

  // Writes formationOffset / formationRank of every soldier.
  //   mode 'index': cells fill the slots in order (deployment, reshape).
  //   mode 'world': cells keep their side of the formation (orders).
  // Soldiers without a role are paired by index first. `spacing` is the cell
  // pitch (the unit type's formationSpacing).
  layout(unit, soldiers, cols, spacing, mode) {
    for (let i = 0; i < soldiers.length; i++) {
      if (soldiers[i].crewRole === null || soldiers[i].crewRole === undefined) {
        CrewPairing.assignByIndex(soldiers);
        break;
      }
    }

    let cells = buildCells(soldiers);
    const slots = cellSlots(cells.length, cols, spacing);
    if (mode === 'world') cells = orderCells(unit, cells, slots);

    const gap = pairGap();
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const slot = slots[i];
      const seed = (cell.shooter || cell.carrier).id;
      if (cell.shooter) {
        place(cell.shooter, slot.x, slot.z, 2 * slot.rank + (cell.carrier ? 1 : 0),
          seed, slot.x, slot.z);
      }
      if (cell.carrier) {
        place(cell.carrier, slot.x, slot.z + (cell.shooter ? gap : 0), 2 * slot.rank,
          seed, slot.x, slot.z);
      }
    }
  },

  // World slots for the drag ghost, one per soldier. Both members of a cell
  // get the same disorder offset, so the ghost shows pairs, not loose men.
  previewSlots(alive, cols, spacing, disorderCtx, x, z, facing) {
    const cells = buildCells(alive);
    const slots = cellSlots(cells.length, cols, spacing);
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    const gap = pairGap();
    const out = [];

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const slot = slots[i];
      const seed = (cell.shooter || cell.carrier).id;
      const dis = FormationDisorder.offsetFor(disorderCtx, seed, slot.x, slot.z);
      const add = (localX, localZ, role) => {
        out.push({
          x: x + localX * cos + localZ * sin,
          z: z + (-localX * sin + localZ * cos),
          role
        });
      };
      if (cell.shooter) add(slot.x + dis.x, slot.z + dis.z, SHOOTER);
      if (cell.carrier) {
        add(slot.x + dis.x, slot.z + dis.z + (cell.shooter ? gap : 0), CARRIER);
      }
    }
    return out;
  }
};
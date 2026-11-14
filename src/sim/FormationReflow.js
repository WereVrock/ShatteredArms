// Pure slot assignment for re-laying out a formation without shuffling it.
//
// Given the soldiers (each with a current local formationOffset) and the
// target slot list from FormationGrid.computeSlots, this decides which
// soldier takes which slot:
//   1. A soldier whose current offset is already a slot in the new grid
//      keeps it. Nothing moves for soldiers whose position is still valid.
//   2. Every remaining soldier is matched to a remaining free slot by
//      shortest distance (greedy, closest pair first), so a gap is filled
//      by the nearest soldier that lost its slot.
//
// Writes formationOffset and formationRank on the soldiers. soldiers.length
// must equal slots.length.
export class FormationReflow {
  static assign(soldiers, slots) {
    const n = soldiers.length;
    if (n === 0 || slots.length !== n) return;

    const keyOf = (x, z) => Math.round(x * 100) + ',' + Math.round(z * 100);

    const slotIndexByKey = new Map();
    for (let j = 0; j < n; j++) {
      slotIndexByKey.set(keyOf(slots[j].x, slots[j].z), j);
    }

    const slotTaken = new Array(n).fill(false);
    const unmatched = [];

    for (const soldier of soldiers) {
      const off = soldier.formationOffset;
      const j = slotIndexByKey.get(keyOf(off.x, off.z));
      if (j !== undefined && !slotTaken[j]) {
        slotTaken[j] = true;
        soldier.formationRank = slots[j].rank;
      } else {
        unmatched.push(soldier);
      }
    }

    if (unmatched.length === 0) return;

    const freeSlotIndices = [];
    for (let j = 0; j < n; j++) {
      if (!slotTaken[j]) freeSlotIndices.push(j);
    }

    const pairs = [];
    for (let a = 0; a < unmatched.length; a++) {
      const off = unmatched[a].formationOffset;
      for (let b = 0; b < freeSlotIndices.length; b++) {
        const slot = slots[freeSlotIndices[b]];
        const dx = slot.x - off.x;
        const dz = slot.z - off.z;
        pairs.push({ a, b, d: dx * dx + dz * dz });
      }
    }
    pairs.sort((p, q) => p.d - q.d);

    const soldierDone = new Array(unmatched.length).fill(false);
    const slotDone = new Array(freeSlotIndices.length).fill(false);

    for (const pair of pairs) {
      if (soldierDone[pair.a] || slotDone[pair.b]) continue;
      soldierDone[pair.a] = true;
      slotDone[pair.b] = true;
      const slot = slots[freeSlotIndices[pair.b]];
      unmatched[pair.a].formationOffset = { x: slot.x, z: slot.z };
      unmatched[pair.a].formationRank = slot.rank;
    }
  }

  // World-position matching. Each soldier is paired with the new slot
  // nearest to his CURRENT world position, with ties broken to preserve
  // world-space ordering along both axes.
  //
  // Why this differs from assign(): assign() matches by local
  // formationOffset, which means a soldier "keeps his slot" across a
  // facing change — but his slot's world position ROTATES with the
  // formation, so keeping the local offset forces him to walk to a new
  // world position. On a 180° turn of a multi-row formation the soldiers
  // on the west end swap world sides with the soldiers on the east end
  // and walk straight through each other. Matching by world position
  // instead pairs each soldier with the slot that is nearest to where he
  // already is, so:
  //
  //   - rotate-in-place: every soldier keeps his world position and gets
  //     a new local offset reflecting the new facing. Zero movement.
  //   - translate-and-rotate: each soldier walks a straight line to the
  //     new slot on HIS world side; no crossing.
  //   - translate without rotation: unchanged from assign(), since each
  //     soldier's nearest new slot under an unrotated shape is the same
  //     slot assign() would have picked.
  //
  // `anchor` and `facing` describe the NEW formation frame: slot world
  // positions are computed as anchor + rotate(slotLocal, facing). The
  // anchor is expected to be the position of the formation's BACK row
  // (local z = 0), matching FormationGrid.computeSlots' convention.
  //
  // Sorting by (world x, world z) and matching in order is a 1-D
  // approximation of the optimal 2-D assignment. For the collinear and
  // grid formations this codebase produces, it is exact. It is
  // deterministic (ties broken by soldier id / slot order) so replays
  // are stable.
// Pairs soldiers with slots without letting anyone cross. Positions are
  // projected onto the NEW formation frame (lateral = local +x, forward =
  // local +z). Soldiers are sorted front to back, cut into rows of the same
  // lengths as the slot rows (back row first, so a short remainder row gets the
  // rearmost soldiers), and sorted left to right inside each row. The result
  // is deterministic (ties break on soldier id).
  //
  // Works for any change of facing or translation, unlike a sort by world X,
  // which crosses soldiers whenever the unit turns. The anchor is not needed
  // (matching only uses relative order) and is kept for call compatibility.
  static assignByWorldPosition(soldiers, slots, anchor, facing) {
    const n = soldiers.length;
    if (n === 0 || slots.length !== n) return;

    const cos = Math.cos(facing);
    const sin = Math.sin(facing);

    // Slots ordered by row (local z), then left to right (local x).
    const slotOrder = new Array(n);
    for (let j = 0; j < n; j++) slotOrder[j] = j;
    slotOrder.sort((a, b) =>
      (slots[a].z - slots[b].z) || (slots[a].x - slots[b].x) || (a - b)
    );

    // Soldier coordinates in the new frame. Same axes as Unit._applyFormationAt:
    // lateral (cos, -sin), forward (sin, cos).
    const fw = new Float64Array(n);
    const lt = new Float64Array(n);
    const idx = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = soldiers[i].pos;
      fw[i] = p.x * sin + p.z * cos;
      lt[i] = p.x * cos - p.z * sin;
      idx[i] = i;
    }
    idx.sort((a, b) =>
      (fw[a] - fw[b]) || (lt[a] - lt[b]) || (soldiers[a].id - soldiers[b].id)
    );

    let start = 0;
    while (start < n) {
      const rowZ = slots[slotOrder[start]].z;
      let end = start + 1;
      while (end < n && slots[slotOrder[end]].z === rowZ) end++;

      const row = idx.slice(start, end);
      row.sort((a, b) => (lt[a] - lt[b]) || (soldiers[a].id - soldiers[b].id));

      for (let k = 0; k < row.length; k++) {
        const soldier = soldiers[row[k]];
        const slot = slots[slotOrder[start + k]];
        soldier.formationOffset = { x: slot.x, z: slot.z };
        soldier.formationRank = slot.rank;
      }
      start = end;
    }
  }
}
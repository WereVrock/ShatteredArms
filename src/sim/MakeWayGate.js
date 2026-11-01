import { CombatConfig } from '../config/CombatConfig.js';
import { PROXIMITY_GATES_ENABLED } from './ProximityMap.js';

// A pusher may be nudged by an earlier yielder in the same make-way pass,
// so its position can drift a little from where the gate saw it. The cell
// size carries this slack on top of the scan radius, which keeps the gate
// a strict superset of what the real scan would accept.
const PUSHER_DRIFT_SLACK = 0.5;

// Cheap pre-filter for MovementSystem._applyMakeWay.
//
// A yielder only reacts to a same-team soldier from a DIFFERENT unit that is
// walking (speed above makeWay.incomingSpeedThreshold, not routing,
// shattered or knocked down) within makeWay.radius. build() marks, per team,
// the 3x3 cell neighbourhood of every such potential pusher with the
// pusher's unit; mayHavePusher() then answers in O(1) whether a yielder has
// any other-unit pusher near enough to be worth the full neighbour scan.
// A "false" means the scan could only have found nothing.
export class MakeWayGate {
  constructor(bounds = CombatConfig.mapBounds) {
    this._cellSize = CombatConfig.makeWay.radius + PUSHER_DRIFT_SLACK;
    this._inv = 1 / this._cellSize;
    this._minX = bounds.minX;
    this._minZ = bounds.minZ;
    this._cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) * this._inv));
    this._rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) * this._inv));
    this._cellCount = this._cols * this._rows;

    // teamId -> { unit: Int32Array, mixed: Uint8Array }
    //   unit[cell]  = index of the first pusher unit marked here (0 = none)
    //   mixed[cell] = 1 once pushers of two different units are marked here
    this._teams = new Map();
    this._unitIndexById = new Map();
  }

  // Call after the main movement loop, once currentSpeed is final.
  build(allSoldiers) {
    for (const team of this._teams.values()) {
      team.unit.fill(0);
      team.mixed.fill(0);
    }

    const minSpeed = CombatConfig.makeWay.incomingSpeedThreshold;
    const cols = this._cols;
    const rows = this._rows;
    let lastTeamId = null;
    let team = null;
    let lastUnitId = null;
    let unitIdx = 0;

    for (let i = 0; i < allSoldiers.length; i++) {
      const s = allSoldiers[i];
      if (s.currentSpeed < minSpeed) continue;
      if (!s.isAlive()) continue;
      const st = s.state;
      if (st === 'routing' || st === 'shattered' || st === 'knockedDown') continue;

      if (team === null || s.teamId !== lastTeamId) {
        lastTeamId = s.teamId;
        team = this._teamFor(s.teamId);
      }
      if (s.unitId !== lastUnitId) {
        lastUnitId = s.unitId;
        unitIdx = this._unitIndexFor(s.unitId);
      }

      const col = this._colOf(s.pos.x);
      const row = this._rowOf(s.pos.z);
      const c0 = col > 0 ? col - 1 : 0;
      const c1 = col < cols - 1 ? col + 1 : cols - 1;
      const r0 = row > 0 ? row - 1 : 0;
      const r1 = row < rows - 1 ? row + 1 : rows - 1;

      const marks = team.unit;
      const mixed = team.mixed;
      for (let r = r0; r <= r1; r++) {
        const base = r * cols;
        for (let c = c0; c <= c1; c++) {
          const idx = base + c;
          const m = marks[idx];
          if (m === 0) marks[idx] = unitIdx;
          else if (m !== unitIdx) mixed[idx] = 1;
        }
      }
    }
  }

  // False only when no pusher of another unit (same team) can be within
  // makeWay.radius of this yielder.
  mayHavePusher(yielder) {
    if (!PROXIMITY_GATES_ENABLED) return true;
    const team = this._teams.get(yielder.teamId);
    if (team === undefined) return false;

    const cell = this._rowOf(yielder.pos.z) * this._cols + this._colOf(yielder.pos.x);
    const mark = team.unit[cell];
    if (mark === 0) return false;
    if (team.mixed[cell] === 1) return true;
    return mark !== this._unitIndexById.get(yielder.unitId);
  }

  _teamFor(teamId) {
    let team = this._teams.get(teamId);
    if (team === undefined) {
      team = {
        unit: new Int32Array(this._cellCount),
        mixed: new Uint8Array(this._cellCount)
      };
      this._teams.set(teamId, team);
    }
    return team;
  }

  _unitIndexFor(unitId) {
    let idx = this._unitIndexById.get(unitId);
    if (idx === undefined) {
      idx = this._unitIndexById.size + 1;
      this._unitIndexById.set(unitId, idx);
    }
    return idx;
  }

  _colOf(x) {
    const v = (x - this._minX) * this._inv;
    if (!(v > 0)) return 0;
    if (v >= this._cols) return this._cols - 1;
    return v | 0;
  }

  _rowOf(z) {
    const v = (z - this._minZ) * this._inv;
    if (!(v > 0)) return 0;
    if (v >= this._rows) return this._rows - 1;
    return v | 0;
  }
}
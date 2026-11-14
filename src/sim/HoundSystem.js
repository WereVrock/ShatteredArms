import { CombatConfig } from '../config/CombatConfig.js';
import { HoundPack } from './HoundPack.js';

// Per-tick behaviour of goblin hounds (unit.companions, see HoundPack).
// Runs after the spatial grid is rebuilt and BEFORE TargetingSystem, which
// skips hounds entirely (unitTypeDef.beast). The only things written here
// are the hound's state, targetId, formationSlot, houndWaypoint and
// gaitRunning; movement, facing, contact attacks and melee resolution are
// the normal systems.
//
// Modes (soldier.houndMode):
//   leashed   - stands beside its owner (or follows another hound, see
//               HoundPack.anchorFor); walks with the unit, runs when the unit
//               runs or when it falls behind. Leashed hounds are released
//               automatically at an enemy that fights the unit at close range
//               (see _autoUnleash).
//   attacking - sent at an enemy unit. ALWAYS runs. Circles round to the
//               target's flank or rear when the way is free (houndWaypoint,
//               read by MovementSystem), then runs at it and fights it.
//               Nobody steers it. Returns to its owner when the target unit
//               is gone, or when recalled.
//   rogue     - every handler is dead: runs in one random direction,
//               attacking any soldier close by (friendlies included), and
//               leaves through the map edge.

const _slot = { x: 0, z: 0 };
const DEG = Math.PI / 180;

function normAngle(a) {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

export class HoundSystem {
  constructor(spatialGrid) {
    this.spatialGrid = spatialGrid;
    this._buf = [];
    this._tick = 0;
    this._wp = { x: 0, z: 0 };
  }

  update(units, unitsById, soldiersById) {
    this._tick++;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.companions.length === 0 || unit.companionKind === 'chargob') continue;
      this._updateUnit(unit, unitsById, soldiersById);
    }
  }

  _updateUnit(unit, unitsById, byId) {
    const perHandler = unit.soldiers[0]?.unitTypeDef.hounds?.perHandler ?? 1;
    const handlersAlive = unit.getAliveCount() > 0;

    if (unit.houndAutoSuppress > 0) {
      unit.houndAutoSuppress--;
    } else if (handlersAlive && !unit.leavingBattle && (this._tick % 3) === 0) {
      this._autoUnleash(unit, unitsById, byId);
    }

    for (const hound of unit.companions) {
      if (!hound.isAlive()) continue;
      const st = hound.state;
      if (st === 'routing' || st === 'shattered' || st === 'knockedDown' || st === 'staggered') continue;
      if (hound.airborneTicksLeft > 0) continue;

      if (!handlersAlive) {
        this._rogue(hound);
        continue;
      }
      if (hound.houndMode === 'attacking' && this._attack(hound, unitsById, byId)) continue;
      this._leash(hound, unit, perHandler, byId);
    }
  }

  // Releases the leashed hounds at an enemy unit that fights the unit at
  // close range: a handler in melee, or an enemy near a leashed hound.
  _autoUnleash(unit, unitsById, byId) {
    const cfg = CombatConfig.hound;
    const companions = unit.companions;
    let leashed = false;
    for (let i = 0; i < companions.length; i++) {
      if (companions[i].isAlive() && companions[i].houndMode === 'leashed') { leashed = true; break; }
    }
    if (!leashed) return;

    const soldiers = unit.soldiers;
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s.isAlive() || s.state !== 'engaged' || s.targetId === null) continue;
      const t = byId.get(s.targetId);
      if (t && t.isAlive() && t.teamId !== unit.teamId) {
        unit.unleashHounds(t.unitId);
        return;
      }
    }

    const r2 = cfg.autoUnleashRadius * cfg.autoUnleashRadius;
    const cells = Math.ceil(cfg.autoUnleashRadius / this.spatialGrid.cellSize);
    for (let i = 0; i < companions.length; i++) {
      const h = companions[i];
      if (!h.isAlive() || h.houndMode !== 'leashed') continue;
      const near = this.spatialGrid.queryNearbyIntoExcludingTeam(
        this._buf, h.pos.x, h.pos.z, cells, h.teamId);
      let best = null;
      let bestD = r2;
      for (let k = 0; k < near.length; k++) {
        const o = near[k];
        if (!o.isAlive()) continue;
        const dx = o.pos.x - h.pos.x;
        const dz = o.pos.z - h.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = o; }
      }
      if (best) {
        const enemyUnit = unitsById.get(best.unitId);
        if (enemyUnit && !enemyUnit.isDefeated()) {
          unit.unleashHounds(enemyUnit.id);
          return;
        }
      }
    }
  }

  // Returns true when the hound is (still) attacking.
  _attack(hound, unitsById, byId) {
    const targetUnit = unitsById.get(hound.houndTargetUnitId);
    if (!targetUnit || targetUnit.isDefeated()) {
      this._stopAttack(hound);
      return false;
    }

    let target = hound.targetId !== null ? byId.get(hound.targetId) : null;
    if (!target || !target.isAlive() || target.unitId !== targetUnit.id) {
      target = this._nearestOf(hound, targetUnit);
    }
    if (!target) {
      this._stopAttack(hound);
      return false;
    }

    hound.targetId = target.id;
    hound.gaitRunning = true;

    if (hound.houndFlankTarget !== target.id) {
      hound.houndFlankTarget = target.id;
      hound.houndFlankDone = false;
      hound.houndFlankSide = 0;
      hound.houndFlankTicks = 0;
      hound.houndWaypoint = null;
    }

    const dx = target.pos.x - hound.pos.x;
    const dz = target.pos.z - hound.pos.z;
    const d2 = dx * dx + dz * dz;
    const engage = CombatConfig.engagementRange;

    if (d2 <= engage * engage) {
      hound.houndWaypoint = null;
      hound.state = 'engaged';
      return true;
    }

    if (!hound.houndFlankDone) this._planFlank(hound, target, d2);

    // While circling, the hound is 'marching' toward its waypoint (it still
    // bites whatever it brushes past); otherwise it runs at its target.
    hound.state = hound.houndWaypoint ? 'marching' : 'impetuous';
    return true;
  }

  _stopAttack(hound) {
    hound.houndMode = 'leashed';
    hound.houndTargetUnitId = null;
    hound.targetId = null;
    hound.houndWaypoint = null;
    hound.houndFlankTarget = null;
  }

  _finishFlank(hound) {
    hound.houndFlankDone = true;
    hound.houndWaypoint = null;
  }

  // Decides whether the hound circles round and, if so, where to.
  _planFlank(hound, target, d2) {
    const cfg = CombatConfig.hound;
    hound.houndFlankTicks++;
    if (hound.houndFlankTicks > cfg.flankMaxTicks ||
        d2 < cfg.flankCommitDistance * cfg.flankCommitDistance) {
      this._finishFlank(hound);
      return;
    }

    // Already on the flank or behind the target: just attack.
    const toHound = Math.atan2(hound.pos.x - target.pos.x, hound.pos.z - target.pos.z);
    const diff = normAngle(toHound - target.facing);
    if (Math.abs(diff) >= cfg.flankMinAngleDeg * DEG) {
      this._finishFlank(hound);
      return;
    }

    if (hound.houndFlankSide === 0 || ((this._tick + hound.id) % cfg.flankRecheckTicks) === 0) {
      const pref = diff >= 0 ? 1 : -1;
      let side = 0;
      if (this._wpClear(hound, target, pref)) side = pref;
      else if (this._wpClear(hound, target, -pref)) side = -pref;
      if (side === 0) {
        // Other enemies in the way: no flanking, a frontal attack instead.
        this._finishFlank(hound);
        return;
      }
      hound.houndFlankSide = side;
    }

    const wp = this._wpPoint(target, hound.houndFlankSide);
    const wx = wp.x - hound.pos.x;
    const wz = wp.z - hound.pos.z;
    if (wx * wx + wz * wz < cfg.flankReach * cfg.flankReach) {
      this._finishFlank(hound);
      return;
    }
    if (!hound.houndWaypoint) hound.houndWaypoint = { x: 0, z: 0 };
    hound.houndWaypoint.x = wp.x;
    hound.houndWaypoint.z = wp.z;
  }

  // Point beside / behind the target on the given side (+1 / -1).
  _wpPoint(target, side) {
    const a = target.facing + side * 135 * DEG;
    this._wp.x = target.pos.x + Math.sin(a) * CombatConfig.hound.flankRadius;
    this._wp.z = target.pos.z + Math.cos(a) * CombatConfig.hound.flankRadius;
    return this._wp;
  }

  // True when no enemy other than the target stands on the way to the
  // waypoint or at it.
  _wpClear(hound, target, side) {
    const cfg = CombatConfig.hound;
    const wp = this._wpPoint(target, side);
    const wx = wp.x;
    const wz = wp.z;
    const r2 = cfg.flankClearRadius * cfg.flankClearRadius;
    const fractions = [0.33, 0.66, 1];

    for (let f = 0; f < fractions.length; f++) {
      const t = fractions[f];
      const x = hound.pos.x + (wx - hound.pos.x) * t;
      const z = hound.pos.z + (wz - hound.pos.z) * t;
      const near = this.spatialGrid.queryNearbyIntoExcludingTeam(
        this._buf, x, z, 1, hound.teamId);
      for (let i = 0; i < near.length; i++) {
        const o = near[i];
        if (!o.isAlive() || o.id === target.id) continue;
        const dx = o.pos.x - x;
        const dz = o.pos.z - z;
        if (dx * dx + dz * dz < r2) return false;
      }
    }
    return true;
  }

  _nearestOf(hound, unit) {
    const list = unit.getAliveSoldiers();
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const dx = list[i].pos.x - hound.pos.x;
      const dz = list[i].pos.z - hound.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    return best;
  }

  _leash(hound, unit, perHandler, byId) {
    const cfg = CombatConfig.hound;
    hound.houndMode = 'leashed';
    hound.targetId = null;
    hound.houndWaypoint = null;
    hound.houndFlankTarget = null;

    const anchor = HoundPack.anchorFor(hound, unit, byId);
    if (anchor === null) {
      this._rogue(hound);
      return;
    }

    HoundPack.slotAround(anchor, hound, perHandler, unit.formationFacing, _slot);
    hound.formationSlot.x = _slot.x;
    hound.formationSlot.z = _slot.z;

    const dx = _slot.x - hound.pos.x;
    const dz = _slot.z - hound.pos.z;
    // Runs with a running unit, and to catch up when it falls behind.
    hound.gaitRunning = unit.gaitRunning === true
      || (dx * dx + dz * dz) > cfg.catchUpDistance * cfg.catchUpDistance;

    if (hound.state === 'engaged' || hound.state === 'impetuous' || hound.state === 'marching') {
      hound.state = 'idle';
    }
  }

  _rogue(hound) {
    const cfg = CombatConfig.hound;
    hound.houndMode = 'rogue';
    hound.gaitRunning = true;
    hound.houndWaypoint = null;

    if (!hound.houndRogueDir) {
      const a = Math.random() * Math.PI * 2;
      hound.houndRogueDir = { x: Math.sin(a), z: Math.cos(a) };
    }
    const dir = hound.houndRogueDir;

    // Leaving through the map edge.
    const b = CombatConfig.mapBounds;
    const m = cfg.rogueEdgeMargin;
    if (hound.pos.x < b.minX + m || hound.pos.x > b.maxX - m ||
        hound.pos.z < b.minZ + m || hound.pos.z > b.maxZ - m) {
      hound.state = 'shattered';
      hound.targetId = null;
      hound.fleeDirection = { x: dir.x, z: dir.z };
      return;
    }

    // Bites the nearest soldier of ANY team close by.
    const candidates = this.spatialGrid.queryNearbyInto(this._buf, hound.pos.x, hound.pos.z, 1);
    const r2 = cfg.rogueVictimRadius * cfg.rogueVictimRadius;
    const engage2 = CombatConfig.engagementRange * CombatConfig.engagementRange;
    let best = null;
    let bestD = r2;
    for (let i = 0; i < candidates.length; i++) {
      const o = candidates[i];
      if (o === hound || !o.isAlive()) continue;
      const dx = o.pos.x - hound.pos.x;
      const dz = o.pos.z - hound.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = o; }
    }

    if (best) {
      hound.targetId = best.id;
      hound.state = bestD <= engage2 ? 'engaged' : 'impetuous';
      return;
    }

    hound.targetId = null;
    hound.formationSlot.x = hound.pos.x + dir.x * 8;
    hound.formationSlot.z = hound.pos.z + dir.z * 8;
    hound.state = 'idle';
  }
}
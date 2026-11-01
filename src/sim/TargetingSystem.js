import { CombatConfig } from '../config/CombatConfig.js';
import { unitHasClass, UnitClass, getRangedRange } from '../config/UnitClasses.js';

// Assigns nearest-enemy targets. Soldiers in their post-order disengage grace
// period are skipped entirely (can't be re-engaged) so a player order to pull
// out of combat actually works instead of being overridden one tick later.
//
// Cohesion: a soldier with no enemy of their own rallies onto the enemy that
// their NEAREST engaged unit-mate is fighting, so idle soldiers join the fight
// instead of watching from their formation slot.
//
// Focus: if the unit has focusTargetUnitId (set by a right-click attack order
// on an enemy unit), every soldier prefers the nearest alive soldier of that
// enemy unit as their target — the whole unit chases.
export class TargetingSystem {
  constructor(spatialGrid) {
    this.spatialGrid = spatialGrid;

    // Reusable candidate buffer for _findNearestEnemy. Every soldier calls
    // the search once per tick, so allocating a fresh array per query
    // (2000 arrays/tick) is exactly the kind of churn that causes the
    // multi-frame GC pauses visible in the frame diagnostic (raf=60-90ms).
    // The grid clears this in place; the search never holds it past the
    // function return.
    this._candidates = [];

    // Cooldown applied when a marching soldier's scan returns null. During
    // the approach phase the nearby grid is ~200 ALLIED soldiers per soldier
    // (the formation is packed together), all filtered by teamId, so every
    // tick burns ~400k comparisons on teammates to find nothing. Skipping
    // the scan for a few ticks after a null result makes the march phase
    // almost free, while keeping re-acquisition fast (0.33s max at 15Hz)
    // whenever an enemy actually enters the search radius.
    //
    // IMPORTANT: this is a behaviour change. A target that enters a marching
    // soldier's search radius is picked up on the next scan tick, up to
    // MARCH_NULL_COOLDOWN_TICKS after it appeared. At 5 ticks (0.33s), a
    // soldier moving at speed 5 sees an enemy ~1.7 world units later than
    // before. If you want zero behaviour change, set this to 1.
    this._marchNullCooldownTicks = 5;
  }

  update(allSoldiers, unitsById) {
    const byId = new Map(allSoldiers.map(s => [s.id, s]));
    const allyBeaconsByUnit = this._buildAllyRallyBeacons(allSoldiers, byId);

    for (const soldier of allSoldiers) {
      if (!soldier.isAlive()) continue;

      soldier.rallyTargetId = null;

      if (soldier.state === 'staggered' || soldier.state === 'engaged' || soldier.state === 'knockedDown') continue;

      // Routing and shattered soldiers are fleeing, not fighting — no
      // target acquisition, no rally. Routing soldiers can be pulled out
      // by MoraleSystem (rally); shattered soldiers cannot, and will run
      // to the map edge and extract.
      if (soldier.state === 'routing' || soldier.state === 'shattered') {
        soldier.targetId = null;
        soldier.rallyTargetId = null;
        continue;
      }

      if (soldier.disengageGraceTicksLeft > 0) {
        soldier.disengageGraceTicksLeft--;
        continue; // exempt from targeting entirely while disengaging
      }

      const unit = unitsById.get(soldier.unitId);
      const underOrder = !!(unit && unit.hasActiveOrder);
      const isRanged = unitHasClass(soldier.unitTypeDef, UnitClass.RANGED);

      // --- Focus-target branch ---
      // Two sources of "prefer this enemy unit": the player's right-click
      // attack order (focusTargetUnitId) and AI focus fire from
      // FocusFireCoordinator (aiFocusTargetUnitId). The player order wins
      // when both are set. The AI field exists specifically because the
      // player field has a movement side effect (Unit.update marches the
      // unit toward focusTargetUnitId) that AI archers must not trigger —
      // they need to keep firing from standoff, not chase.
      const focusId = unit
        ? (unit.focusTargetUnitId || unit.aiFocusTargetUnitId || null)
        : null;
      if (unit && focusId) {
        const focusUnit = unitsById.get(focusId);
        if (!focusUnit || focusUnit.isDefeated()) {
          // Clear whichever field was supplying this id, so a stale
          // dead-unit id does not persist across cycles.
          if (unit.focusTargetUnitId === focusId) unit.focusTargetUnitId = null;
          if (unit.aiFocusTargetUnitId === focusId) unit.aiFocusTargetUnitId = null;
        } else {
          // Always acquire the focus unit's nearest living soldier as
          // this soldier's target.
          //
          // The previous version short-circuited into "hold formation"
          // while the soldier was still part of the marching block,
          // then FELL THROUGH to the general nearest-enemy search
          // below. That fall-through preserved the soldier's existing
          // targetId whenever it was still technically valid — and a
          // routing enemy soldier is still isAlive() (only 'dead' and
          // 'extracted' return false). So after the archers routed
          // unit1 and the player re-issued an attack order on unit2,
          // every archer's old unit1 target validated as "still alive
          // and in range", the search returned it unchanged, and the
          // new focus on unit2 was never consulted. The archers kept
          // shooting the routed unit1 they had been told to leave.
          //
          // Rewriting targetId unconditionally from the current focus
          // unit is what makes an attack order authoritative: the
          // player's click always wins over whatever target the unit
          // happened to be carrying from a previous order.
          //
          // Block-following is still honoured — an unreleased soldier
          // in 'ranged' / 'marching' state continues to walk toward
          // its formation slot each tick (MovementSystem._holdFormationSlot
          // handles the 'ranged' case; the default slot-follow branch
          // handles 'marching'). Only WHICH enemy the soldier faces is
          // now unconditionally taken from the focus unit.
          //
          // Range gate uses getRangedRange so a per-unit override
          // (e.g. the goblin archer's 12) is respected here the same
          // way it already is in _searchRadiusFor and in
          // RangedCombatSystem's fire check.
          const focusSoldiers = focusUnit.getAliveSoldiers();
          let nearest = null;
          let nearestDistSq = Infinity;
          for (const fs of focusSoldiers) {
            const dx = fs.pos.x - soldier.pos.x;
            const dz = fs.pos.z - soldier.pos.z;
            const d = dx * dx + dz * dz;
            if (d < nearestDistSq) { nearestDistSq = d; nearest = fs; }
          }
          if (nearest) {
            soldier.targetId = nearest.id;
            const dist = Math.sqrt(nearestDistSq);
            if (dist <= CombatConfig.engagementRange) {
              soldier.state = 'engaged';
            } else if (isRanged &&
                       dist <= getRangedRange(soldier.unitTypeDef) &&
                       !underOrder) {
              soldier.state = 'ranged';
            } else {
              soldier.state = 'marching';
            }
            soldier.isImpetuous = false;
            continue;
          }
        }
      }

      const searchRadius = this._searchRadiusFor(soldier);
      const searchRadiusSq = searchRadius * searchRadius;
      const currentTarget = soldier.targetId ? byId.get(soldier.targetId) : null;
      const targetStillValid = currentTarget && currentTarget.isAlive() &&
        this._distsq(soldier, currentTarget) <= searchRadiusSq;

      // Cooldown fast-path: if this soldier is marching, has no current
      // target, and we're inside the post-null-search cooldown, skip the
      // expensive grid scan entirely. This is the single biggest change
      // for the march phase — the per-tick search of ~200 allied
      // candidates per soldier is what costs 40+ ms at 2000 soldiers,
      // and during the approach it can never return a result because
      // no enemy is within the search radius.
      //
      // Condition guards:
      //   - only apply when targetStillValid is false (no live target)
      //   - only apply when soldier is 'marching' or 'idle' — engaged /
      //     ranged soldiers have targets and never reach this branch
      //     anyway, but be explicit so a future state doesn't accidentally
      //     inherit the cooldown
      //   - never apply when the unit has an active order (an ordering
      //     player expects immediate re-acquisition if a threat appears)
      // Cooldown fires during march even when the unit has an active
      // order. The previous !underOrder gate meant every soldier in an
      // ordered unit scanned every tick — and during the approach phase
      // every unit has a move order, so the cooldown never engaged at
      // all. That was the 40ms/tick that made the approach unplayable.
      //
      // Behaviour cost: a soldier under a march order who would have
      // acquired a new enemy this tick now acquires it up to 5 ticks
      // (0.33s) later. At march speed that's ~1.5 world units of "late"
      // — a soldier notices an enemy at ~4.5m instead of ~6m. Still
      // inside engagement range, still fights the enemy he would have
      // fought before, just reacts slightly later.
      //
      // Player attack orders are unaffected: they set
      // unit.focusTargetUnitId, which takes precedence in the focus-
      // target branch BEFORE this code runs. A player clicking "attack
      // that unit" still gets instant acquisition.
      const inMarchCooldown =
        !targetStillValid &&
        (soldier.state === 'marching' || soldier.state === 'idle') &&
        soldier._marchNullCooldown > 0;

      if (inMarchCooldown) {
        soldier._marchNullCooldown--;
        soldier.targetId = null;
        soldier.isImpetuous = false;
        continue;
      }

      const target = targetStillValid ? currentTarget : this._findNearestEnemy(soldier, searchRadius);
      soldier.targetId = target ? target.id : null;

      // Set the cooldown after a null result during march. Fires whether
      // or not the unit has an order — see the inMarchCooldown branch
      // above for why the !underOrder gate had to go.
      if (!target &&
          (soldier.state === 'marching' || soldier.state === 'idle')) {
        soldier._marchNullCooldown = this._marchNullCooldownTicks;
      } else {
        soldier._marchNullCooldown = 0;
      }

      if (!target) {
        // No enemy within personal search radius. If the unit is fighting and
        // we are not under an explicit move order, rally to the fight.
        if (!underOrder) {
          const rallyId = this._pickNearestRallyTarget(soldier, allyBeaconsByUnit);
          if (rallyId !== null) {
            soldier.rallyTargetId = rallyId;
            soldier.state = 'marching';
          } else {
            soldier.state = 'idle';
          }
        }
        soldier.isImpetuous = false;
        continue;
      }

      const dist = this._distance(soldier, target);

      // The instant a soldier reaches melee contact, drop the unit's march
      // order (if any) so unit-mates still marching to their formation slot
      // stop treating that slot as more important than the fight that just
      // started and become eligible for the rally branch above immediately,
      // instead of only after they personally arrive.
      if (dist <= CombatConfig.engagementRange) {
        const contactUnit = unitsById.get(soldier.unitId);
        if (contactUnit) contactUnit.interruptOrderForContact();
      }

      if (isRanged) {
        // An enemy directly in the archer's face still forces a melee state —
        // an ordered formation can't walk through a live enemy.
        if (dist <= CombatConfig.engagementRange) {
          soldier.state = 'engaged';
          continue;
        }
        // Under an active order, keep marching. Fire-at-will only resumes
        // once the unit has arrived and hasActiveOrder clears.
        if (underOrder) {
          soldier.state = 'marching';
          continue;
        }
        if (dist <= CombatConfig.rangedRange) {
          soldier.state = 'ranged';
        } else {
          soldier.state = 'marching';
        }
        continue;
      }

      if (dist <= CombatConfig.engagementRange) {
        soldier.state = 'engaged';
        continue;
      }

      if (underOrder) {
        soldier.state = 'marching';
        continue;
      }

      if (dist <= CombatConfig.chargeSpotRange) {
        if (!soldier.isImpetuous) {
          soldier.isImpetuous = this._rollImpetuous(soldier);
        }
        soldier.state = soldier.isImpetuous ? 'impetuous' : 'marching';
      } else {
        soldier.state = 'marching';
      }
    }
  }

  _rollImpetuous(soldier) {
    const disciplineKey = soldier.unitTypeDef.discipline || 'normal';
    const cfg = CombatConfig.discipline[disciplineKey] || CombatConfig.discipline.normal;
    return Math.random() < cfg.impetuousChance;
  }

  // Map<unitId, Array<{x, z, targetId}>>: one entry per engaged ally that has
  // a live target. A given idle soldier then picks the beacon nearest to them,
  // so a unit split across two fights sends reinforcements to the closest one
  // instead of stacking everyone on a single arbitrary front.
  _buildAllyRallyBeacons(allSoldiers, byId) {
    const map = new Map();
    for (const s of allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.state !== 'engaged' && s.state !== 'staggered') continue;
      if (!s.targetId) continue;
      const t = byId.get(s.targetId);
      if (!t || !t.isAlive()) continue;

      let arr = map.get(s.unitId);
      if (!arr) { arr = []; map.set(s.unitId, arr); }
      arr.push({ x: s.pos.x, z: s.pos.z, targetId: s.targetId });
    }
    return map;
  }

  _pickNearestRallyTarget(soldier, allyBeaconsByUnit) {
    const beacons = allyBeaconsByUnit.get(soldier.unitId);
    if (!beacons || beacons.length === 0) return null;

    let nearestTargetId = null;
    let nearestDistSq = Infinity;
    for (const b of beacons) {
      const dx = b.x - soldier.pos.x;
      const dz = b.z - soldier.pos.z;
      const d = dx * dx + dz * dz;
      if (d < nearestDistSq) {
        nearestDistSq = d;
        nearestTargetId = b.targetId;
      }
    }
    return nearestTargetId;
  }

_findNearestEnemy(soldier, searchRadius) {
    const radius = searchRadius ?? CombatConfig.targetSearchRadius;
    const radiusSq = radius * radius;
    // Early-out threshold. Any enemy inside engagement range is close
    // enough to fight, so returning the first one found is behaviourally
    // identical to "nearest" once the soldier has committed to melee. This
    // is what keeps a mid-combat soldier's search cheap: it will almost
    // always find an engaged neighbour in the first few candidates and
    // skip scanning the rest.
    const engagementRangeSq =
      CombatConfig.engagementRange * CombatConfig.engagementRange;

    const cellSize = this.spatialGrid.cellSize;
    const radiusInCells = Math.ceil(radius / cellSize) + 1;
    // Excluding-team query: skips every allied soldier in every cell.
    // This is the single biggest fix for the approach-phase tick — the
    // combined query touched ~200 allied soldiers per soldier per tick
    // during march, all filtered out by the teamId check below. Scanning
    // the enemy grid yields ~0 candidates during march and ~80 during
    // melee, instead of ~400 both phases.
    const candidates = this.spatialGrid.queryNearbyIntoExcludingTeam(
      this._candidates, soldier.pos.x, soldier.pos.z, radiusInCells,
      soldier.teamId);

    let nearest = null;
    let nearestDistSq = radiusSq;

    for (const other of candidates) {
      if (other.teamId === soldier.teamId) continue;
      if (!other.isAlive()) continue;

      const dx = other.pos.x - soldier.pos.x;
      const dz = other.pos.z - soldier.pos.z;
      const d2 = dx * dx + dz * dz;

      if (d2 <= engagementRangeSq) return other;
      if (d2 < nearestDistSq) {
        nearestDistSq = d2;
        nearest = other;
      }
    }

    return nearest;
  }

  // Ranged units search out to their weapon range. Melee search to the base
  // targetSearchRadius. Without this, doubling archer range would have no
  // effect — they'd never acquire a target beyond the melee radius.
  //
  // Uses the shared UnitClass.RANGED helper, NOT a raw `unitTypeDef.isRanged`
  // field — UnitTypes.js declares class membership via `unitClasses: [...]`,
  // and there is no boolean `isRanged` on the type. The earlier raw-field
  // check was always undefined, so archers were silently searching only the
  // 6-unit melee radius, which is why a focus-fire target was the only way
  // to get them to shoot at their actual (rangedRange = 21) reach.
  _searchRadiusFor(soldier) {
    if (unitHasClass(soldier.unitTypeDef, UnitClass.RANGED)) {
      return getRangedRange(soldier.unitTypeDef);
    }
    return CombatConfig.targetSearchRadius;
  }

  _distance(a, b) {
    const dx = a.pos.x - b.pos.x;
    const dz = a.pos.z - b.pos.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  // Squared distance. Use in any comparison against a threshold; the sqrt
  // is expensive (20+ cycles) and each soldier runs one per candidate in
  // _findNearestEnemy, so keeping the search loop squared removes roughly a
  // third of the targeting cost at 2000 soldiers.
  _distsq(a, b) {
    const dx = a.pos.x - b.pos.x;
    const dz = a.pos.z - b.pos.z;
    return dx * dx + dz * dz;
  }
}
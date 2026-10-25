// ===== src/sim/BloodThrallSystem.js =====
// Manages the Blood Thrall lifecycle: spawning, lifetime, targeting, and
// merging. Thralls are raised by the Blood Thrall champion skill — see
// CombatResolutionSystem._maybeRaiseThrall for the queue producer and
// CombatConfig.thrall for tuning.
//
// Runs in BattleSimulation's post-combat pass, AFTER combat resolution
// has queued any thralls raised this tick and BEFORE morale/movement so a
// fresh thrall is available to act on its first tick.
//
// What a thrall is:
//   - A soldier of the champion's team, raised from a dead enemy.
//   - It PRESERVES the source's living/undead state. A dead human rises
//     as a living human thrall; a dead skeleton rises as an undead
//     skeleton thrall. (A goblin source still resolves to a goblin body
//     because RaceConfig.supportsUndead is false for goblins — that is
//     the correct outcome for a goblin, not a bug.)
//   - Half-statted: HP, damage, and mass scaled by the skill's
//     statMult. Speed, stagger recovery, and vision unchanged.
//   - Morale-immune (see MoraleSystem). Never routs, never shatters.
//   - Lifetime-limited by HP DRAIN, not a tick timer. Each tick the
//     thrall loses maxHp / (lifetimeSeconds * ticksPerSecond) HP; when
//     the pool empties it dies like any other soldier. The drain is
//     visible on the health bar, which is why it replaced the old
//     invisible tick expiry.
//   - Belongs to a thrall UNIT, not the champion's retinue. When a fresh
//     thrall spawns within mergeRadius of an existing thrall unit of the
//     same owner, it joins that unit; otherwise a new single-soldier
//     thrall unit is created.
//
// This system does NOT handle orphaned mounts — those are a separate
// mechanic owned by OrphanedMountSystem.js. A riderless beast is not a
// thrall and shares none of the lifecycle machinery below.
//
// Why a separate system rather than inlining in BattleSimulation: the
// simulation's tick() is a fixed pipeline of one-shot systems, and this
// one owns a nontrivial lifetime/merge state machine that mutates the
// units list. Keeping it isolated means BattleSimulation just calls it
// and moves on, and the thrall rules are testable without a whole sim.

import { Soldier } from './Soldier.js';
import { Unit } from './Unit.js';
import { CombatConfig } from '../config/CombatConfig.js';

// Source tag for thrall units. Used to distinguish them from the
// champion's own retinue and from any future captain units. Not read by
// the sim other than as a marker.
const THRALL_UNIT_PREFIX = 'thrall-';

// Thrall lifetime, in real seconds. Converted to a per-tick HP drain at
// spawn using the sim's fixed tick rate.
// Overridable via CombatConfig.thrall.lifetimeSeconds if present.
const DEFAULT_THRALL_LIFETIME_SECONDS = 30;

let nextThrallUnitId = 1;

export class BloodThrallSystem {
  constructor() {
    // Currently-living thrall units. Rebuilt each tick from the queue
    // plus survivors — see update().
    this.thrallUnits = [];
  }

  // Called once per sim tick from BattleSimulation, right after combat
  // resolution has drained its pending-thrall queue.
  //
  // `pendingThralls` — array of raise descriptors from CombatResolutionSystem.
  // `simulation` — the live BattleSimulation (needed to register new units).
  update(pendingThralls, simulation) {
    // --- 1. Spawn new thralls --------------------------------------------
    for (const spec of pendingThralls || []) {
      this._spawn(spec, simulation);
    }

    // --- 2. HP drain + cull ----------------------------------------------
    // The drain IS the lifetime. Each tick a thrall loses
    //   maxHp / (lifetimeSeconds * ticksPerSecond)
    // HP. When hp reaches 0 it dies like any other soldier — state goes
    // to 'dead' so every downstream consumer (isAlive, targeting,
    // morale) treats it as gone without special-casing.
    //
    // Drain runs BEFORE the targeting pass below, so a thrall that dies
    // this tick is not handed a fresh target on its way out.
    const survivingUnits = [];
    for (const unit of this.thrallUnits) {
      const survivors = [];
      for (const s of unit.soldiers) {
        if (!s.isAlive()) continue;

        if (s.thrallHpDrainPerTick > 0) {
          s.hp -= s.thrallHpDrainPerTick;
          if (s.hp <= 0) {
            s.hp = 0;
            s.state = 'dead';
            s.targetId = null;
            continue;
          }
        }

        survivors.push(s);
      }
      if (survivors.length === 0) {
        // Unit has no living thralls. Remove it from the simulation
        // entirely so it does not linger in the unit list.
        this._removeUnitFromSimulation(unit, simulation);
      } else {
        // Unit is still alive. Retain it for next tick.
        survivingUnits.push(unit);
      }
    }
    this.thrallUnits = survivingUnits;

    // --- 3. Target assignment --------------------------------------------
    // Every living thrall targets the nearest enemy of its champion. If
    // the champion is dead, it targets the nearest enemy of itself
    // (fallback — the champion's Blood Pact may revive them, but a thrall
    // that outlives a champion should not stand idle).
    for (const unit of this.thrallUnits) {
      for (const thrall of unit.soldiers) {
        if (!thrall.isAlive()) continue;
        if (thrall.state === 'engaged' || thrall.state === 'staggered'
            || thrall.state === 'knockedDown') {
          continue;
        }
        const anchor = this._anchorFor(thrall);
        const target = this._nearestEnemy(anchor, thrall, simulation);
        if (target) {
          thrall.targetId = target.id;
          const dx = target.pos.x - thrall.pos.x;
          const dz = target.pos.z - thrall.pos.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          thrall.state = dist <= CombatConfig.engagementRange
            ? 'engaged'
            : 'marching';
        } else {
          thrall.targetId = null;
          thrall.state = 'idle';
        }
      }
    }
  }

  // --- internals ---------------------------------------------------------

  _anchorFor(thrall) {
    const champ = thrall.thrallChampionRef;
    if (champ && champ.isAlive()) return champ.pos;
    return thrall.pos;
  }

  _nearestEnemy(anchor, thrall, simulation) {
    if (!simulation) return null;
    const radius = CombatConfig.thrall.targetSearchRadius;
    const radiusSq = radius * radius;
    let best = null;
    let bestSq = Infinity;
    for (const unit of simulation.units) {
      if (unit.teamId === thrall.teamId) continue;
      for (const s of unit.soldiers) {
        if (!s.isAlive()) continue;
        if (s.state === 'routing' || s.state === 'shattered') continue;
        const dx = s.pos.x - anchor.x;
        const dz = s.pos.z - anchor.z;
        const dSq = dx * dx + dz * dz;
        if (dSq > radiusSq) continue;
        if (dSq < bestSq) {
          bestSq = dSq;
          best = s;
        }
      }
    }
    return best;
  }

  _spawn(spec, simulation) {
    if (!spec || !spec.sourceTypeDef) return;
    if (!simulation) return;

    // Merge first: is there an existing thrall unit of the same owner
    // within mergeRadius of the spawn point? If so, the new soldier joins
    // that unit instead of forming its own.
    let targetUnit = null;
    if (this.thrallUnits.length > 0) {
      const mergeR = CombatConfig.thrall.mergeRadius;
      const mergeSq = mergeR * mergeR;
      let bestUnit = null;
      let bestSq = Infinity;
      for (const u of this.thrallUnits) {
        if (u.teamId !== spec.teamId) continue;
        // Distance from spawn to unit center.
        const c = u.getCenter();
        const dx = c.x - spec.pos.x;
        const dz = c.z - spec.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq > mergeSq) continue;
        if (dSq < bestSq) {
          bestSq = dSq;
          bestUnit = u;
        }
      }
      targetUnit = bestUnit;
    }

    if (!targetUnit) {
      targetUnit = new Unit({
        id: `${THRALL_UNIT_PREFIX}${nextThrallUnitId++}`,
        teamId: spec.teamId,
        formationFacing: 0,
        isUndead: false,
      });
      // Thralls do not use formations. Keep the unit single-column so a
      // formation reflow is a no-op — the soldiers path individually
      // toward their targets via BloodThrallSystem's targeting pass, not
      // via Unit's march anchor.
      targetUnit.formationCols = 1;
      this.thrallUnits.push(targetUnit);
      simulation.units.push(targetUnit);
      simulation.unitsById.set(targetUnit.id, targetUnit);
    }

    // Build the thrall soldier from the source type. Halve HP, damage,
    // and mass after construction — the Soldier constructor already
    // resolved race + undead multipliers, and re-entering that path
    // would double-apply them.
    //
    // The undead flag is PRESERVED from the source: a thrall raised
    // from a living soldier is a living thrall, one raised from a
    // skeleton is an undead thrall. The Soldier constructor still
    // applies RaceConfig.supportsUndead, so a goblin source produces a
    // goblin body regardless — a goblin cannot be a skeleton in this
    // codebase.
    const soldier = new Soldier({
      unitId: targetUnit.id,
      teamId: spec.teamId,
      unitTypeDef: spec.sourceTypeDef,
      x: spec.pos.x,
      z: spec.pos.z,
      facing: 0,
      isUndead: !!spec.sourceIsUndead,
    });

    // Apply halving. Damage is via combatMods.outgoingDamageMult (the
    // sim reads this in _resolveAttack); HP and mass are physical.
    soldier.maxHp = Math.max(1, Math.round(soldier.maxHp * spec.statMult));
    soldier.hp = soldier.maxHp;
    soldier.combatMods = Object.assign({}, soldier.combatMods, {
      outgoingDamageMult: spec.statMult,
    });

    // Physical mass override. effectiveMass reads unitTypeDef.mass and
    // the undead multiplier; we cannot easily halve it via config, so
    // set a per-soldier override that effectiveMass will read. Add the
    // field here rather than as a getter override, since this is a sim
    // system, not a Soldier method — see the Soldier.effectiveMass
    // contract for the fields it reads.
    soldier._thrallMassMultiplier = spec.statMult;

    // Lifetime is HP drain, not a tick timer. Per-tick drain is
    //   maxHp / (lifetimeSeconds * ticksPerSecond)
    // computed once here from the already-halved maxHp. Over 30 seconds
    // of ticks the drain sums to exactly maxHp, so the thrall dies at
    // the 30-second mark — but visibly, via its health bar.
    const lifetimeSeconds = CombatConfig.thrall.lifetimeSeconds
      ?? DEFAULT_THRALL_LIFETIME_SECONDS;
    soldier.thrallHpDrainPerTick =
      soldier.maxHp / (lifetimeSeconds * CombatConfig.tickRateHz);

    // Thrall markers.
    soldier.isThrall = true;
    soldier.thrallChampionRef = spec.championRef || null;
    soldier.thrallSourceTypeId = spec.sourceTypeId;

    // NOTE: no disengageGraceTicksLeft write here. MovementSystem's
    // thrall branch (see `if (soldier.isThrall)`) already bypasses the
    // formation-slot system entirely, so releasing the soldier does
    // nothing — the field was dead. Thralls path straight at their
    // assigned target via that branch, not via the released-marcher
    // path.
    targetUnit.addSoldier(soldier);
    // Re-layout the (single-column) formation so the new soldier has a
    // formationSlot. The unit stays a column; thralls ignore slots anyway.
    targetUnit._layoutGrid(1, targetUnit.getFormationSpacing());
  }

  _removeUnitFromSimulation(unit, simulation) {
    if (!simulation) return;
    const i = simulation.units.indexOf(unit);
    if (i >= 0) simulation.units.splice(i, 1);
    simulation.unitsById.delete(unit.id);
  }
}
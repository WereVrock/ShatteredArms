// ===== ProjectileSystem.js =====
// Owns every in-flight arrow. Advances them each tick, sweeps their path
// for collisions against living soldiers (friend, foe, stray target —
// whatever the arrow physically reaches), resolves damage and shield
// block on the first hit, and emits combat events.
//
// Where damage USED to be resolved: RangedCombatSystem, at launch, with
// to-hit and block rolled before any arrow existed. Where it resolves
// now: here, at the moment the arrow's simulated (x, y, z) actually
// overlaps a soldier's body. Fast units that have moved out of the
// target area between launch and impact are not hit. Arrows flying over
// the formation at their apex are not hit. Cross-unit friendly fire from
// a stray arrow that lands short IS hit normally.
//
// Same-unit exception: the shooter's own unit is skipped for the entire
// flight. An arrow leaves the archer's chest inside its own formation
// and would otherwise always clip the next-rank neighbour before
// clearing the front line, making volleys self-destructive. Any OTHER
// friendly unit caught in the corridor still takes the arrow.
//
// Events emitted (drained by main.js, dispatched by BattleRenderer):
//   'fire'         — on spawn, carries the shot's launch target point so
//                    the shooter's bow can be pitched to the launch
//                    angle. NOT used to spawn a ProjectileView anymore;
//                    the view is driven directly from projectile state.
//   'hit'          — arrow struck a soldier (post-block).
//   'block'        — defender's shield absorbed the arrow.
//   'shieldBreak'  — that block broke the shield.
//   'death'        — that hit killed the defender.
//   'arrowLanded'  — arrow reached its target point without a hit.
//                    Currently a no-op in the renderer; emitted for
//                    future impact-dust / audio work.
import { Projectile } from './Projectile.js';
import {
  CombatConfig,
  WeaponMatchup,
  SkeletonDamageModifiers,
  DefenderCategoryDamageModifiers
} from '../config/CombatConfig.js';
import { isCavalry } from '../config/UnitClasses.js';
import { ShieldBlockCalculator } from './ShieldBlockCalculator.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';

export class ProjectileSystem {
  constructor(spatialGrid) {
    this.spatialGrid = spatialGrid;
    this.projectiles = [];
    this.events = [];
    this._nextId = 1;
  }

  // Called by RangedCombatSystem when a volley fires. One arrow per
  // shooter per volley, each with its own randomised target point inside
  // the target unit's scatter disc.
  spawn(opts) {
    const proj = new Projectile({ id: this._nextId++, ...opts });
    this.projectiles.push(proj);
    this.events.push({
      type: 'fire',
      attackerId: opts.shooterSoldierId,
      defenderId: null,
      fromPos: { x: opts.fromX, z: opts.fromZ },
      toPos: { x: opts.toX, z: opts.toZ }
    });
    return proj;
  }

  drainEvents() {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  // Read-only live reference for the renderer, re-read every frame. The
  // array is replaced by update() each tick, so callers must NOT cache
  // the result across frames.
  getActiveProjectiles() {
    return this.projectiles;
  }

  update(allSoldiers, unitsById, deltaSeconds) {
    // Build a fresh list rather than splicing in place — update() can run
    // while outer code (main.js) has already captured a reference to the
    // previous array for this frame's renderer sync, and mutating it in
    // place would race that read.
    const surviving = [];
    for (const proj of this.projectiles) {
      const stillFlying = proj.advance(deltaSeconds);

      const hitSoldier = this._findCollision(proj, allSoldiers);
      if (hitSoldier) {
        this._resolveHit(proj, hitSoldier);
        continue;
      }

      if (!stillFlying) {
        this.events.push({
          type: 'arrowLanded',
          fromPos: { x: proj.prevX, z: proj.prevZ },
          toPos: { x: proj.x, z: proj.z }
        });
        continue;
      }

      if (this._isOutOfBounds(proj)) continue;

      surviving.push(proj);
    }

    this.projectiles = surviving;
  }

  // Swept-segment collision: for each living soldier within the spatial
  // grid query radius, find the point on this tick's arrow segment that
  // is closest (in XZ) to the soldier. If that point's horizontal
  // distance ≤ hitRadius AND the interpolated y at that point lies inside
  // the body band, it is a hit. The earliest hit along the segment
  // (smallest t) wins, so a soldier standing closer to the arrow's start
  // absorbs it before a soldier further along the same sweep.
  _findCollision(proj, allSoldiers) {
    const cfg = CombatConfig.arrow;
    const hitRadiusSq = cfg.hitRadius * cfg.hitRadius;

    const segDX = proj.x - proj.prevX;
    const segDZ = proj.z - proj.prevZ;
    const segLenSq = segDX * segDX + segDZ * segDZ;

    // Query the grid around the segment's midpoint, expanded by the hit
    // radius so soldiers just off the segment but inside the collision
    // envelope are still tested. One query per projectile per tick.
    const cx = (proj.prevX + proj.x) / 2;
    const cz = (proj.prevZ + proj.z) / 2;
    const segHalfLen = Math.sqrt(segLenSq) / 2;
    const searchRadius = segHalfLen + cfg.hitRadius;
    const radiusInCells = Math.ceil(searchRadius / this.spatialGrid.cellSize) + 1;
    const candidates = this.spatialGrid.queryNearby(cx, cz, radiusInCells);

    let best = null;
    let bestT = Infinity;

    for (const soldier of candidates) {
      if (!soldier.isAlive()) continue;

      // Same-unit skip: an arrow leaving the archer's chest inside its
      // own formation would otherwise clip the next-rank neighbour at
      // launch, before its arc rises above body height. Cross-unit
      // friendly fire is unaffected.
      if (soldier.unitId === proj.shooterUnitId) continue;

      const toSX = soldier.pos.x - proj.prevX;
      const toSZ = soldier.pos.z - proj.prevZ;

      let t;
      if (segLenSq < 1e-8) {
        // Arrow barely moved this tick (spawn tick, or duration elapsed
        // mid-tick) — treat as a point test.
        t = 0;
      } else {
        t = (toSX * segDX + toSZ * segDZ) / segLenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
      }

      const closestX = proj.prevX + segDX * t;
      const closestZ = proj.prevZ + segDZ * t;
      const dx = soldier.pos.x - closestX;
      const dz = soldier.pos.z - closestZ;
      if (dx * dx + dz * dz > hitRadiusSq) continue;

      // Interpolate y linearly between prev and current. The true y is
      // parabolic, but a single tick's worth of travel is short enough
      // that the linear approximation is exact to floating-point noise.
      const y = proj.prevY + (proj.y - proj.prevY) * t;
      if (y < cfg.bodyMinY || y > cfg.bodyMaxY) continue;

      if (t < bestT) {
        bestT = t;
        best = soldier;
      }
    }

    return best;
  }

  _resolveHit(proj, defender) {
    const matchup = WeaponMatchup[proj.weaponType];
    if (!matchup) return;

    // Shield block: the arrow physically reached the defender, but the
    // shield can still catch it. Same block curve the sim has always used
    // for melee, with the arrow's incoming horizontal direction (its
    // previous tick position) as the attack-from vector.
    const attackFrom = { x: proj.prevX, z: proj.prevZ };
    const blockChance = ShieldBlockCalculator.computeBlockChance(
      defender, attackFrom, proj.weaponType
    );
    const blocked = Math.random() < blockChance;

    if (blocked) {
      defender.shieldHp -= matchup.shieldDamage;
      this.events.push({
        type: 'block',
        attackerId: proj.shooterSoldierId,
        defenderId: defender.id
      });
      if (defender.shieldHp <= 0) {
        defender.shieldHp = 0;
        defender.hasShield = false;
        this.events.push({ type: 'shieldBreak', defenderId: defender.id });
      }
      return;
    }

    // Damage mods — same order and tables the old ranged path used, so
    // bow-vs-skeleton and bow-vs-cavalry stay identical.
    let damage = matchup.damage;
    if (defender.isUndead) {
      const mod = SkeletonDamageModifiers[proj.weaponType];
      if (mod !== undefined) damage *= mod;
    }
    if (isCavalry(defender.unitTypeDef)) {
      const catMods = DefenderCategoryDamageModifiers.cavalry;
      if (catMods) {
        const mod = catMods[proj.weaponType];
        if (mod !== undefined) damage *= mod;
      }
    }

    defender.hp -= damage;
    this.events.push({
      type: 'hit',
      attackerId: proj.shooterSoldierId,
      defenderId: defender.id
    });
    AIDebugLog.combatHit(0, proj.shooterSoldierId, defender.id, damage,
      Math.max(0, defender.hp), defender.maxHp);

    if (defender.hp <= 0) {
      defender.hp = 0;
      defender.state = 'dead';
      defender.targetId = null;
      this.events.push({ type: 'death', defenderId: defender.id });
      AIDebugLog.combatDeath(0, defender.id, defender.unitId);
    }
  }

  _isOutOfBounds(proj) {
    const b = CombatConfig.mapBounds;
    const m = CombatConfig.arrow.cullMargin;
    return proj.x < b.minX - m || proj.x > b.maxX + m
        || proj.z < b.minZ - m || proj.z > b.maxZ + m;
  }
}
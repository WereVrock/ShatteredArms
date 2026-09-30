// ===== MoraleSystem.js =====
import { MoraleConfig } from '../config/MoraleConfig.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';

// Runs once per sim tick, after combat. Reads each soldier's local situation
// and updates their morale, entering / leaving 'routing' at the thresholds.
//
// Per-soldier (not per-unit) so reactions vary with local situation: a soldier
// whose unit has taken casualties but who is standing safely behind the line
// holds, while a soldier on the exposed flank of the same unit breaks.
//
// Uses the shared SpatialGrid for the nearby-soldier queries. One query per
// soldier per tick, cell size 2.0, radius 2 cells ≈ 4 world units.
//
// Shatter: a routing soldier can collapse permanently into 'shattered',
// a terminal state that cannot rally and keeps running to the map edge
// until extracted. Three triggers — second rout (30% rout / 70% shatter),
// third-or-later rout (100% shatter), or unit strength falling below a
// faction-dependent threshold while already routing. See MoraleConfig.shatter.
//
// Debug: every rout / rally / shatter transition logs its full per-source
// breakdown via AIDebugLog (category 'morale').
export class MoraleSystem {
  constructor(spatialGrid, playerTeamId) {
    this.spatialGrid = spatialGrid;
    // Which team id counts as the player for the shatter-threshold lookup.
    // Standalone scenarios default to 'blue'; campaigns pass the actual
    // playerTeamId from the scenario object. Null is treated as "no team
    // is the player" — every team then uses the enemy (harsher) threshold.
    this.playerTeamId = playerTeamId || null;

    // Previous tick's alive count per unit, so a fresh casualty this tick can
    // be applied as a one-shot morale hit instead of a permanent drain.
    this._previousAliveByUnit = new Map();

    // Own tick counter. BattleSimulation does not pass one down, and the
    // morale log needs a tick stamp to correlate with the AI logs. Incremented
    // at the END of update() to match TeamAI.tickCounter, which also
    // increments after its own work — so both report the same tick number for
    // the same sim tick.
    this._tick = 0;

    // Reusable scratch object for the per-source breakdown. Filled in place
    // for every soldier, but only ever READ when a transition is about to be
    // logged (or the soldier is on the watch list) — so it costs no
    // allocation per soldier per tick and nothing at all when logging is
    // disabled. Fields are reset at the top of _updateSoldier.
    this._breakdown = {
      startMorale: 0,
      endMorale: 0,
      total: 0,
      regen: 0,
      hp: 0,
      casualtyRatio: 0,
      casualtyLoss: 0,
      outnumbered: 0,
      outnumberedRatio: 0,
      allyStrength: 0,
      enemyStrength: 0,
      flanked: 0,
      allyRout: 0,
      enemyRout: 0,
      kill: 0,
      adjacentWiped: 0
    };
  }

  update(allSoldiers, unitsById) {
    const aliveByUnit = new Map();
    for (const [unitId, unit] of unitsById) {
      aliveByUnit.set(unitId, unit.getAliveSoldiers().length);
    }

    for (const soldier of allSoldiers) {
      if (!soldier.isAlive()) continue;

      // Undead do not rout. Forced to max morale every tick so they cannot
      // accumulate a morale deficit, and any routing state is cleared on
      // sight — undead routing is never valid.
      if (soldier.isUndead) {
        soldier.morale = MoraleConfig.maxMorale;
        soldier.justKilled = false;
        if (soldier.isRouting) {
          soldier.isRouting = false;
          soldier.state = 'idle';
          soldier.fleeDirection = { x: 0, z: 0 };
        }
        continue;
      }

      this._updateSoldier(soldier, unitsById, aliveByUnit);
    }

    // Auto-shatter: if every living soldier on a team is routing at the
    // same moment, the whole army has broken. All routers become shattered
    // — the battle ends as soon as their escape completes, and they cannot
    // rally even if enough of them survive to make it back.
    this._autoShatterFullyRoutedTeams(allSoldiers);

    this._previousAliveByUnit = aliveByUnit;
    this._tick++;
  }

  // Team-wide pass. For each team: if it has at least one living soldier
  // and every living soldier is in 'routing' or 'shattered' state, all
  // routing soldiers on it shatter. A team with any soldier still in a
  // fighting state (idle / marching / engaged / etc.) is not fully
  // broken and is skipped. A team already fully shattered has no routing
  // soldiers to convert, so this is a no-op for it.
  _autoShatterFullyRoutedTeams(allSoldiers) {
    const teamIds = new Set();
    for (const s of allSoldiers) teamIds.add(s.teamId);

    for (const teamId of teamIds) {
      let hasLiving = false;
      let allRouting = true;
      for (const s of allSoldiers) {
        if (s.teamId !== teamId) continue;
        if (!s.isAlive()) continue;
        hasLiving = true;
        if (s.state !== 'routing' && s.state !== 'shattered') {
          allRouting = false;
          break;
        }
      }
      if (!hasLiving || !allRouting) continue;

      let shatteredCount = 0;
      for (const s of allSoldiers) {
        if (s.teamId !== teamId) continue;
        if (s.state === 'routing') {
          s.state = 'shattered';
          shatteredCount++;
        }
      }
      if (shatteredCount > 0) {
        AIDebugLog.log('morale', this._tick,
          `SHATTER-TEAM teamId=${teamId} count=${shatteredCount} reason=total-rout`);
      }
    }
  }

  _updateSoldier(soldier, unitsById, aliveByUnit) {
    // Shattered soldiers skip all morale processing. No recovery, no
    // rally, no drains — they run to the map edge and extract.
    if (soldier.state === 'shattered') return;

    // Continuous "rout turns to shatter" check: while a soldier is in
    // 'routing' state, if their unit has been ground below the faction
    // strength threshold, they shatter immediately. This is checked every
    // tick so a unit that keeps losing soldiers after its first rout
    // collapses into shatter mid-flight rather than running forever.
    if (soldier.state === 'routing' &&
        this._shouldShatterForStrength(soldier, unitsById, aliveByUnit)) {
      const unit = unitsById.get(soldier.unitId);
      const deployed = unit ? unit.soldiers.length : 0;
      const alive = aliveByUnit.get(soldier.unitId) ?? 0;
      AIDebugLog.log('morale', this._tick,
        `SHATTER soldier=${soldier.id} unit=${soldier.unitId} reason=strength alive=${alive}/${deployed} morale=${soldier.morale.toFixed(1)}`);
      soldier.state = 'shattered';
      soldier.targetId = null;
      return;
    }

    const cfg = MoraleConfig;
    const b = this._breakdown;

    // --- Reset the scratch breakdown for this soldier ---
    b.startMorale = soldier.morale;
    b.endMorale = 0;
    b.total = 0;
    b.regen = 0;
    b.hp = 0;
    b.casualtyRatio = 0;
    b.casualtyLoss = 0;
    b.outnumbered = 0;
    b.outnumberedRatio = 0;
    b.allyStrength = 0;
    b.enemyStrength = 0;
    b.flanked = 0;
    b.allyRout = 0;
    b.enemyRout = 0;
    b.kill = 0;
    b.adjacentWiped = 0;

    // Passive regen only applies OUT of combat. A soldier currently
    // engaged, staggered, or shooting is under pressure — morale cannot
    // recover while the fight is on. Routing soldiers keep their bonus.
    const inCombat = soldier.state === 'engaged' ||
                     soldier.state === 'staggered' ||
                     soldier.state === 'ranged';
    const regen = soldier.isRouting
      ? cfg.regenPerTick + cfg.routingRegenBonus
      : (inCombat ? 0 : cfg.regenPerTick);
    let delta = regen;
    b.regen = regen;

    // --- Own HP ---
    const hpRatio = soldier.hp / soldier.maxHp;
    if (hpRatio < 0.5) {
      const penalty = cfg.hpPenaltyMaxPerTick * ((0.5 - hpRatio) / 0.5);
      delta -= penalty;
      b.hp = -penalty;
    }

    // --- Unit casualties: residual drain + one-shot hit for losses this tick ---
    const unit = unitsById.get(soldier.unitId);
    if (unit) {
      const alive = aliveByUnit.get(soldier.unitId) ?? 0;
      const prev = this._previousAliveByUnit.get(soldier.unitId) ?? alive;
      const total = unit.soldiers.length;
      if (total > 0) {
        const lossFrac = 1 - alive / total;
        let penalty;
        if (lossFrac <= 0.5) {
          penalty = cfg.casualtyRatioPenaltyPerTick * lossFrac;
        } else {
          const linear = cfg.casualtyRatioPenaltyPerTick * 0.5;
          const excess = lossFrac - 0.5;
          penalty = linear + cfg.casualtyRatioPenaltyPerTick * 4 * excess * excess;
        }
        delta -= penalty;
        b.casualtyRatio = -penalty;
      }
      const lostThisTick = Math.max(0, prev - alive);
      if (lostThisTick > 0) {
        const penalty = cfg.casualtyLossPenaltyPerSoldier * lostThisTick;
        delta -= penalty;
        b.casualtyLoss = -penalty;
      }
    }

    // Adjacent friendly unit wiped this tick — one-shot shock.
    if (this._previousAliveByUnit && unitsById) {
      for (const [otherId, prevAlive] of this._previousAliveByUnit) {
        if (otherId === soldier.unitId) continue;
        if (prevAlive <= 0) continue;
        const nowAlive = aliveByUnit.get(otherId);
        if (nowAlive !== 0) continue;

        const wipedUnit = unitsById.get(otherId);
        if (!wipedUnit || wipedUnit.teamId !== soldier.teamId) continue;
        const radiusSq = cfg.routCheckRadius * cfg.routCheckRadius;
        let near = false;
        for (const s of wipedUnit.soldiers) {
          const dx = s.pos.x - soldier.pos.x;
          const dz = s.pos.z - soldier.pos.z;
          if (dx * dx + dz * dz <= radiusSq) { near = true; break; }
        }
        if (near) {
          delta -= cfg.adjacentUnitWipedShock;
          b.adjacentWiped = (b.adjacentWiped || 0) - cfg.adjacentUnitWipedShock;
        }
      }
    }

    // --- Single nearby pass: strength sums, nearest enemy, rout perception ---
    const nearby = this.spatialGrid.queryNearby(soldier.pos.x, soldier.pos.z, 2);

    let allyStrength = soldier.effectiveMass;
    let enemyStrength = 0;
    let nearestEnemy = null;
    let nearestEnemyDistSq = Infinity;
    let allyRoutingNearby = false;
    let enemyRoutingNearby = false;

    const routRadiusSq = cfg.routCheckRadius * cfg.routCheckRadius;

    for (const other of nearby) {
      if (other === soldier) continue;
      if (!other.isAlive()) continue;

      const dx = other.pos.x - soldier.pos.x;
      const dz = other.pos.z - soldier.pos.z;
      const dSq = dx * dx + dz * dz;

      if (other.teamId === soldier.teamId) {
        allyStrength += other.effectiveMass;
        if (other.isRouting && dSq <= routRadiusSq) allyRoutingNearby = true;
      } else {
        enemyStrength += other.effectiveMass;
        if (dSq < nearestEnemyDistSq) {
          nearestEnemyDistSq = dSq;
          nearestEnemy = other;
        }
        if (other.isRouting && dSq <= routRadiusSq) enemyRoutingNearby = true;
      }
    }

    b.allyStrength = allyStrength;
    b.enemyStrength = enemyStrength;

    // --- Outnumbered ---
    if (enemyStrength > 0 && allyStrength > 0) {
      const ratio = enemyStrength / allyStrength;
      b.outnumberedRatio = ratio;
      const penalty = this._pickOutnumberedPenalty(ratio);
      if (penalty > 0) {
        delta -= penalty;
        b.outnumbered = -penalty;
      }
    }

    // --- Flanked ---
    if (nearestEnemy !== null) {
      const flankRadiusSq = cfg.flankCheckRadius * cfg.flankCheckRadius;
      let flanked = false;
      for (const other of nearby) {
        if (other === soldier) continue;
        if (!other.isAlive()) continue;
        if (other.teamId === soldier.teamId) continue;
        const dx = other.pos.x - soldier.pos.x;
        const dz = other.pos.z - soldier.pos.z;
        if (dx * dx + dz * dz > flankRadiusSq) continue;
        if (this._isFlanked(soldier, other, cfg.flankAngleDeg)) {
          flanked = true;
          break;
        }
      }
      if (flanked) {
        delta -= cfg.flankPenaltyPerTick;
        b.flanked = -cfg.flankPenaltyPerTick;
      }
    }

    // allyRout propagates a rout to non-routing soldiers. Skipped for
    // already-routing soldiers — they are already broken, and applying
    // it to them cancels their routing regen and traps them in a
    // permanent routing cluster.
    if (allyRoutingNearby && !soldier.isRouting) {
      delta -= cfg.allyRoutPenaltyPerTick;
      b.allyRout = -cfg.allyRoutPenaltyPerTick;
    }
    if (enemyRoutingNearby) {
      delta += cfg.enemyRoutBonusPerTick;
      b.enemyRout = cfg.enemyRoutBonusPerTick;
    }

    // --- Kill credit ---
    if (soldier.justKilled) {
      delta += cfg.killBonus;
      b.kill = cfg.killBonus;
      soldier.justKilled = false;
    }

    // Morale is intentionally NOT clamped to zero from below — a routing
    // soldier can accumulate deeply negative morale, and recovery from a
    // deep hole takes correspondingly longer. Upper bound stays at max.
    soldier.morale = Math.min(cfg.maxMorale, soldier.morale + delta);
    b.endMorale = soldier.morale;
    b.total = delta;

    if (AIDebugLog.isMoraleWatched(soldier.id)) {
      AIDebugLog.moraleTick(this._tick, soldier, b);
    }

    // --- State transitions ---
    if (!soldier.isRouting && soldier.morale <= 0) {
      // A fresh rout. Increment the per-battle counter, then decide
      // whether this break is a rout or a shatter.
      soldier.routCountThisBattle = (soldier.routCountThisBattle || 0) + 1;

      let shouldShatter = false;
      if (soldier.routCountThisBattle === 2) {
        // Second break: 30% rout, 70% shatter.
        if (Math.random() >= cfg.shatter.secondRoutRoutChance) {
          shouldShatter = true;
        }
      } else if (soldier.routCountThisBattle >= 3) {
        // Third-or-later break: always shatter.
        shouldShatter = true;
      }
      // Strength-floor check: if the unit is already below the shatter
      // threshold at the moment of breaking, shatter regardless of
      // rout count.
      if (this._shouldShatterForStrength(soldier, unitsById, aliveByUnit)) {
        shouldShatter = true;
      }

      soldier.isRouting = true;
      soldier.targetId = null;
      soldier.fleeDirection = { x: 0, z: 0 };
      if (shouldShatter) {
        soldier.state = 'shattered';
        AIDebugLog.log('morale', this._tick,
          `SHATTER soldier=${soldier.id} unit=${soldier.unitId} reason=rout#${soldier.routCountThisBattle} morale=${soldier.morale.toFixed(1)}`);
      } else {
        soldier.state = 'routing';
        AIDebugLog.moraleRout(this._tick, soldier, b);
      }
    } else if (soldier.isRouting &&
               soldier.state !== 'shattered' &&
               soldier.morale >= cfg.rallyThreshold) {
      // Rally is only valid for routing (not shattered) soldiers.
      soldier.isRouting = false;
      soldier.state = 'idle';
      soldier.fleeDirection = { x: 0, z: 0 };
      AIDebugLog.moraleRally(this._tick, soldier, b);
    }
  }

  // True if the soldier's unit has fallen below the faction strength
  // threshold (enemy 20%, player 10%). Measured against the count the
  // unit was deployed with (unit.soldiers.length), not a roster max.
  _shouldShatterForStrength(soldier, unitsById, aliveByUnit) {
    const unit = unitsById.get(soldier.unitId);
    if (!unit) return false;
    const deployed = unit.soldiers.length;
    if (deployed === 0) return false;
    const alive = aliveByUnit.get(soldier.unitId) ?? 0;
    const threshold = this._strengthThresholdFor(soldier.teamId);
    return alive / deployed < threshold;
  }

  _strengthThresholdFor(teamId) {
    if (this.playerTeamId && teamId === this.playerTeamId) {
      return MoraleConfig.shatter.playerStrengthThreshold;
    }
    return MoraleConfig.shatter.enemyStrengthThreshold;
  }

  // Walks the tier table top-down; the first tier whose ratio is met wins.
  _pickOutnumberedPenalty(ratio) {
    const tiers = MoraleConfig.outnumbered.tiers;
    for (const tier of tiers) {
      if (ratio >= tier.ratio) return tier.penaltyPerTick;
    }
    return 0;
  }

  _isFlanked(soldier, enemy, angleDeg) {
    const angleToEnemy = Math.atan2(
      enemy.pos.x - soldier.pos.x,
      enemy.pos.z - soldier.pos.z
    );
    let diff = Math.abs(angleToEnemy - soldier.facing);
    diff = diff % (2 * Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    return diff * (180 / Math.PI) >= angleDeg;
  }
}
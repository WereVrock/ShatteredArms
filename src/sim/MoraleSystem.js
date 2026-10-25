// ===== MoraleSystem.js =====
import { MoraleConfig } from '../config/MoraleConfig.js';
import { raceHasProperty } from '../config/RaceConfig.js';
import { Property } from '../config/Properties.js';
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

    // Per-unit tick until which morale regen is frozen. Set whenever the
    // unit loses a soldier (see update()); read by _updateSoldier to force
    // regen to zero while this._tick is below the stored value. See
    // MoraleConfig.casualtyRegenFreezeTicks.
    this._regenFrozenUntilByUnit = new Map();

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
      casualtyRegenMult: 1.0,
      frozen: false,
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

  update(allSoldiers, unitsById, debugHistoryEnabled) {
    const aliveByUnit = new Map();
    for (const [unitId, unit] of unitsById) {
      aliveByUnit.set(unitId, unit.getAliveSoldiers().length);
    }

    // Regen-freeze pass. Any unit that lost at least one soldier since
    // the previous tick has its regen frozen for casualtyRegenFreezeTicks.
    // A unit that keeps losing soldiers keeps resetting the window, which
    // is the intended cascade behaviour: a unit under sustained pressure
    // never gets a clear tick to recover morale. Runs BEFORE the
    // per-soldier loop so every soldier sees this tick's freeze state.
    const freezeTicks = MoraleConfig.casualtyRegenFreezeTicks;
    if (freezeTicks > 0) {
      for (const [unitId, alive] of aliveByUnit) {
        const prev = this._previousAliveByUnit.get(unitId);
        if (prev !== undefined && alive < prev) {
          this._regenFrozenUntilByUnit.set(unitId, this._tick + freezeTicks);
        }
      }
    }

    // Debug history feed. When enabled, clear the last-tick morale
    // breakdown on EVERY soldier before the per-soldier pass, so a
    // soldier whose path early-returns (undead, shattered, routing-
    // strength-shatter) leaves a null rather than a stale breakdown from
    // a previous tick. Attaching the fresh breakdown happens at the end
    // of _updateSoldier — see there. Enabled once per battle the first
    // time debug is engaged; stays on for the rest of the battle.
    if (debugHistoryEnabled) {
      for (const s of allSoldiers) s.lastMoraleBreakdown = null;
    }

    for (const soldier of allSoldiers) {
      if (!soldier.isAlive()) continue;

      // Thralls (Blood Thrall skill) skip morale entirely. They are not a
      // coherent fighting formation — they are flesh animated by the
      // champion's will — and they do not rout, rally, or react to allies
      // or enemies. Forced to max morale every tick so nothing downstream
      // reads a stale value.
      if (soldier.isThrall) {
        soldier.morale = soldier.maxMorale;
        soldier.justKilled = false;
        if (soldier.isRouting) {
          soldier.isRouting = false;
          soldier.state = 'idle';
          soldier.fleeDirection = { x: 0, z: 0 };
        }
        continue;
      }

      // Undead do not rout. Forced to max morale every tick so they cannot
      // accumulate a morale deficit, and any routing state is cleared on
      // sight — undead routing is never valid.
      if (soldier.isUndead) {
        soldier.morale = soldier.maxMorale;
        soldier.justKilled = false;
        if (soldier.isRouting) {
          soldier.isRouting = false;
          soldier.state = 'idle';
          soldier.fleeDirection = { x: 0, z: 0 };
        }
        continue;
      }

      this._updateSoldier(soldier, unitsById, aliveByUnit, debugHistoryEnabled);
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

  _updateSoldier(soldier, unitsById, aliveByUnit, debugHistoryEnabled) {
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
    b.casualtyRegenMult = 1.0;
    b.frozen = false;
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

    // --- Casualty fraction (drives regen scaling and effective morale cap) ---
    //
    // Casualties do NOT apply a passive per-tick drain. That was the
    // previous design and it was removed: a unit that traded 1-for-3
    // against an enemy formation and wiped it still bled morale every
    // tick from the loss ratio, and could route after a decisive
    // victory. Casualties now:
    //   (a) scale REGEN linearly — a heavily attrited unit recovers
    //       morale more slowly, without being actively drained, and
    //   (b) lower the EFFECTIVE MAX MORALE — the ceiling a soldier can
    //       climb to shrinks with cumulative losses, so a battered unit
    //       cannot recover back to full even when left alone.
    const unit = unitsById.get(soldier.unitId);
    const aliveNow = aliveByUnit.get(soldier.unitId) ?? 0;
    const totalNow = unit ? unit.soldiers.length : 0;
    const casualtyFrac = totalNow > 0 ? 1 - aliveNow / totalNow : 0;

    // Linear regen scaling. See MoraleConfig.casualtyRegenSlope for the
    // curve and the rationale for dropping the earlier parabola.
    const regenSlope = cfg.casualtyRegenSlope ?? 0.7;
    const regenFloor = cfg.casualtyRegenFloor ?? 0.3;
    const casualtyRegenMult = Math.max(regenFloor, 1 - regenSlope * casualtyFrac);
    b.casualtyRegenMult = casualtyRegenMult;

    // Effective max morale, shrunk by cumulative losses. Mutating the
    // field (rather than computing a local) means the HUD, the rally
    // threshold below, and the clamp at the end of this function all
    // see the same number without any extra plumbing. baseMaxMorale is
    // the race's original cap; maxMorale is the current dynamic one.
    const divisor = cfg.casualtyMaxMoraleDivisor ?? 3;
    const baseMaxMorale = soldier.baseMaxMorale ?? soldier.maxMorale;
    soldier.maxMorale = baseMaxMorale * (1 - casualtyFrac / divisor);

    // Regen freeze window. When any soldier of this unit died on a
    // recent tick, the whole unit's morale regen is zeroed until the
    // window expires. The freeze is UNIFORM — it applies to idle regen
    // and routing regen alike, because the trigger is a shared event
    // (a comrade fell) rather than a per-soldier state.
    const frozenUntil = this._regenFrozenUntilByUnit.get(soldier.unitId) ?? -Infinity;
    const frozen = this._tick < frozenUntil;
    b.frozen = frozen;

    // Passive regen only applies OUT of combat. A soldier currently
    // engaged, staggered, or shooting is under pressure — morale cannot
    // recover while the fight is on. Routing soldiers keep their bonus.
    // Regen is then SCALED by the casualty multiplier computed above,
    // and zeroed outright while the freeze is active.
    const inCombat = soldier.state === 'engaged' ||
                     soldier.state === 'staggered' ||
                     soldier.state === 'ranged';
    const rawRegen = soldier.isRouting
      ? cfg.regenPerTick + cfg.routingRegenBonus
      : (inCombat ? 0 : cfg.regenPerTick);
    const regen = frozen ? 0 : rawRegen * casualtyRegenMult;
    let delta = regen;
    b.regen = regen;

    // --- Own HP ---
    const hpRatio = soldier.hp / soldier.maxHp;
    if (hpRatio < 0.5) {
      const penalty = cfg.hpPenaltyMaxPerTick * ((0.5 - hpRatio) / 0.5);
      delta -= penalty;
      b.hp = -penalty;
    }

    // --- One-shot morale hit for losses THIS tick ---
    //
    // The persistent casualty-ratio drain that used to live here was
    // removed. See MoraleConfig.casualtyRegenParabola for the rationale
    // and the replacement mechanism (regen scaling, applied above).
    // This block now carries only the one-shot shock for a soldier
    // dying on this specific tick — "your friend just fell" — which
    // fires once per death, not once per tick while the unit is below
    // full strength.
    if (unit) {
      const alive = aliveByUnit.get(soldier.unitId) ?? 0;
      const prev = this._previousAliveByUnit.get(soldier.unitId) ?? alive;
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
    // Ally routs are split by EXPENDABLE status (see Properties.js) so the
    // penalty application below can weigh them separately: an expendable
    // rout costs non-expendables nothing, and costs other expendables a
    // reduced penalty. A single boolean would lose that distinction.
    let expendableRoutNearby = false;
    let nonExpendableRoutNearby = false;
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
        if (other.isRouting && dSq <= routRadiusSq) {
          if (raceHasProperty(other.unitTypeDef, Property.EXPENDABLE)) {
            expendableRoutNearby = true;
          } else {
            nonExpendableRoutNearby = true;
          }
        }
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
    //
    // EXPENDABLE (see Properties.js): a routing expendable is treated as
    // not worth panicking over. Non-expendable observers take NO penalty
    // from an expendable rout; other expendables take a reduced penalty
    // (MoraleConfig.expendableAllyRoutPenaltyMult). A non-expendable
    // rout is unaffected — it always applies the full penalty, because
    // a real line unit breaking is a real line unit breaking.
    if (!soldier.isRouting && (nonExpendableRoutNearby || expendableRoutNearby)) {
      let routPenalty = 0;
      if (nonExpendableRoutNearby) {
        routPenalty += cfg.allyRoutPenaltyPerTick;
      }
      if (expendableRoutNearby) {
        const soldierIsExpendable =
          raceHasProperty(soldier.unitTypeDef, Property.EXPENDABLE);
        // Non-expendable observers take zero from an expendable rout;
        // expendable observers take the config fraction.
        const mult = soldierIsExpendable
          ? cfg.expendableAllyRoutPenaltyMult
          : 0;
        routPenalty += cfg.allyRoutPenaltyPerTick * mult;
      }
      if (routPenalty > 0) {
        delta -= routPenalty;
        b.allyRout = -routPenalty;
      }
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
    // deep hole takes correspondingly longer. Upper bound is the soldier's
    // OWN morale ceiling, not the global MoraleConfig.maxMorale. A race
    // that ships a lower ceiling (goblins, maxMoraleMultiplier 0.7) must
    // not be able to exceed it — the previous global clamp let a goblin
    // soldier regen past its own 70 ceiling toward the human 100, silently
    // granting back the resilience the race is designed to lack. See
    // Soldier.maxMorale.
    soldier.morale = Math.min(soldier.maxMorale, soldier.morale + delta);
    b.endMorale = soldier.morale;
    b.total = delta;

    if (AIDebugLog.isMoraleWatched(soldier.id)) {
      AIDebugLog.moraleTick(this._tick, soldier, b);
    }

    // Debug history feed. Attach a shallow copy of this tick's breakdown
    // to EVERY soldier while history logging is enabled for the battle.
    // UnitHistoryTracker reads it to name the specific sources that
    // drove each morale delta. The scratch object `b` is reused across
    // every soldier in the pass, so the fields must be copied — storing
    // the reference would let the next soldier's pass overwrite it.
    //
    // Zero cost in normal play: the flag is set once, and only the first
    // time debug mode is engaged in a battle.
    if (debugHistoryEnabled) {
      soldier.lastMoraleBreakdown = {
        regen: b.regen,
        casualtyRegenMult: b.casualtyRegenMult,
        frozen: b.frozen,
        hp: b.hp,
        casualtyLoss: b.casualtyLoss,
        outnumbered: b.outnumbered,
        outnumberedRatio: b.outnumberedRatio,
        flanked: b.flanked,
        allyRout: b.allyRout,
        enemyRout: b.enemyRout,
        kill: b.kill,
        adjacentWiped: b.adjacentWiped,
        total: b.total
      };
    }

    // --- State transitions ---
    //
    // Rally threshold scales with the soldier's RACE ceiling
    // (baseMaxMorale), NOT with the casualty-reduced current ceiling
    // (maxMorale). The original scaling used maxMorale, which was
    // meant to preserve relative resilience across races (a goblin
    // with a 70 ceiling should rally at 70% of the human threshold,
    // not fail to rally ever). But maxMorale is itself shrunk by the
    // casualtyMaxMoraleDivisor formula above, so the rally threshold
    // tumbled as casualties accumulated — the more beaten a unit got,
    // the EASIER it was to rally. Observed symptom: goblin units
    // routing at t535 and rallying back to full strength at t670
    // (~6 seconds) at morale 58, well below the nominal 92.
    //
    // Anchoring on baseMaxMorale restores the intended race-relative
    // scaling without the casualty feedback. The threshold is now a
    // fixed value per race:
    //   human  92 * (100/100) = 92.0
    //   goblin 92 * ( 70/100) = 64.4
    //
    // Because maxMorale still drops with casualties, a heavily-battered
    // soldier's ceiling falls below the fixed threshold and the
    // `soldier.morale >= rallyThreshold` check can never fire again —
    // the soldier is permanently routed (until shatter or extraction).
    // The natural crossover is at ~24% casualties for both races,
    // because 1 - cf/3 = 0.92 when cf = 0.24. A unit that has taken
    // fewer than ~24% losses can still rally; a unit past that point
    // is spent. Matches the intended "a unit that has lost a quarter
    // of its men does not reform in the field" reading.
    //
    // See MoraleConfig.rallyThreshold for the absolute base value.
    const rallyThreshold =
      cfg.rallyThreshold * (soldier.baseMaxMorale / cfg.maxMorale);

    if (!soldier.isRouting && soldier.morale <= 0) {
      // Devoted bodyguards (champion Retinue tier 2) never break while
      // their champion still stands AND still fights. The gate is on the
      // champion ROUTING, not merely being alive: once the Warlord breaks
      // and runs, the guard's composure breaks with them and they can
      // rout normally. A dead champion also releases the gate.
      //
      // Morale is clamped to a floor of 1 so the soldier does not sit at 0
      // and re-trigger this check every tick.
      if (soldier.cannotRoutWhileChampionLives
          && soldier.championRef
          && soldier.championRef.isAlive()
          && !soldier.championRef.isRouting) {
        soldier.morale = Math.max(1, soldier.morale);
        soldier.justKilled = false;
        return;
      }

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
               soldier.morale >= rallyThreshold) {
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
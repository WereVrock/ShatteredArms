import { CombatConfig, WeaponMatchup, SkeletonDamageModifiers, DefenderCategoryDamageModifiers } from '../config/CombatConfig.js';
import { toSimSpeed } from '../config/SpeedScale.js';
import { isCavalry } from '../config/UnitClasses.js';
import { ShieldBlockCalculator } from './ShieldBlockCalculator.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';

// Runs one tick of melee attack resolution for all engaged soldiers.
//
// Damage modifiers, in the order they apply:
//   1. Base weapon damage (WeaponMatchup).
//   2. Skeleton-vs-weapon-type modifier — skipped when the attacker is a
//      sword hitting a spearman from the front (see rule 3).
//   3. Sword-vs-spearman-from-front: damage × 1/3 and no attack-speed bonus.
//   4. Defender-category modifier (e.g. spear +75% vs cavalry).
//   5. Flanking multiplier (side ×1.25, rear ×1.5).
//   6. Charge bonus (mass-based) + THROW, applied last so it scales on the
//      already-adjusted base. Skipped entirely when the defender is braced.
//
// Throw: on a qualifying charge hit, the defender gets an initial velocity
// proportional to the attacker's momentum and inverse-mass, capped, and
// multiplied by 1.5 if the defender is undead. MovementSystem integrates
// that velocity over the next few ticks — see MovementSystem._applyThrow.
// A dead defender is still thrown (corpse is launched).
//
// Brace (spearman vs charging cavalry):
//   A stationary spearman facing the charge negates the cavalry's entire
//   charge bonus AND the throw, and deals counter damage back to the charger.
//
// Attack cooldown:
//   baseMeleeCooldownTicks / attackSpeedMultiplier, floored at 1 tick.
//   The sword's attack-speed bonus is nullified against a spearman from the
//   front (cooldown falls back to the base 4 ticks).
//
// Routing soldiers neither attack nor defend — they flee.
export class CombatResolutionSystem {
  constructor() {
    this.events = [];
  }

  drainEvents() {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  update(allSoldiers, unitsById) {
    const byId = new Map(allSoldiers.map(s => [s.id, s]));

    for (const attacker of allSoldiers) {
      if (!attacker.isAlive()) continue;

      if (attacker.state === 'knockedDown') {
        attacker.knockedDownTicksLeft--;
        if (attacker.knockedDownTicksLeft <= 0) attacker.state = 'idle';
        continue;
      }

      if (attacker.state === 'routing' || attacker.state === 'shattered') continue;
      if (attacker.state !== 'engaged') continue;

      if (attacker.staggerTicksLeft > 0) {
        attacker.staggerTicksLeft--;
        if (attacker.staggerTicksLeft === 0) attacker.state = 'engaged';
        continue;
      }

      const defender = attacker.targetId ? byId.get(attacker.targetId) : null;
      if (!defender || !defender.isAlive()) {
        attacker.targetId = null;
        attacker.state = 'idle';
        continue;
      }

      if (attacker.attackCooldownTicks > 0) {
        attacker.attackCooldownTicks--;
        continue;
      }

      this._resolveAttack(attacker, defender, unitsById);
      attacker.fatigue = Math.max(0, attacker.fatigue - CombatConfig.fatigue.drainPerAttack);
    }

    this._regenerateIdleFatigue(allSoldiers);
  }

  _resolveAttack(attacker, defender, unitsById) {
    const matchup = WeaponMatchup[attacker.unitTypeDef.weaponType];
    if (!matchup) return;

    const angleOff = ShieldBlockCalculator.computeAngleOffShield(defender, attacker.pos);

    const isSword = attacker.unitTypeDef.weaponType === 'sword';
    const defenderIsSpearman = defender.unitTypeDef.weaponType === 'spear';

    // Spear wall cohesion is a FORMATION property, not a personal one.
    // For a spearman defender, flank geometry is measured against the
    // UNIT's formationFacing rather than the individual soldier's
    // facing — see CombatConfig.spearHandling.wallBrokenArcDeg for the
    // full rationale. A spearman who pivots to face a flanker does not
    // restore the wall.
    //
    // Non-spearman defenders keep the original soldier-facing angle and
    // the original 90-degree side threshold. This asymmetry is
    // deliberate: a swordsman's guard is a personal stance, a spearwall
    // is a formation.
    let angleForFlank = angleOff;
    let sideThresholdDeg = CombatConfig.flank.sideArcDeg;
    if (defenderIsSpearman) {
      angleForFlank = this._computeAngleOffUnitFacing(defender, attacker.pos, unitsById);
      sideThresholdDeg = CombatConfig.spearHandling.wallBrokenArcDeg;
    }

    const frontalVsSpearman =
      isSword && defenderIsSpearman && angleForFlank < sideThresholdDeg;

    const speedMult = frontalVsSpearman
      ? 1
      : (attacker.unitTypeDef.attackSpeedMultiplier ?? 1);
    attacker.attackCooldownTicks = Math.max(
      1,
      Math.round(CombatConfig.baseMeleeCooldownTicks / speedMult)
    );

    this.events.push({ type: 'attack', attackerId: attacker.id, defenderId: defender.id });

    const chargeCfg = CombatConfig.charge;
    // Compare in one space: currentSpeed is SIM, config threshold is
    // DESIGN. See src/config/SpeedScale.js for the contract.
    const isCharging = attacker.currentSpeed >= toSimSpeed(chargeCfg.speedThreshold);
    const massRatio = attacker.effectiveMass / defender.effectiveMass;
    const isChargingCavalry = isCavalry(attacker.unitTypeDef) &&
      isCharging &&
      massRatio >= chargeCfg.minMassRatioForKnockback;

    if (isChargingCavalry) {
      const angleOffForLog = ShieldBlockCalculator.computeAngleOffShield(defender, attacker.pos);
      const wouldBrace = this._isBracedSpearman(defender, attacker.pos);
      AIDebugLog.braceOutcome(0, attacker.id, defender.id, wouldBrace, angleOffForLog);
    }

    const defenderBraced = isChargingCavalry && this._isBracedSpearman(defender, attacker.pos);
    if (defenderBraced) {
      this._applyBraceCounter(defender, attacker);
      this.events.push({ type: 'brace', attackerId: attacker.id, defenderId: defender.id });
      if (!attacker.isAlive()) return;
    }

    const hitRoll = Math.random();
    const toHitChance = CombatConfig.baseToHitChance * matchup.toHitMod;
    if (hitRoll > toHitChance) {
      this.events.push({ type: 'miss', attackerId: attacker.id, defenderId: defender.id });
      return;
    }

    // Flanking sword hit on an undead defender: the blade finds the gap
    // between ribs and the skeleton comes apart. Instant kill — no block
    // roll, no damage calc, no shield. The to-hit roll above still applies
    // (a miss is a miss), but a landed flanking sword strike does not
    // negotiate with bone. This is the mechanical payoff that makes swords
    // the anti-skeleton unit: a sword unit that successfully flanks an
    // undead spear line deletes it, which is the concrete reason to build
    // swords rather than more spears. Non-undead spear defenders are
    // unaffected — the frontal penalty / flank multiplier math runs
    // normally for them.
    const flankingSwordVsUndead =
      isSword && defender.isUndead &&
      angleOff >= CombatConfig.flank.sideArcDeg;

    if (flankingSwordVsUndead) {
      defender.hp = 0;
      defender.state = 'dead';
      defender.targetId = null;
      this.events.push({ type: 'hit', attackerId: attacker.id, defenderId: defender.id });
      this.events.push({ type: 'death', defenderId: defender.id });
      AIDebugLog.combatHit(0, attacker.id, defender.id,
        defender.maxHp, 0, defender.maxHp);
      AIDebugLog.combatDeath(0, defender.id, defender.unitId);
      attacker.justKilled = true;
      attacker.targetId = null;
      attacker.state = 'idle';
      return;
    }

    defender.fatigue = Math.max(0, defender.fatigue - CombatConfig.fatigue.drainPerBlockAttempt);

    let blockChance = ShieldBlockCalculator.computeBlockChance(
      defender, attacker.pos, attacker.unitTypeDef.weaponType
    );
    if (isCharging) {
      blockChance *= (1 - chargeCfg.blockChancePenaltyWhileCharging);
    }

    const blocked = Math.random() < blockChance;

    if (blocked) {
      defender.shieldHp -= matchup.shieldDamage;
      this.events.push({ type: 'block', attackerId: attacker.id, defenderId: defender.id });

      if (defender.shieldHp <= 0) {
        defender.shieldHp = 0;
        defender.hasShield = false;
        this.events.push({ type: 'shieldBreak', defenderId: defender.id });
      }
      return;
    }

    let damage = matchup.damage;

    if (defender.isUndead && !frontalVsSpearman) {
      const mod = SkeletonDamageModifiers[attacker.unitTypeDef.weaponType];
      if (mod !== undefined) damage *= mod;
    }

    if (frontalVsSpearman) {
      damage *= 1 / 3;
    }

    const defenderCategory = isCavalry(defender.unitTypeDef) ? 'cavalry' : null;
    if (defenderCategory) {
      const catMods = DefenderCategoryDamageModifiers[defenderCategory];
      if (catMods) {
        const mod = catMods[attacker.unitTypeDef.weaponType];
        if (mod !== undefined) damage *= mod;
      }
    }

    // Flank damage multipliers use angleForFlank — for a spearman
    // defender that is the unit-facing angle with wallBrokenArcDeg as
    // the side threshold; for everyone else it is the individual
    // soldier-facing angle with flank.sideArcDeg. Rear arc is
    // CombatConfig.flank.rearArcDeg in both cases (150).
    const flankCfg = CombatConfig.flank;
    if (angleForFlank >= flankCfg.rearArcDeg) {
      damage *= flankCfg.rearDamageMult;
    } else if (angleForFlank >= sideThresholdDeg) {
      damage *= flankCfg.sideDamageMult;
    }

    if (isCharging && massRatio >= chargeCfg.minMassRatioForKnockback && !defenderBraced) {
      let bonusDamage = (massRatio - 1) * chargeCfg.bonusDamagePerMassRatio;

      if (defender.isUndead) {
        bonusDamage *= chargeCfg.skeletonChargeDamageMult;
      }

      damage += bonusDamage;

      this._applyThrow(attacker, defender);

      defender.state = 'knockedDown';
      defender.knockedDownTicksLeft = chargeCfg.knockedDownDurationTicks;
      this.events.push({ type: 'knockdown', attackerId: attacker.id, defenderId: defender.id });
    }

    // Non-charge mass shove: a heavy attacker shoves a lighter defender on
    // any unblocked hit, charge or not. One-tick nudge, not a throw.
    if (!isCharging &&
        !defenderBraced &&
        massRatio >= chargeCfg.minMassRatioForKnockback) {
      const shove = (massRatio - 1) * chargeCfg.normalShovePerMassRatio;
      const capped = Math.min(chargeCfg.maxNormalShove, shove);
      this._applyNudge(attacker, defender, capped);
    }

    defender.hp -= damage;
    this.events.push({ type: 'hit', attackerId: attacker.id, defenderId: defender.id });
    AIDebugLog.combatHit(0, attacker.id, defender.id, damage, Math.max(0, defender.hp), defender.maxHp);

    if (defender.state !== 'knockedDown' && matchup.damage >= matchup.staggerThreshold) {
      defender.state = 'staggered';
      defender.staggerTicksLeft = CombatConfig.staggerDurationTicks;
      this.events.push({ type: 'stagger', defenderId: defender.id });
    }

    if (defender.hp <= 0) {
      defender.hp = 0;
      defender.state = 'dead';
      defender.targetId = null;
      this.events.push({ type: 'death', defenderId: defender.id });
      AIDebugLog.combatDeath(0, defender.id, defender.unitId);
      attacker.justKilled = true;
      attacker.targetId = null;
      attacker.state = 'idle';
    }
  }

  // One-tick nudge. Used for the small non-charge shove.
// Angle from the DEFENDER'S UNIT formationFacing to the attacker, in
  // degrees. Same convention as ShieldBlockCalculator.computeAngleOffShield
  // (0 = directly ahead of the facing direction, 180 = directly behind),
  // but the reference direction is the unit's facing, not the soldier's.
  //
  // Used only for spearwall coherence — the wall is a formation property,
  // so the reference is the formation's facing. Falls back to the
  // soldier's facing if the unit lookup misses (defensive; should never
  // happen in normal play).
  _computeAngleOffUnitFacing(defender, attackerPos, unitsById) {
    const unit = unitsById ? unitsById.get(defender.unitId) : null;
    const facing = unit ? unit.formationFacing : defender.facing;

    const toAttacker = Math.atan2(
      attackerPos.x - defender.pos.x,
      attackerPos.z - defender.pos.z
    );
    let diff = Math.abs(toAttacker - facing);
    diff = diff % (2 * Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    return diff * (180 / Math.PI);
  }

  // One-tick nudge. Used for the small non-charge shove.
  _applyNudge(attacker, defender, distance) {
    const dx = defender.pos.x - attacker.pos.x;
    const dz = defender.pos.z - attacker.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= 0.001) return;

    defender.pos.x += (dx / dist) * distance;
    defender.pos.z += (dz / dist) * distance;
  }

  // Charge throw: gives the defender a real velocity that MovementSystem
  // integrates over the next few ticks. Distance scales with attacker
  // momentum and inverse defender mass; skeletons fly further.
  _applyThrow(attacker, defender) {
    const cfg = CombatConfig.charge;
    const dx = defender.pos.x - attacker.pos.x;
    const dz = defender.pos.z - attacker.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= 0.001) return;

    const momentum = attacker.effectiveMass * attacker.currentSpeed;
    const massRatio = attacker.effectiveMass / defender.effectiveMass;

    let vel = momentum * cfg.knockbackVelocityPerMomentum;
    vel *= Math.min(
      cfg.maxThrowMassRatioScale,
      massRatio / cfg.minMassRatioForKnockback
    );
    vel = Math.min(vel, cfg.maxKnockbackVelocity);

    // Skeleton mult applied AFTER the cap so brittle bone really goes flying.
    if (defender.isUndead) vel *= cfg.skeletonKnockbackMult;

    defender.knockbackVel.x = (dx / d) * vel;
    defender.knockbackVel.z = (dz / d) * vel;
    defender.airborneTicksLeft = cfg.knockbackDurationTicks;
    defender.airborneTotalTicks = cfg.knockbackDurationTicks;
    defender.throwPeakHeight = Math.min(
      cfg.maxThrowHeight,
      vel * cfg.throwHeightPerVelocity
    );
  }

  _isBracedSpearman(spearman, chargerPos) {
    if (spearman.unitTypeDef.weaponType !== 'spear') return false;
    if (spearman.state === 'knockedDown') return false;
    if (spearman.movedThisTick) return false;
    // A spear whose tip is raised out of the sweep plane is not planted
    // in the ground awaiting a charge — no brace regardless of facing.
    if (spearman.spearRaiseAmount > 0.1) return false;
    const angleOff = ShieldBlockCalculator.computeAngleOffShield(spearman, chargerPos);
    return angleOff <= CombatConfig.brace.frontalArcDeg;
  }

  _applyBraceCounter(spearman, charger) {
    const matchup = WeaponMatchup[spearman.unitTypeDef.weaponType];
    if (!matchup) return;

    let dmg = matchup.damage;

    const catMods = DefenderCategoryDamageModifiers.cavalry;
    if (catMods) {
      const mod = catMods[spearman.unitTypeDef.weaponType];
      if (mod !== undefined) dmg *= mod;
    }

    dmg *= CombatConfig.brace.counterDamageMult;

    charger.hp -= dmg;
    this.events.push({ type: 'braceCounter', attackerId: spearman.id, defenderId: charger.id });

    if (charger.hp <= 0) {
      charger.hp = 0;
      charger.state = 'dead';
      charger.targetId = null;
      this.events.push({ type: 'death', defenderId: charger.id });
      spearman.justKilled = true;
    }
  }

  _regenerateIdleFatigue(allSoldiers) {
    for (const s of allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.state === 'idle' || s.state === 'marching') {
        s.fatigue = Math.min(CombatConfig.fatigue.max, s.fatigue + CombatConfig.fatigue.regenPerTickIdle);
      }
    }
  }
}
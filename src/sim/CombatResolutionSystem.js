import { CombatConfig, WeaponMatchup, SkeletonDamageModifiers, DefenderCategoryDamageModifiers } from '../config/CombatConfig.js';
import { toSimSpeed } from '../config/SpeedScale.js';
import { isCavalry } from '../config/UnitClasses.js';
import { raceOf, raceHasProperty } from '../config/RaceConfig.js';
import { Property } from '../config/Properties.js';
import { ShieldBlockCalculator } from './ShieldBlockCalculator.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';

// Fraction of a blood guard's combat XP that is additionally credited to
// the champion they guard. See CombatResolutionSystem._accrueChampionXp.
// Guards are flagged isBodyguard and carry a championRef back-reference
// (set in CampaignBattleBuilder.applyChampionToUnit).
const BODYGUARD_CHAMPION_XP_SHARE = 0.5;

// Runs one tick of melee attack resolution for all engaged soldiers.
//
// Damage modifiers, in the order they apply:
//   0. Attacker race outgoing multiplier (see RaceConfig.js).
//   1. Base weapon damage (WeaponMatchup).
//   2. Defender race incoming multiplier keyed by attacker weapon type.
//   3. Skeleton-vs-weapon-type modifier — skipped when the attacker is a
//      sword hitting a spearman from the front (see rule 4).
//   4. Sword-vs-spearman-from-front: damage × 1/3 and no attack-speed bonus.
//   5. Defender-category modifier (e.g. spear +75% vs cavalry).
//   6. Flanking multiplier (side ×1.25, rear ×1.5).
//   7. Charge bonus (mass-based) + THROW, applied last so it scales on the
//      already-adjusted base. Skipped entirely when the defender is braced.
//
// Steps 0 and 2 are both multiplicative, so their placement relative to
// steps 3-6 does not change the total. They are applied early so the
// additive charge bonus in step 7 is added on top of the race-scaled base
// (momentum is physics, not weapon damage).
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
    // Internal tick counter. Used only to gate tick-based cooldowns
    // (Blood Fury). Not exposed outside this class — the sim's global
    // tick order is not required anywhere in this system beyond
    // "cooldowns decrease by one each update()".
    this._tick = 0;
  }

  drainEvents() {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  update(allSoldiers, unitsById) {
    this._tick++;
    const byId = new Map(allSoldiers.map(s => [s.id, s]));

    for (const attacker of allSoldiers) {
      if (!attacker.isAlive()) continue;

      // Stagger ticks down unconditionally, BEFORE any state gate.
      //
      // The previous implementation ticked this inside the 'engaged'
      // branch, which produced two bugs:
      //   1. An arrow-staggered soldier whose pre-stagger state was
      //      'marching'/'idle' was never ticked — they sat in 'staggered'
      //      forever with no melee action available to advance the timer.
      //   2. A melee-staggered soldier's state was set to 'staggered' by
      //      _resolveAttack, which immediately failed the `state !==
      //      'engaged'` gate above, so the tick block was unreachable for
      //      exactly the soldiers it was written for.
      //
      // On expiry, restore the state the soldier held when the stagger
      // landed (stateBeforeStagger) rather than hard-coding 'engaged',
      // so an out-of-combat stagger returns the soldier to marching/idle
      // and a melee stagger returns them to engaged. The `state ===
      // 'staggered'` check guards against a soldier who was knocked down
      // mid-stagger — their state is 'knockedDown' now, and we must not
      // clobber the knockdown by restoring the old logical state here.
      if (attacker.staggerTicksLeft > 0) {
        attacker.staggerTicksLeft--;
        if (attacker.staggerTicksLeft === 0 && attacker.state === 'staggered') {
          attacker.state = attacker.stateBeforeStagger || 'idle';
          attacker.stateBeforeStagger = null;
        }
      }

      if (attacker.state === 'knockedDown') {
        attacker.knockedDownTicksLeft--;
        if (attacker.knockedDownTicksLeft <= 0) attacker.state = 'idle';
        continue;
      }

      if (attacker.state === 'routing' || attacker.state === 'shattered') continue;

      // Which soldier is this attacker hitting this tick?
      //
      // An engaged soldier fights its persistent targetId, as before.
      // A marching or impetuous soldier whose ContactAttackSystem pass
      // found an enemy in its forward arc this tick fights that
      // transient contact instead. The soldier never leaves its
      // movement state: it walks and swings in the same tick, and
      // resumes pure movement the moment contact is lost.
      let defenderId;
      let isPassingAttack = false;
      if (attacker.state === 'engaged') {
        defenderId = attacker.targetId;
      } else if ((attacker.state === 'marching' || attacker.state === 'impetuous') &&
                 attacker.contactTargetId) {
        defenderId = attacker.contactTargetId;
        isPassingAttack = true;
      } else {
        continue;
      }

      const defender = defenderId ? byId.get(defenderId) : null;
      if (!defender || !defender.isAlive()) {
        if (isPassingAttack) {
          // Contact ended — target died or was removed. Clear the
          // contact so ContactAttackSystem can re-detect next tick.
          // The soldier keeps its state and continues its order.
          attacker.contactTargetId = null;
          attacker.contactChargeBonusSpent = false;
        } else {
          attacker.targetId = null;
          attacker.state = 'idle';
        }
        continue;
      }

      if (attacker.attackCooldownTicks > 0) {
        attacker.attackCooldownTicks--;
        continue;
      }

      this._resolveAttack(attacker, defender, unitsById);
      attacker.fatigue = Math.max(0,
        attacker.fatigue
        - CombatConfig.fatigue.drainPerAttack * attacker.fatigueDrainMultiplier);
    }

    this._regenerateIdleFatigue(allSoldiers);
  }

_resolveAttack(attacker, defender, unitsById) {
    // -------------------------------------------------------------------
    // TOOLTIP MIRROR
    //
    // The Weapon row's tooltip in UnitInfoPanel.WEAPON_TOOLTIPS describes
    // the outcomes produced below. Update the matching tooltip entry if
    // you change any of:
    //
    //   sword tooltip:
    //     - sword-vs-spearman-from-front: damage cut to 1/3 and the
    //       sword's attack-speed advantage nullified (the `frontalVsSpearman`
    //       branch, and the `baseSpeedMult` selection above it).
    //     - sword flanking an undead defender: instant kill that bypasses
    //       shield block entirely (the `flankingSwordVsUndead` branch).
    //
    //   lance tooltip:
    //     - charge bonus damage scaling with attacker:defender mass ratio
    //       (the `isCharging` branch, gated on minMassRatioForKnockback).
    //     - throw + knockdown on a qualifying charge hit (see _applyThrow,
    //       called from the same branch).
    //
    // Per-weapon numeric values (damage, toHitMod, shieldDamage,
    // staggerThreshold) live in CombatConfig.WeaponMatchup — that file
    // carries its own TOOLTIP MIRROR note.
    // -------------------------------------------------------------------
    const matchup = WeaponMatchup[attacker.unitTypeDef.weaponType];
    if (!matchup) return;

    // --- Champion XP accrual ---------------------------------------------
    // Every melee attack roll credits XP to any champion involved —
    // attacker side when the champion swings, defender side when the
    // champion is swung at. Hit or miss, both directions. The diminishing
    // curve is applied by the campaign layer at battle end; the sim only
    // accumulates raw.
    //
    // soldierPowerCache is refreshed once per sim tick by
    // BattleSimulation._updateSoldierPowerCache and equals
    // (unit power / non-routing alive soldiers), so a swing at an elite
    // unit teaches the champion more than a swing at chaff.
    this._accrueChampionXp(attacker, defender);

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

    // Attacker combat mods. Generic: both the champion and the champion's
    // bodyguards (and any future captain) carry a combatMods object with
    // the same vocabulary. null means no mods.
    const championMods = attacker.combatMods || null;
    const championSpeedMult = championMods?.attackSpeedMult ?? 1;
    const baseSpeedMult = frontalVsSpearman
      ? 1
      : (attacker.unitTypeDef.attackSpeedMultiplier ?? 1);
    // Fatigue-based slowdown. A fresh soldier (fatigue 100) has a
    // multiplier of 1.0 and swings at full speed; a fully exhausted
    // soldier (fatigue 0) swings at
    // CombatConfig.fatigue.minAttackSpeedMultiplierAtZeroFatigue —
    // 0.6, so a 4-tick spear swing stretches to 7 ticks and a 1.2x
    // sword's 3-tick swing stretches to 6 ticks. Linear in between,
    // mirroring the existing minBlockMultiplierAtZeroFatigue curve so
    // block chance and attack speed degrade together as stamina
    // drains. See Soldier.fatigueAttackSpeedMultiplier for the curve.
    //
    // Applied to speedMult (not to the cooldown directly) so the
    // clamp on the final cooldown — Math.max(1, Math.round(...)) — is
    // shared with the weapon and champion multipliers, and a slower
    // weapon with fatigue cannot produce a cooldown below 1.
    const fatigueSpeedMult = attacker.fatigueAttackSpeedMultiplier ?? 1.0;
    const speedMult = baseSpeedMult * championSpeedMult * fatigueSpeedMult;
    attacker.attackCooldownTicks = Math.max(
      1,
      Math.round(CombatConfig.baseMeleeCooldownTicks / speedMult)
    );

    this.events.push({ type: 'attack', attackerId: attacker.id, defenderId: defender.id });

    const chargeCfg = CombatConfig.charge;
    // Passing attackers (marching/impetuous with a live contact) get
    // the charge bonus exactly ONCE per contact — the moment of first
    // touch. Subsequent swings against the same enemy while contact
    // persists are normal melee attacks; the momentum is spent.
    // ContactAttackSystem resets contactChargeBonusSpent whenever the
    // contact target changes or contact is lost, so a genuinely fresh
    // contact charges again. Engaged attackers are unaffected by this
    // flag: for them, the natural decay of currentSpeed after the
    // first tick of engagement already makes charge a one-shot event.
    const isPassingAttack = attacker.state !== 'engaged';
    // Compare in one space: currentSpeed is SIM, config threshold is
    // DESIGN. See src/config/SpeedScale.js for the contract.
    const isCharging =
      attacker.currentSpeed >= toSimSpeed(chargeCfg.speedThreshold)
      && (!isPassingAttack || !attacker.contactChargeBonusSpent);
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

    // --- To-hit chance ---------------------------------------------------
    // Base × matchup toHitMod × champion toHitMult (Killer Instinct) ×
    // Shoulder to Shoulder per-bodyguard bonus.
    let toHitChance = CombatConfig.baseToHitChance * matchup.toHitMod;
    if (championMods?.toHitMult) toHitChance *= championMods.toHitMult;
    if (attacker.shoulderToShoulderActive) {
      const allies = this._countLivingBodyguards(attacker, unitsById);
      toHitChance *= (1 + 0.05 * allies);
    }
    toHitChance = Math.min(1, toHitChance);

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
      attacker.killsThisBattle++;
      this._applyHealOnKill(attacker);
      this._applyRetaliation(attacker, defender);
      if (attacker.state === 'engaged') {
        attacker.targetId = null;
        attacker.state = 'idle';
      }
      // Flanking sword instant-kill is still a retinue kill — the raise
      // roll applies here too.
      this._maybeRaiseThrallFromKiller(attacker, defender);
      return;
    }

    defender.fatigue = Math.max(0,
      defender.fatigue
      - CombatConfig.fatigue.drainPerBlockAttempt * defender.fatigueDrainMultiplier);

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
      // A blocked attack still triggers Retaliation — the champion's
      // guard-and-punish is exactly this case.
      this._applyRetaliation(attacker, defender);
      return;
    }

    // --- Base damage -----------------------------------------------------
    let damage = matchup.damage;

    // Race: attacker-side outgoing damage multiplier, applied to the base
    // weapon damage. The matchup table remains the authority on a weapon's
    // BASE damage; the race scales it. Applied before the additive charge
    // bonus further down, so a charge's momentum bonus is added on top of
    // the race-scaled base (momentum is physics, not weapon damage).
    const attackerRaceMult = raceOf(attacker.unitTypeDef).damageMultiplier;
    if (attackerRaceMult !== 1.0) damage *= attackerRaceMult;

    // Race: defender-side incoming damage multiplier, keyed by the
    // attacker's weapon type. A PER-TYPE table (defined even as {}) wins
    // over the race-level table — used by hobgoblins to opt out of the
    // goblin spear resistance without changing the goblin race entry.
    const defenderTypeIncoming = defender.unitTypeDef.incomingDamageMultipliers;
    const defenderRaceIncoming = raceOf(defender.unitTypeDef).incomingDamageMultipliers;
    const incomingTable = (defenderTypeIncoming !== undefined)
      ? defenderTypeIncoming
      : defenderRaceIncoming;
    const raceIncomingMult = incomingTable[attacker.unitTypeDef.weaponType];
    if (raceIncomingMult !== undefined && raceIncomingMult !== 1.0) {
      damage *= raceIncomingMult;
    }

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

    // DIRTY_FIGHTING property: a race that fights dirty trades frontal
    // damage for flank damage. Reuses angleForFlank / sideThresholdDeg
    // above so a spear defender's unit-facing wall geometry
    // (wallBrokenArcDeg) is honoured identically for the property as for
    // the flank multiplier.
    if (raceHasProperty(attacker.unitTypeDef, Property.DIRTY_FIGHTING)) {
      const df = raceOf(attacker.unitTypeDef).dirtyFighting;
      if (df) {
        if (angleForFlank >= sideThresholdDeg) {
          damage *= (df.flankDamageMult ?? 1.0);
        } else {
          damage *= (df.frontalDamageMult ?? 1.0);
        }
      }
    }

    if (isCharging && massRatio >= chargeCfg.minMassRatioForKnockback && !defenderBraced) {
      if (isPassingAttack) attacker.contactChargeBonusSpent = true;
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

    // --- Champion attack damage mods -------------------------------------
    // Applied AFTER every base multiplier so a +2 flat is genuinely +2 on
    // top of everything, and multiplies stack on the current total.
    if (championMods) {
      if (championMods.outgoingDamageMult) damage *= championMods.outgoingDamageMult;
      if (championMods.flatDamage) damage += championMods.flatDamage;

      if (championMods.lowHpDamageMult
          && attacker.maxHp > 0
          && attacker.hp / attacker.maxHp < (championMods.lowHpThreshold ?? 0.3)) {
        damage *= championMods.lowHpDamageMult;
      }

      if (championMods.routingTargetDamageMult
          && (defender.state === 'routing' || defender.state === 'shattered')) {
        damage *= championMods.routingTargetDamageMult;
      }
    }

    // Shoulder to Shoulder damage bonus (bodyguards only).
    if (attacker.shoulderToShoulderActive) {
      const allies = this._countLivingBodyguards(attacker, unitsById);
      damage *= (1 + 0.05 * allies);
    }

    // --- Champion striker marking ----------------------------------------
    // A soldier who strikes a champion in melee is marked for the rest of
    // the battle. When later killed by that same champion (see
    // _maybeRaiseThrall), the Blood Thrall skill raises them at 100%
    // chance instead of the base 10%. Marking lives on the attacker, keyed
    // by champion soldier id, so multiple champions (or future captains)
    // are each tracked independently.
    if (defender.isChampion) {
      if (!attacker.championStruck) attacker.championStruck = new Set();
      attacker.championStruck.add(defender.id);
    }

    // --- Defender combat mods (Thick Skin, Interpose) --------------------
    // Generic read — a champion, a captain, or anyone else carrying a
    // combatMods object with these keys gets the effect.
    //
    // Declared BEFORE the Blood Fury counter-blast below: the blast
    // handler takes defenderMods as an argument, and an earlier revision
    // declared this after the call site — which put the reference in the
    // temporal dead zone and threw a ReferenceError on every melee hit
    // against a champion.
    const defenderMods = defender.combatMods || null;

    // --- Blood Fury counter-blast ----------------------------------------
    // Triggered when the champion defender takes a melee hit while below
    // the skill's HP threshold and the cooldown has expired. Fires BEFORE
    // the primary damage is applied so the blast and the hit resolve on
    // the same tick — the attacker gets their swing in, then gets
    // counter-punched. Uses the charge formula (damage, knockback, throw,
    // knockdown) driven off the champion's mass × blastMassMult.
    if (defender.isChampion) {
      this._maybeFireBloodFury(defender, attacker, defenderMods);
    }

    if (defenderMods?.damageTakenFlat) {
      damage = Math.max(1, damage - defenderMods.damageTakenFlat);
    }

    // --- Interpose --------------------------------------------------------
    // Champion-only redirect. On a successful unblocked hit against the
    // champion, roll once; on success, a nearby healthy bodyguard takes
    // the damage instead. Retaliation still fires — the attacker chose to
    // strike the champion, and the champion's guard answers regardless of
    // who absorbed the blow.
    if (defender.isChampion && defenderMods?.interposeChance) {
      const bodyguard = this._findInterposeBodyguard(defender, unitsById);
      if (bodyguard && Math.random() < defenderMods.interposeChance) {
        this._applyDamageToSoldier(bodyguard, damage, attacker, matchup);
        this._applyRetaliation(attacker, defender);
        if (!bodyguard.isAlive()) this._applyHealOnKill(attacker);
        return;
      }
    }

    this._applyDamageToSoldier(defender, damage, attacker, matchup);

    // --- Wide Arc ---------------------------------------------------------
    // Champion-only splash. Pick one other enemy in engagement range of
    // the attacker (excluding the primary target) and apply a fraction of
    // the primary damage. Skipped if the primary target is already dead —
    // the swing is spent.
    if (championMods?.wideArcFraction && defender.isAlive()) {
      const splash = this._findWideArcTarget(attacker, defender, unitsById);
      if (splash) {
        this._applyDamageToSoldier(
          splash,
          damage * championMods.wideArcFraction,
          attacker,
          matchup
        );
        if (!splash.isAlive()) this._applyHealOnKill(attacker);
      }
    }

    // --- Retaliation ------------------------------------------------------
    this._applyRetaliation(attacker, defender);

    // --- Heal on kill -----------------------------------------------------
    if (!defender.isAlive()) this._applyHealOnKill(attacker);
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

  // -------------------------------------------------------------------
  // TOOLTIP MIRROR
  //
  // The spear tooltip in UnitInfoPanel.WEAPON_TOOLTIPS describes the
  // brace mechanic. Update it if you change any of:
  //
  //   - the brace conditions below (stationary this tick, facing within
  //     CombatConfig.brace.frontalArcDeg, spear not raised),
  //   - the outcome in _applyBraceCounter — charge bonus and throw are
  //     both cancelled, and the charger takes counter damage,
  //   - the flank geometry in _computeAngleOffUnitFacing — a spearwall
  //     is measured against the unit's formationFacing, not the
  //     individual soldier's facing, so pivoting a single spearman does
  //     not restore the wall.
  // -------------------------------------------------------------------
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
      spearman.killsThisBattle++;
      // A bracing spearman in the champion's retinue counts as a retinue
      // kill — the roll runs through the same path as any other.
      this._maybeRaiseThrallFromKiller(spearman, charger);
    }
  }

// --- Champion / bodyguard helpers --------------------------------------

  // Raw in-battle XP accrual. Called once per attack roll, before any
  // hit/miss resolution. Both directions credit independently: the
  // attacker earns from the defender's soldier-power read, the defender
  // earns from the attacker's. Zero-power reads (a unit with no fighters)
  // contribute nothing, which is correct — swinging at corpses teaches
  // nothing.
  _accrueChampionXp(attacker, defender) {
    // Every soldier accrues combat XP from every melee attack roll — as
    // attacker (against the defender's per-soldier power) and as
    // defender (against the attacker's). The field is named
    // `championXpRaw` because the champion's personal progression reads
    // the same field; the campaign layer ALSO sums it across every
    // soldier of a unit to drive unit-level progression. One accrual
    // site, two consumers.
    //
    // The ungating matters: when only champions accrued, the unit XP
    // system had no source. Now a levelled-up unit is simply one whose
    // soldiers did a lot of fighting.
    const mult = CombatConfig.championXpPerSoldierPower;
    let attackerGain = 0;
    let defenderGain = 0;
    if (defender.soldierPowerCache > 0) {
      attackerGain = defender.soldierPowerCache * mult;
      attacker.championXpRaw += attackerGain;
    }
    if (attacker.soldierPowerCache > 0) {
      defenderGain = attacker.soldierPowerCache * mult;
      defender.championXpRaw += defenderGain;
    }

    // Retinue champion XP share. A blood guard's combat XP is credited
    // half to the champion they guard, on top of the guard's own
    // accrual — the champion learns from their retinue's fighting.
    //
    // An orphaned mount shares the same rate: even after its rider dies
    // the beast still answers to the champion, and its fighting teaches
    // the champion just as a living guard's did. The mount is not a
    // bodyguard (see OrphanedMountSystem) so it must be admitted
    // explicitly — isBodyguard alone would exclude it.
    //
    // The champion's own contributions are already covered by the base
    // accrual above (their own championXpRaw is the field being
    // incremented), so this branch only fires for non-champion soldiers
    // carrying a championRef. It never double-counts.
    const attackerSharesXp =
      (attacker.isBodyguard || attacker.isRiderlessMount)
      && attacker.championRef && attackerGain > 0;
    if (attackerSharesXp) {
      attacker.championRef.championXpRaw +=
        attackerGain * BODYGUARD_CHAMPION_XP_SHARE;
    }
    const defenderSharesXp =
      (defender.isBodyguard || defender.isRiderlessMount)
      && defender.championRef && defenderGain > 0;
    if (defenderSharesXp) {
      defender.championRef.championXpRaw +=
        defenderGain * BODYGUARD_CHAMPION_XP_SHARE;
    }
  }

  // Count of living bodyguards in the source soldier's unit, EXCLUDING the
  // source soldier. Used by Shoulder to Shoulder: the bonus scales with
  // other bodyguards, so 3 bodyguards alive and one swinging gives +10%
  // (2 others × 5%), not +15%.
  _countLivingBodyguards(sourceSoldier, unitsById) {
    const unit = unitsById ? unitsById.get(sourceSoldier.unitId) : null;
    if (!unit) return 0;
    let n = 0;
    for (const s of unit.soldiers) {
      if (s === sourceSoldier) continue;
      if (!s.isAlive()) continue;
      if (!s.isBodyguard) continue;
      n++;
    }
    return n;
  }

  // Pick a bodyguard to absorb the champion's incoming hit. Criteria: same
  // unit, alive, above 30% HP, and within INTERPOSE_RADIUS of the
  // champion. Returns null if no candidate qualifies.
  _findInterposeBodyguard(champion, unitsById) {
    const INTERPOSE_RADIUS_SQ = 1.5 * 1.5;
    const unit = unitsById ? unitsById.get(champion.unitId) : null;
    if (!unit) return null;
    const candidates = [];
    for (const s of unit.soldiers) {
      if (s === champion) continue;
      if (!s.isAlive()) continue;
      if (!s.isBodyguard) continue;
      if (s.maxHp > 0 && s.hp / s.maxHp <= 0.3) continue;
      const dx = s.pos.x - champion.pos.x;
      const dz = s.pos.z - champion.pos.z;
      if (dx * dx + dz * dz > INTERPOSE_RADIUS_SQ) continue;
      candidates.push(s);
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // Pick one other enemy soldier within engagement range of the attacker
  // for Wide Arc splash. Excludes the primary defender and any same-team
  // soldier. Nearest wins; returns null if none qualifies.
  _findWideArcTarget(attacker, primaryDefender, unitsById) {
    const rangeSq = CombatConfig.engagementRange * CombatConfig.engagementRange;
    let best = null;
    let bestDistSq = Infinity;
    for (const [, unit] of unitsById) {
      if (unit.teamId === attacker.teamId) continue;
      for (const s of unit.soldiers) {
        if (!s.isAlive()) continue;
        if (s === primaryDefender) continue;
        if (s === attacker) continue;
        const dx = s.pos.x - attacker.pos.x;
        const dz = s.pos.z - attacker.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq > rangeSq) continue;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          best = s;
        }
      }
    }
    return best;
  }

  // Blood Rite: heal the attacker on a kill. No per-battle cap — the
  // skill's healOnKill value is applied every kill, every time. Reads
  // combatMods.healOnKill. The per-battle accumulator
  // championHealUsedThisBattle is still maintained for display purposes
  // (a future UI can report "healed X this battle") but nothing gates
  // on it.
  _applyHealOnKill(attacker) {
    const mods = attacker.isChampion ? attacker.combatMods : null;
    if (!mods || !mods.healOnKill) return;
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + mods.healOnKill);
    attacker.championHealUsedThisBattle =
      (attacker.championHealUsedThisBattle || 0) + mods.healOnKill;
  }

  // Retaliation: when a champion defender is struck by `attacker`, the
  // attacker takes retaliationDamage. Fires on blocked AND unblocked
  // attacks (guard-and-punish), but never fires when the defender IS the
  // attacker (impossible by construction) or when the champion is already
  // dead. Does NOT recurse — retaliation damage never triggers a further
  // retaliation from the attacker.
  _applyRetaliation(attacker, defender) {
    const mods = defender.isChampion ? defender.combatMods : null;
    if (!mods || !mods.retaliationDamage) return;
    if (!attacker.isAlive()) return;
    if (attacker === defender) return;

    attacker.hp -= mods.retaliationDamage;
    if (attacker.hp <= 0) {
      attacker.hp = 0;
      attacker.state = 'dead';
      attacker.targetId = null;
      this.events.push({ type: 'death', defenderId: attacker.id });
      AIDebugLog.combatDeath(0, attacker.id, attacker.unitId);
      defender.justKilled = true;
      defender.killsThisBattle++;
      // Retaliation only fires from the champion (see the isChampion
      // gate at the top of this method), so the champion is the killer
      // and the champion-tier raise chance applies.
      this._maybeRaiseThrall(defender, attacker, 'champion');
    }
  }

// Blood Fury: the champion's counter-punch against a melee attacker when
  // the champion is below the skill's HP threshold. Uses the charge
  // formula (see _applyThrow and the charge block in _resolveAttack), but
  // driven off an effective mass that is the champion's own mass
  // multiplied by the skill's blastMassMult.
  //
  // Fires at most once per CombatConfig.bloodFury.cooldownTicks, tracked
  // per-soldier on bloodFuryCooldownUntil. If the blast kills the attacker,
  // the normal kill-credit path runs (killsThisBattle++, justKilled,
  // healOnKill if the champion has Blood Rite).
  _maybeFireBloodFury(defender, attacker, defenderMods) {
    if (!defenderMods?.blastOnHitBelowHpThreshold) return;
    if (this._tick < (defender.bloodFuryCooldownUntil || 0)) return;
    if (defender.maxHp <= 0) return;

    const hpFrac = defender.hp / defender.maxHp;
    if (hpFrac >= defenderMods.blastOnHitBelowHpThreshold) return;
    if (!attacker.isAlive()) return;

    // Effective blast mass. Charge maths elsewhere uses effectiveMass, so
    // this uses the same source (champion's own effectiveMass) scaled by
    // the skill multiplier.
    const blastMass = defender.effectiveMass * (defenderMods.blastMassMult ?? 1.0);
    const ratio = blastMass / attacker.effectiveMass;
    const chargeCfg = CombatConfig.charge;

    // Only the mechanical portions of a charge that scale with mass apply.
    // Below minMassRatioForKnockback, no throw and no knockdown — the
    // blast still lands as damage-only, which reads as a punch. Above the
    // threshold, the attacker is thrown.
    let blastDamage = Math.max(0, (ratio - 1) * chargeCfg.bonusDamagePerMassRatio);

    if (ratio >= chargeCfg.minMassRatioForKnockback) {
      // Reuse the charge throw. The helper reads attacker.effectiveMass
      // and attacker.currentSpeed, so temporarily present a synthetic
      // charger-like object instead of copying the whole formula.
      this._applyBlastThrow(defender, attacker, blastMass);
      attacker.state = 'knockedDown';
      attacker.knockedDownTicksLeft = chargeCfg.knockedDownDurationTicks;
      this.events.push({
        type: 'knockdown',
        attackerId: defender.id,
        defenderId: attacker.id,
      });
    }

    if (CombatConfig.bloodFury.staggers
        && attacker.state !== 'knockedDown'
        && attacker.staggerTicksLeft <= 0) {
      if (attacker.state !== 'staggered') {
        attacker.stateBeforeStagger = attacker.state;
      }
      attacker.state = 'staggered';
      attacker.staggerTicksLeft = attacker.staggerDurationTicks;
      this.events.push({ type: 'stagger', defenderId: attacker.id });
    }

    // Damage resolution. Blast damage goes through the same "defender dies"
    // checks as any other damage path. The champion is credited with a kill
    // if the blast kills.
    if (blastDamage > 0) {
      attacker.hp -= blastDamage;
      this.events.push({
        type: 'hit',
        attackerId: defender.id,
        defenderId: attacker.id,
      });
      AIDebugLog.combatHit(0, defender.id, attacker.id, blastDamage,
        Math.max(0, attacker.hp), attacker.maxHp);

      if (attacker.hp <= 0) {
        attacker.hp = 0;
        attacker.state = 'dead';
        attacker.targetId = null;
        this.events.push({ type: 'death', defenderId: attacker.id });
        AIDebugLog.combatDeath(0, attacker.id, attacker.unitId);
        defender.justKilled = true;
        defender.killsThisBattle++;
        this._applyHealOnKill(defender);
        // Blood Thrall hook — the champion's blast can raise too. The
        // champion is the killer, so the champion-tier roll applies.
        this._maybeRaiseThrall(defender, attacker, 'champion');
      }
    }

    // Arm the cooldown regardless of damage landed. A blast that fizzled
    // still cost the champion the cooldown.
    defender.bloodFuryCooldownUntil =
      this._tick + (CombatConfig.bloodFury.cooldownTicks || 900);
  }

  // Throw helper for the Blood Fury blast. Mirrors _applyThrow but reads
  // an EXPLICIT effective mass for the "charger" side instead of pulling
  // it off the soldier — the blast mass is a skill-supplied value, not
  // the champion's raw effectiveMass.
  _applyBlastThrow(source, defender, sourceEffectiveMass) {
    const cfg = CombatConfig.charge;
    const dx = defender.pos.x - source.pos.x;
    const dz = defender.pos.z - source.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= 0.001) return;

    // Momentum here is mass × source's current speed. The champion is
    // usually stationary at the moment of being struck (engaged) — the
    // blast is a burst, not a charge. Use a fixed nominal speed so the
    // throw distance is predictable and controlled by blastMassMult.
    const nominalSpeed = cfg.speedThreshold * CombatConfig.movement.globalSpeedScale;
    const momentum = sourceEffectiveMass * nominalSpeed;
    const massRatio = sourceEffectiveMass / defender.effectiveMass;

    let vel = momentum * cfg.knockbackVelocityPerMomentum;
    vel *= Math.min(
      cfg.maxThrowMassRatioScale,
      massRatio / cfg.minMassRatioForKnockback
    );
    vel = Math.min(vel, cfg.maxKnockbackVelocity);
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

// Shared damage application for the primary hit, the Wide Arc splash,
  // and the Interpose redirect. Handles HP subtraction, the hit event,
  // stagger, and death. `matchup` is passed so the stagger threshold can
  // be read without a fresh table lookup.
  _applyDamageToSoldier(defender, damage, attacker, matchup) {
    defender.hp -= damage;
    this.events.push({ type: 'hit', attackerId: attacker.id, defenderId: defender.id });
    AIDebugLog.combatHit(0, attacker.id, defender.id, damage,
      Math.max(0, defender.hp), defender.maxHp);

    if (defender.state !== 'knockedDown' &&
        matchup &&
        matchup.damage >= matchup.staggerThreshold) {
      // Only snapshot on a FRESH stagger. A re-stagger while already
      // staggered must not overwrite stateBeforeStagger with 'staggered'
      // itself, or the restore-on-expiry would land on 'staggered' with
      // a zeroed timer and the soldier would be stuck.
      if (defender.state !== 'staggered') {
        defender.stateBeforeStagger = defender.state;
      }
      defender.state = 'staggered';
      defender.staggerTicksLeft = defender.staggerDurationTicks;
      this.events.push({ type: 'stagger', defenderId: defender.id });
    }

    if (defender.hp <= 0) {
      // Orphaned Mount: intercept the death of a mounted blood guard
      // whose champion has the skill. On a successful roll the beast
      // survives its rider — the dying guard's mount is hidden (the
      // rider topples alone; see SoldierView.sync), and a NEW riderless-
      // mount unit is queued to spawn in BattleSimulation's post-combat
      // pass.
      //
      // Rolled once per killing blow, only on live riders that are not
      // themselves mounts. A mount that later dies rolls nothing.
      //
      // The dying guard is NOT skipped from death processing — it still
      // dies, still yields kill credit, still triggers Blood Debt and
      // Blood Thrall as any other bodyguard death. The orphaned mount is
      // an ADDITIONAL consequence of the death, not a replacement.
      if (defender.isBodyguard
          && defender.championRef
          && !defender.isRiderlessMount) {
        const champMods = defender.championRef.combatMods;
        if (champMods?.orphanedMountChance
            && Math.random() < champMods.orphanedMountChance) {
          defender.hideMount = true;
          if (!this.pendingMounts) this.pendingMounts = [];
          this.pendingMounts.push({
            championRef: defender.championRef,
            teamId: defender.teamId,
            // Unit the beast joins. The mount stays IN the warlord's
            // retinue — see BloodThrallSystem._spawnMount.
            unitId: defender.unitId,
            sourceTypeDef: defender.unitTypeDef,
            pos: { x: defender.pos.x, z: defender.pos.z },
            facing: defender.facing,
          });
        }
      }

      defender.hp = 0;
      defender.state = 'dead';
      defender.targetId = null;
      this.events.push({ type: 'death', defenderId: defender.id });
      AIDebugLog.combatDeath(0, defender.id, defender.unitId);
      attacker.justKilled = true;
      attacker.killsThisBattle++;
      if (attacker.state === 'engaged') {
        attacker.targetId = null;
        attacker.state = 'idle';
      }

      // Blood Debt: if the dead soldier was a blood guard of a champion
      // who has unlocked the skill, heal that champion to full.
      if (defender.isBodyguard && defender.championRef) {
        const champ = defender.championRef;
        const champMods = champ.combatMods;
        if (champMods?.healOnGuardDeath && champ.isAlive()) {
          champ.hp = champ.maxHp;
        }
      }

      // Blood Thrall: any kill by the champion or a bodyguard of the
      // champion's retinue rolls to raise the dead enemy as a thrall.
      // Marked soldiers — those who have struck the champion in melee —
      // roll at the higher marked chance.
      this._maybeRaiseThrallFromKiller(attacker, defender);
    }
  }

  // Blood Thrall raise. Called from the kill branches of _applyDamageToSoldier,
  // _maybeFireBloodFury, and _applyRetaliation. The raise chance depends on
  // WHO landed the killing blow:
  //
  //   killerRole === 'champion' — the champion personally killed the target.
  //   killerRole === 'retinue'  — a blood guard (or a riderless mount still
  //                               answering to the champion) landed the blow.
  //
  // Marked soldiers — those who struck the champion in melee earlier in
  // the battle (see the championStruck set) — roll against the higher
  // marked chance for their role. The four chance values come from the
  // skill's effect table; see ChampionSkills.SKILL_TREES.blood_magic.
  //
  // Queues the raise; the actual spawn happens in BattleSimulation's post-
  // combat pass so the sim's unit list is not mutated mid-iteration.
  //
  // Queue format: { championId, championRef, teamId, sourceTypeId,
  //                 sourceTypeDef, sourceIsUndead, pos, statMult }.
  _maybeRaiseThrall(champion, deadSoldier, killerRole = 'champion') {
    const mods = champion.combatMods;
    if (!mods) return;

    const isChampionKill = killerRole === 'champion';
    const baseChance = isChampionKill
      ? mods.bloodThrallChampionBaseChance
      : mods.bloodThrallRetinueBaseChance;
    if (!(baseChance > 0)) return;

    const marked = deadSoldier.championStruck
      && deadSoldier.championStruck.has(champion.id);
    const markedChance = isChampionKill
      ? mods.bloodThrallChampionMarkedChance
      : mods.bloodThrallRetinueMarkedChance;
    const chance = marked ? (markedChance ?? baseChance) : baseChance;
    if (Math.random() >= chance) return;

    if (!this.pendingThralls) this.pendingThralls = [];
    this.pendingThralls.push({
      championId: champion.id,
      championRef: champion,
      teamId: champion.teamId,
      sourceTypeId: deadSoldier.unitTypeDef?.id || null,
      sourceTypeDef: deadSoldier.unitTypeDef,
      sourceIsUndead: !!deadSoldier.isUndead,
      pos: { x: deadSoldier.pos.x, z: deadSoldier.pos.z },
      statMult: mods.bloodThrallStatMult ?? 0.5,
    });
  }

// Convenience wrapper. Resolves a killer — the champion himself or one
  // of his bodyguards — to the champion whose skill governs the raise,
  // then rolls. Silent for anyone outside a champion's retinue (a normal
  // soldier, an archer, a captain without a champion). This is what makes
  // "killed by the retinue" work: a bodyguard's kill rolls against the
  // champion's Blood Thrall skill exactly as the champion's own kill
  // would.
  _maybeRaiseThrallFromKiller(killer, deadSoldier) {
    if (!killer) return;
    if (killer.isChampion) {
      this._maybeRaiseThrall(killer, deadSoldier, 'champion');
    } else if (killer.championRef) {
      // Anybody carrying a championRef counts — a bodyguard, or an
      // orphaned mount whose beast still answers to its dead rider's
      // champion. The championRef test is the whole gate. The role is
      // 'retinue' so the lower retinue roll applies.
      this._maybeRaiseThrall(killer.championRef, deadSoldier, 'retinue');
    }
  }

// Drain the queue of thralls raised this tick. Called by BattleSimulation
  // after combat resolution, before the thrall lifecycle system runs, so a
  // thrall's first tick is the one immediately after its raise.
  drainPendingThralls() {
    const q = this.pendingThralls;
    this.pendingThralls = [];
    return q || [];
  }

// Drain the queue of orphaned mounts raised this tick. Sibling of
  // drainPendingThralls — see the Orphaned Mount skill for context.
  // Called by BattleSimulation right after drainPendingThralls.
  drainPendingMounts() {
    const q = this.pendingMounts;
    this.pendingMounts = [];
    return q || [];
  }

// Idle-only recovery, and only when the soldier ACTUALLY stood still
  // this tick.
  //
  // The state field alone is not enough. A soldier whose unit's
  // formation anchor is advancing — or a released soldier whose
  // formationSlot is being recomputed — can be in `state === 'idle'`
  // while still walking toward a moving slot through the main movement
  // loop in MovementSystem. That walk sets movedThisTick = true and
  // incurs the walking drain, but if regen keyed on state alone it
  // would ALSO credit idle recovery on the same tick, and the two
  // would partially cancel: net +0.05/tick for a walking-but-idle
  // soldier. Cavalry on the flank were the visible case — they sit in
  // idle state far from enemy target-search radius while their
  // formation anchor creeps forward, so their stamina bar slowly
  // climbed during what was visibly a march.
  //
  // Requiring !movedThisTick makes the two predicates mutually
  // exclusive on the same flag:
  //   movedThisTick === true  → walking drain fires, no idle regen.
  //   movedThisTick === false → idle regen fires, no walking drain.
  // No tick can do both; no tick can cancel out.
  //
  // Marchers that happen not to move (blocked, waiting on the anchor)
  // still do not regenerate — the state check keeps 'marching' out
  // entirely, on the reasoning that a soldier who is meant to be
  // marching is not resting even if collision or a stalled anchor
  // briefly pins them.
// Idle-only recovery, and only when the soldier ACTUALLY stood still
  // this tick.
  //
  // The state field alone is not enough. A soldier whose unit's
  // formation anchor is advancing — or a released soldier whose
  // formationSlot is being recomputed — can be in `state === 'idle'`
  // while still walking toward a moving slot through the main movement
  // loop in MovementSystem. That walk sets movedThisTick = true and
  // incurs the walking drain, but if regen keyed on state alone it
  // would ALSO credit idle recovery on the same tick, and the two
  // would partially cancel: net +0.05/tick for a walking-but-idle
  // soldier. Cavalry on the flank were the visible case — they sit in
  // idle state far from enemy target-search radius while their
  // formation anchor creeps forward, so their stamina bar slowly
  // climbed during what was visibly a march.
  //
  // Requiring !movedThisTick makes the two predicates mutually
  // exclusive on the same flag:
  //   movedThisTick === true  → walking drain fires, no idle regen.
  //   movedThisTick === false → idle regen fires, no walking drain.
  // No tick can do both; no tick can cancel out.
  //
  // Marchers that happen not to move (blocked, waiting on the anchor)
  // still do not regenerate — the state check keeps 'marching' out
  // entirely, on the reasoning that a soldier who is meant to be
  // marching is not resting even if collision or a stalled anchor
  // briefly pins them.
  //
  // Champion Resilient (combatMods.idleRegen) additionally regenerates
  // HP on the same trigger — same-state, same-stillness gate, so a
  // champion who is walking or fighting does not passively heal.
  _regenerateIdleFatigue(allSoldiers) {
    for (const s of allSoldiers) {
      if (!s.isAlive()) continue;
      if (s.state === 'idle' && !s.movedThisTick) {
        s.fatigue = Math.min(CombatConfig.fatigue.max, s.fatigue + CombatConfig.fatigue.regenPerTickIdle);
        if (s.isChampion && s.combatMods?.idleRegen) {
          s.hp = Math.min(s.maxHp, s.hp + s.combatMods.idleRegen);
        }
      }
    }
  }
}
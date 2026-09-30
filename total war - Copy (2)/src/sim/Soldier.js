import { CombatConfig } from '../config/CombatConfig.js';
import { toSimSpeed } from '../config/SpeedScale.js';

// Plain data object for one soldier. No behavior methods beyond simple accessors.

let nextId = 1;

export class Soldier {
  constructor({ unitId, teamId, unitTypeDef, x, z, facing, isUndead }) {
    this.id = nextId++;
    this.unitId = unitId;
    this.teamId = teamId;
    this.unitTypeDef = unitTypeDef;

    this.pos = { x, z };

    // `facing` is the soldier's ACTUAL current facing, and only ever
    // changes inside FacingSystem, gradually, at a bounded turn rate (see
    // CombatConfig.turning). Every other system that wants the soldier to
    // face something (engaged target, threat reaction, movement heading)
    // sets `desiredFacing` instead — FacingSystem is the single place that
    // reconciles the two. This split is what makes brace/flank mechanics
    // meaningful: nothing outside FacingSystem is allowed to snap `facing`
    // directly anymore.
    this.facing = facing;
    this.desiredFacing = facing;
    this.moveFacing = facing;

    this.formationSlot = { x, z };
    this.formationOffset = { x: 0, z: 0 };

    this.state = 'idle';
    this.targetId = null;

    this.isImpetuous = false;
    this.rallyTargetId = null;

    this.hp = unitTypeDef.baseHp;
    this.maxHp = unitTypeDef.baseHp;

    this.hasShield = unitTypeDef.hasShield;
    this.shieldSide = unitTypeDef.shieldSide;
    this.shieldHp = unitTypeDef.hasShield ? CombatConfig.shieldMaxHp : 0;

    this.fatigue = 100;

    this.staggerTicksLeft = 0;
    this.knockedDownTicksLeft = 0;
    this.attackCooldownTicks = 0;
    this.disengageGraceTicksLeft = 0;

    this.knockbackVel = { x: 0, z: 0 };
    this.airborneTicksLeft = 0;
    this.airborneTotalTicks = 0;
    this.throwPeakHeight = 0;

    this.morale = 100;
    this.isRouting = false;
    this.justKilled = false;
    this.fleeDirection = { x: 0, z: 0 };

    // Number of distinct rout events this soldier has entered since the
    // battle began. Persists across rallies (a soldier who routs, rallies,
    // and routs again has routCountThisBattle === 2). Used by MoraleSystem
    // to decide whether a new rout becomes a shatter — 1st rout is normal,
    // 2nd rout is a 30/70 roll (rout/shatter), 3rd+ rout shatters
    // unconditionally. Reset per battle by construction (a fresh Soldier
    // is created for each battle).
    this.routCountThisBattle = 0;

    this.currentSpeed = 0;
    this.movedThisTick = false;

    // Friendly-yield state. Set by MovementSystem when a soldier is
    // routing around a different-unit friendly. yieldTicksLeft > 0 means
    // the soldier is committed to the (yieldSideX, yieldSideZ) direction
    // for that many remaining ticks, ignoring small geometry changes that
    // would otherwise flip the side choice and produce jitter.
    this.yieldTicksLeft = 0;
    this.yieldSideX = 0;
    this.yieldSideZ = 0;
    // Last committed side, retained across commit cycles so a fresh
    // commit can prefer the same side (see sideStickyDot). Distinct from
    // yieldSideX/Z which are zeroed on a clean exit from yield.
    this.lastYieldSideX = 0;
    this.lastYieldSideZ = 0;

    // Spear-handling state. Updated by FacingSystem._updateSpearHandling
    // when a spear soldier needs to reorient. States:
    //   'lowered' | 'raising' | 'raised' | 'lowering'
    // Non-spear soldiers never leave 'lowered' and always have amount 0.
    this.spearRaiseState = 'lowered';
    this.spearRaiseTicksLeft = 0;
    // 0..1, purely for rendering the mesh tilt. FacingSystem is the only
    // writer.
    this.spearRaiseAmount = 0;

    this.isUndead = !!isUndead;
    this.bodyVariant = this.isUndead ? 'skeleton' : 'blob';
  }

  get effectiveMass() {
    const base = this.unitTypeDef.mass;
    return this.isUndead ? base * CombatConfig.skeleton.massMult : base;
  }

  get effectiveMoveSpeed() {
    const base = this.unitTypeDef.baseMoveSpeed;
    let speed = this.hasShield ? base * CombatConfig.shield.moveSpeedMult : base;
    // Spear movement malus. Stacked after the shield mult, so a shielded
    // spearman carries both penalties. Applies to skeletons as well — an
    // undead spear-holder is exactly as awkward with the shaft as a living
    // one. See CombatConfig.spearHandling.moveSpeedMult for tuning.
    if (this.unitTypeDef.weaponType === 'spear') {
      speed *= CombatConfig.spearHandling.moveSpeedMult;
    }
    return speed;
  }

  // Current turn rate in rad/sec, context-sensitive per CombatConfig.turning.
  // Charging takes priority over engaged (a charging soldier by definition
  // isn't in melee yet — currentSpeed >= speedThreshold and engaged are
  // mutually exclusive states in practice, but charging is checked first
  // for clarity of intent).
  get effectiveTurnRateRadPerSec() {
    const t = CombatConfig.turning;
    let rate = t.baseTurnRateRadPerSec;
    if (this.currentSpeed >= toSimSpeed(CombatConfig.charge.speedThreshold)) {
      rate *= t.chargingTurnRateMult;
    } else if (this.state === 'engaged') {
      rate *= t.engagedTurnRateMult;
    }
    // Spear-armed soldiers turn proportionally slower than their sword/
    // archer equivalents, in every state. Applied after state modifiers so
    // the relationship holds across states.
    if (this.unitTypeDef.weaponType === 'spear') {
      rate *= t.spearTurnRateMult;
    }
    return rate;
  }

  isAlive() {
    // 'extracted' is a terminal non-alive state — a routing soldier that
    // fled past the map edge is removed from the battle exactly like a
    // corpse for all sim purposes (targeting skips them, units count them
    // as dead for isDefeated, battle-over check ignores them), but is
    // distinguishable from 'dead' so the campaign layer can read survivors
    // back out of the extraction record.
    return this.state !== 'dead' && this.state !== 'extracted';
  }
}
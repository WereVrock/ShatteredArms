import { CombatConfig } from '../config/CombatConfig.js';

// Pure math: given an attack vector and defender facing/shield, compute block chance.
// No side effects, no state mutation — easy to unit test.
export class ShieldBlockCalculator {
// attackerWeaponType is optional. When supplied, a per-weapon block
  // multiplier from CombatConfig.shieldBlock.weaponTypeBlockMult is applied
  // on top of the arc/fatigue result — e.g. bows are easier to block than
  // thrusts. Missing entry = no change.
  static computeBlockChance(defender, attackerPos, attackerWeaponType) {
    if (!defender.hasShield || defender.shieldHp <= 0) return 0;

    const angleOff = this.computeAngleOffShield(defender, attackerPos);
    const cfg = CombatConfig.shieldBlock;

    let baseChance;
    if (angleOff <= cfg.innerArcDeg) {
      baseChance = cfg.baseBlockChance;
    } else if (angleOff <= cfg.outerArcDeg) {
      const t = (angleOff - cfg.innerArcDeg) / (cfg.outerArcDeg - cfg.innerArcDeg);
      baseChance = cfg.baseBlockChance + t * (cfg.outerArcBlockChance - cfg.baseBlockChance);
    } else {
      baseChance = 0;
    }

    const fatigueMult = this._fatigueMultiplier(defender.fatigue);
    let chance = baseChance * fatigueMult;

    if (attackerWeaponType) {
      const mod = cfg.weaponTypeBlockMult[attackerWeaponType];
      if (mod !== undefined) chance *= mod;
    }

    // Clamp at 1.0 — a block chance above 100% is meaningless and would
    // silently over-tune if the config multiplier were raised further.
    return Math.min(1, chance);
  }

  // Public: degrees between the defender's facing and the direction the
  // attacker is coming from. 0 = directly ahead, 180 = directly behind.
  // Used both by the block calculation and by CombatResolutionSystem to
  // apply flank damage multipliers.
  static computeAngleOffShield(defender, attackerPos) {
    const toAttacker = Math.atan2(
      attackerPos.x - defender.pos.x,
      attackerPos.z - defender.pos.z
    );

    // Shield normal assumed to align with body facing (front-carried shield).
    let diff = Math.abs(toAttacker - defender.facing);
    diff = diff % (2 * Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;

    return diff * (180 / Math.PI);
  }

  static _fatigueMultiplier(fatigue) {
    const f = CombatConfig.fatigue;
    const t = Math.max(0, Math.min(1, fatigue / f.max));
    return f.minBlockMultiplierAtZeroFatigue + t * (1 - f.minBlockMultiplierAtZeroFatigue);
  }
}
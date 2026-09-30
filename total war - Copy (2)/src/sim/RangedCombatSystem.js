// ===== RangedCombatSystem.js =====
// Decides WHO fires WHEN, and spawns arrows into ProjectileSystem.
//
// Every tick:
//   1. Decrement each unit's volley cooldown.
//   2. Gather every archer in a `ranged` state with a live in-range target.
//   3. For each unit with at least one such archer and a cooldown at 0,
//      fire ALL of that unit's gathered archers on the same tick and reset
//      the cooldown. Everyone else waits.
//
// The result is a synchronised "loose" — an entire unit's worth of arrows
// leaves simultaneously, each aimed at its own random point inside the
// target unit's scatter disc.
//
// THIS SYSTEM NO LONGER RESOLVES DAMAGE OR EMITS VISUAL EVENTS. Damage,
// shield block, and kills are decided by ProjectileSystem at the moment a
// simulated arrow actually collides with a soldier (friend, foe, or stray
// target). See ProjectileSystem for the collision model and
// CombatConfig.arrow for the tuning.
//
// The shot's target point is a random position inside a disc centered on
// the target UNIT's center, radius = the archer unit type's
// `rangedAccuracy` (world units) falling back to
// CombatConfig.arrow.defaultAccuracy. Each shooter picks its own point,
// so a volley is a scattered pattern rather than every arrow converging
// on the exact same spot.
//
// Routing soldiers do not fire.
import { CombatConfig } from '../config/CombatConfig.js';

export class RangedCombatSystem {
  constructor(projectileSystem) {
    this.projectileSystem = projectileSystem;
    this.volleyCooldownByUnit = new Map();
  }

  update(allSoldiers, unitsById) {
    const byId = new Map(allSoldiers.map(s => [s.id, s]));

    // Tick every known unit's cooldown down by one regardless of whether
    // that unit currently has shooters — prevents a unit briefly losing
    // targets from freezing its cooldown mid-volley.
    for (const [unitId, cd] of this.volleyCooldownByUnit) {
      if (cd > 0) this.volleyCooldownByUnit.set(unitId, cd - 1);
    }

    // Group ready shooters by unit.
    const shootersByUnit = new Map();
    for (const attacker of allSoldiers) {
      if (!attacker.isAlive()) continue;
      if (attacker.state === 'routing' || attacker.state === 'shattered') continue;
      if (attacker.state !== 'ranged') continue;

      // Fire-at-will gate. FAW off means the unit does not fire at enemies
      // on its own — the player has to select the unit and click an enemy
      // for it to shoot. focusTargetUnitId is exactly that click (set by
      // Unit.issueAttackOrder), so its presence overrides the FAW hold.
      const attackerUnit = unitsById.get(attacker.unitId);
      if (attackerUnit && !attackerUnit.fireAtWill && !attackerUnit.focusTargetUnitId) {
        continue;
      }

      const defender = attacker.targetId ? byId.get(attacker.targetId) : null;
      if (!defender || !defender.isAlive()) {
        attacker.targetId = null;
        continue;
      }

      const dist = this._distance(attacker, defender);
      if (dist < CombatConfig.rangedMinRange || dist > CombatConfig.rangedRange) continue;

      let arr = shootersByUnit.get(attacker.unitId);
      if (!arr) {
        arr = [];
        shootersByUnit.set(attacker.unitId, arr);
      }
      arr.push({ attacker, defender });
    }

    // Fire ready units.
    for (const [unitId, shooters] of shootersByUnit) {
      const cd = this.volleyCooldownByUnit.get(unitId) ?? 0;
      if (cd > 0) continue;

      for (const { attacker, defender } of shooters) {
        this._spawnArrow(attacker, defender, unitsById);
        attacker.fatigue = Math.max(0, attacker.fatigue - CombatConfig.fatigue.drainPerAttack);
      }
      this.volleyCooldownByUnit.set(unitId, CombatConfig.rangedCooldownTicks);
    }
  }

  // Spawns one arrow for one shooter, aimed at a random point inside the
  // target unit's scatter disc. Uses `Math.random() * accuracy` rather
  // than `sqrt(rand) * accuracy` so the density is biased toward the
  // disc's center — the archer is aiming at the formation, not
  // uniformly covering its footprint, and a center-biased scatter keeps
  // well-aimed volleys reading as well-aimed.
  _spawnArrow(attacker, defender, unitsById) {
    const targetUnit = unitsById.get(defender.unitId);
    if (!targetUnit) return;

    const targetCenter = targetUnit.getCenter();
    const baseAccuracy = attacker.unitTypeDef.rangedAccuracy
      ?? CombatConfig.arrow.defaultAccuracy;

    // Distance-scaled spread: close-range volleys are tighter than
    // long-range ones. See CombatConfig.arrow.accuracyAtMinRangeMult /
    // accuracyAtMaxRangeMult. Distance is measured shooter-to-target-
    // center, matching the disc the scatter is drawn in.
    const dxC = targetCenter.x - attacker.pos.x;
    const dzC = targetCenter.z - attacker.pos.z;
    const shotDist = Math.sqrt(dxC * dxC + dzC * dzC);
    const accuracy = baseAccuracy * this._accuracyDistanceMult(shotDist);

    const r = Math.random() * accuracy;
    const theta = Math.random() * Math.PI * 2;
    const toX = targetCenter.x + Math.cos(theta) * r;
    const toZ = targetCenter.z + Math.sin(theta) * r;

    this.projectileSystem.spawn({
      teamId: attacker.teamId,
      shooterUnitId: attacker.unitId,
      shooterSoldierId: attacker.id,
      weaponType: attacker.unitTypeDef.weaponType,
      fromX: attacker.pos.x,
      fromZ: attacker.pos.z,
      toX,
      toZ
    });
  }

  // Spread multiplier as a function of shot distance. Linear interp
  // from accuracyAtMinRangeMult at rangedMinRange to
  // accuracyAtMaxRangeMult at rangedRange, clamped at both ends.
  _accuracyDistanceMult(dist) {
    const cfg = CombatConfig.arrow;
    const min = CombatConfig.rangedMinRange;
    const max = CombatConfig.rangedRange;
    if (max <= min) return cfg.accuracyAtMaxRangeMult;
    const t = Math.max(0, Math.min(1, (dist - min) / (max - min)));
    return cfg.accuracyAtMinRangeMult +
      t * (cfg.accuracyAtMaxRangeMult - cfg.accuracyAtMinRangeMult);
  }

  _distance(a, b) {
    const dx = a.pos.x - b.pos.x;
    const dz = a.pos.z - b.pos.z;
    return Math.sqrt(dx * dx + dz * dz);
  }
}
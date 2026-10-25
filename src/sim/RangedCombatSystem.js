// ===== RangedCombatSystem.js =====
// ===== RangedCombatSystem.js =====
// Decides WHO fires WHEN, and spawns arrows into ProjectileSystem.
//
// Every tick:
//   1. Decrement each unit's volley cooldown.
//   2. Decrement each archer's personal attackCooldownTicks (drives the
//      bow-draw animation in SoldierView — see the note below).
//   3. Gather every archer in a `ranged` state with a live in-range target.
//   4. For each unit with at least one such archer and a cooldown at 0,
//      fire ALL of that unit's gathered archers on the same tick, reset
//      the cooldown, and set each shooter's personal attackCooldownTicks.
//      Everyone else waits.
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
//
// BOW-DRAW ANIMATION
// ------------------------------------------------------------------
// SoldierView._applyBowDraw() reads each archer's attackCooldownTicks
// every render frame and maps it to a bowstring draw amount:
//   cooldown == maxCooldown  ->  draw = 0  (just released, string forward)
//   cooldown -> 0            ->  draw -> 1 (about to loose)
// The EMA inside the view smooths the 15 Hz tick steps into a continuous
// pull-back. The only two things this system has to do to make that work
// are (a) set attackCooldownTicks on every shooter the moment the volley
// fires, and (b) decrement it by 1 every tick. Without (a) the value
// stays at 0 forever and the string never moves; without (b) it sticks
// at maxCooldown after the first shot and the string draws once and then
// freezes. Melee soldiers' attackCooldownTicks is handled by
// CombatResolutionSystem, and melee soldiers are never in state 'ranged',
// so the two systems do not contend for the same field on the same
// soldier.
//
// FATIGUE-SCALED CADENCE
// ------------------------------------------------------------------
// Volley cadence is scaled by the AVERAGE fatigue of the shooters who
// actually fire each volley. A fresh unit volleys at the base
// CombatConfig.rangedCooldownTicks (35); a fully exhausted unit volleys
// at CombatConfig.fatigue.maxRangedCooldownAtZeroFatigue (60). See
// _volleyCooldownFor for the curve.
//
// The scaled cycle length is stamped on each shooter as both
// attackCooldownTicks (drives the sim's own fire gate) and
// bowDrawMaxTicks (drives SoldierView._applyBowDraw's progress
// denominator, so a 60-tick fatigued draw visibly pulls back over the
// whole 60 ticks instead of the view clamping at the static 35).
import { CombatConfig } from '../config/CombatConfig.js';
import { getRangedRange } from '../config/UnitClasses.js';

export class RangedCombatSystem {
  constructor(projectileSystem) {
    this.projectileSystem = projectileSystem;
    this.volleyCooldownByUnit = new Map();
    // Per-unit set of "had at least one ready shooter last tick". Lets the
    // fire loop detect the exact tick a unit STARTS aiming (had none last
    // tick, has some this tick) so the first volley can be given a full
    // draw-time wind-up instead of firing on the very first tick. Rebuilt
    // from scratch every tick — see the fire loop below.
    this.unitsWithShootersLastTick = new Set();

    // Fired once per unit volley, AFTER the arrows have been spawned for
    // every shooter in that unit. Signature: (unitId, teamId). Used by
    // the AI director to apply a queued repositioning order on the exact
    // tick a volley releases, so the order takes effect at the moment
    // the strings go slack rather than at the next decision cycle.
    // Null by default; BattleSimulation wires it to the AI director at
    // construction.
    this.onVolleyFired = null;
  }

  update(allSoldiers, unitsById) {
    const byId = new Map(allSoldiers.map(s => [s.id, s]));

    // Tick every known unit's cooldown down by one regardless of whether
    // that unit currently has shooters — prevents a unit briefly losing
    // targets from freezing its cooldown mid-volley.
    for (const [unitId, cd] of this.volleyCooldownByUnit) {
      if (cd > 0) this.volleyCooldownByUnit.set(unitId, cd - 1);
    }

    // Tick each archer's personal draw cooldown down by one. Only ranged
    // soldiers are ticked here; melee soldiers' attackCooldownTicks is
    // owned by CombatResolutionSystem. The state check is what keeps the
    // two systems from double-decrementing the same soldier — a soldier
    // is never simultaneously in 'ranged' and 'engaged'.
    for (const s of allSoldiers) {
      if (s.state === 'ranged' && s.attackCooldownTicks > 0) {
        s.attackCooldownTicks -= 1;
      }
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
      // Per-unit max range: a goblin archer's effective range is shorter
      // than a human archer's. See getRangedRange.
      const maxRange = getRangedRange(attacker.unitTypeDef);
      if (dist < CombatConfig.rangedMinRange || dist > maxRange) continue;

      let arr = shootersByUnit.get(attacker.unitId);
      if (!arr) {
        arr = [];
        shootersByUnit.set(attacker.unitId, arr);
      }
      arr.push({ attacker, defender });
    }

    // Fire ready units.
    //
    // First-aim wind-up. rangedCooldownTicks is DRAW TIME, not a gap: the
    // first volley of a unit that has just entered ranged state must wait
    // a full draw cycle, exactly like every later volley. Without this,
    // volleyCooldownByUnit defaulted to 0 for a fresh unit and the first
    // volley fired on the very tick the unit acquired a target — the
    // first shot read as instant while every subsequent shot waited the
    // full cooldown. Detect "started aiming this tick" from the set built
    // last tick; on that tick, arm the cooldown and skip firing. All
    // later ticks fall through to the normal fire path once the cooldown
    // decrements to 0.
    const shootersThisTick = new Set();
    for (const [unitId, shooters] of shootersByUnit) {
      shootersThisTick.add(unitId);

      if (!this.unitsWithShootersLastTick.has(unitId)) {
        // Just started aiming. Arm the full draw for the whole unit and
        // start each archer's bow-draw visual from a slack string so the
        // draw is visible during the wind-up, not only between volleys.
        //
        // The wind-up length is scaled by the shooters' average fatigue
        // (see _volleyCooldownFor), so a tired unit takes longer to get
        // off its FIRST shot, matching the longer cadence between its
        // subsequent volleys. A fresh unit is unchanged at the base
        // rangedCooldownTicks.
        const windUp = this._volleyCooldownFor(shooters);
        this.volleyCooldownByUnit.set(unitId, windUp);
        for (const { attacker } of shooters) {
          attacker.attackCooldownTicks = windUp;
          // Denominator for SoldierView._applyBowDraw's progress curve.
          // Stamped alongside attackCooldownTicks so the visible draw
          // spans the ACTUAL current cycle length — a 60-tick fatigued
          // draw pulls back over 60 ticks, not clamped at the static
          // base 35 with a slack-string tail. Read by SoldierView; no
          // sim system consults it.
          attacker.bowDrawMaxTicks = windUp;
        }
        continue;
      }

      const cd = this.volleyCooldownByUnit.get(unitId) ?? 0;
      if (cd > 0) continue;

      // Cadence to the NEXT volley, scaled by the shooters' average
      // fatigue. Computed BEFORE the shooter loop pays this volley's
      // fatigue cost: the off-by-one-volley difference is 3 fatigue
      // points per shooter, which moves the resulting cooldown by
      // well under a tick — not worth a second pass to fix. See
      // _volleyCooldownFor for the curve.
      const nextCd = this._volleyCooldownFor(shooters);

      for (const { attacker, defender } of shooters) {
        this._spawnArrow(attacker, defender, unitsById);
        attacker.fatigue = Math.max(0,
          attacker.fatigue
          - CombatConfig.fatigue.drainPerAttack * attacker.fatigueDrainMultiplier);
        // Drive the bow draw-and-release visual. SoldierView reads this
        // every render frame and maps it to a bowstring draw amount — see
        // the BOW-DRAW ANIMATION note at the top of this file. Set to the
        // full next-volley cooldown so a fatigued unit visibly draws
        // slower across the whole window rather than completing the
        // draw at the base 35 ticks and holding a fully-drawn string
        // through the extra delay. Without this line, attackCooldownTicks
        // stays at 0 for the whole battle and no archer ever visibly draws.
        attacker.attackCooldownTicks = nextCd;
        // Denominator for SoldierView._applyBowDraw. Must track the
        // ACTUAL current cycle length (nextCd already carries the unit's
        // fatigue scaling via _volleyCooldownFor) so a tired archer's
        // draw progress ramps 0→1 over 60 ticks instead of the view
        // clamping the numerator at 35 and leaving the string slack for
        // the first 25. See SoldierView._applyBowDraw.
        attacker.bowDrawMaxTicks = nextCd;
      }
      this.volleyCooldownByUnit.set(unitId, nextCd);

      // Notify the AI that a volley just released for this unit. Called
      // after every shooter's arrow has been spawned and every cooldown
      // has been reset, so the AI — if it applies a queued repositioning
      // order here — is issuing it at the moment the strings are slack.
      // That is the "immediately after the arrows are shot" contract: the
      // order fires on the same sim tick the volley released.
      if (this.onVolleyFired) {
        const teamId = shooters.length > 0 ? shooters[0].attacker.teamId : null;
        this.onVolleyFired(unitId, teamId);
      }
    }
    this.unitsWithShootersLastTick = shootersThisTick;
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
    // Per-unit max range: a shorter-ranged unit reaches its full spread
    // at its OWN max range, not the global archer envelope. Without this,
    // a goblin archer's long shots read as "still well inside the
    // standard range" and land tighter than the curve intends.
    const maxRange = getRangedRange(attacker.unitTypeDef);
    // Per-soldier scatter multiplier. Levelled ranged units carry a
    // value below 1.0 (see UnitXp.js); non-levelled soldiers carry 1.0.
    const levelMult = attacker.rangedAccuracyMult ?? 1.0;
    const accuracy = baseAccuracy * levelMult *
      this._accuracyDistanceMult(shotDist, maxRange);

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

  // Volley cooldown in ticks, scaled by the AVERAGE fatigue of the
  // shooters passed in. At full average fatigue (100) this returns the
  // base CombatConfig.rangedCooldownTicks (35). At zero average
  // fatigue it returns CombatConfig.fatigue.maxRangedCooldownAtZeroFatigue
  // (60). Linear in between.
  //
  // Measured on the shooters of the volley, not on every living
  // soldier of the unit: the shooters are the ones paying the fatigue
  // cost of the volley and the ones whose cadence is being throttled.
  // Averaging in a fresh archer who was out of range last cycle would
  // mask the real state of the archers that fired.
  //
  // Returns the base cooldown when:
  //   - the shooter list is empty (caller misuse — defensive),
  //   - the ceiling is not declared or is not above the base (a config
  //     that opts out of fatigue-scaled ranged cadence).
  _volleyCooldownFor(shooters) {
    const base = CombatConfig.rangedCooldownTicks;
    if (!shooters || shooters.length === 0) return base;

    const ceiling = CombatConfig.fatigue.maxRangedCooldownAtZeroFatigue ?? base;
    if (ceiling <= base) return base;

    const maxFatigue = CombatConfig.fatigue.max;
    if (!(maxFatigue > 0)) return base;

    let sum = 0;
    for (const { attacker } of shooters) sum += attacker.fatigue;
    const avgFatigue = sum / shooters.length;
    const t = Math.max(0, Math.min(1, avgFatigue / maxFatigue));

    // t = 1 (full) → base; t = 0 (empty) → ceiling.
    return Math.round(base + (ceiling - base) * (1 - t));
  }

  // Spread multiplier as a function of shot distance. Linear interp
  // from accuracyAtMinRangeMult at rangedMinRange to
  // accuracyAtMaxRangeMult at maxRange, clamped at both ends.
  //
  // maxRange is the ATTACKER's per-unit ranged range (see getRangedRange),
  // not the global CombatConfig.rangedRange. Passing the global value
  // would make every short-ranged unit's long shots read as "still well
  // within the standard envelope", so their spread would never reach the
  // configured accuracyAtMaxRangeMult. The fire gate in update() already
  // uses the per-unit range — this makes the accuracy curve agree with it.
  _accuracyDistanceMult(dist, maxRange) {
    const cfg = CombatConfig.arrow;
    const min = CombatConfig.rangedMinRange;
    if (maxRange <= min) return cfg.accuracyAtMaxRangeMult;
    const t = Math.max(0, Math.min(1, (dist - min) / (maxRange - min)));
    return cfg.accuracyAtMinRangeMult +
      t * (cfg.accuracyAtMaxRangeMult - cfg.accuracyAtMinRangeMult);
  }

  _distance(a, b) {
    const dx = a.pos.x - b.pos.x;
    const dz = a.pos.z - b.pos.z;
    return Math.sqrt(dx * dx + dz * dz);
  }
}
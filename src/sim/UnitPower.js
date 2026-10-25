// ===== UnitPower.js =====
// Dynamic power calculation for a Unit. Aggregates offensive capability,
// durability, and current fighting state (health, morale, fatigue, rout)
// into a single scalar plus a breakdown, so AI behaviors and debug overlays
// can compare units on the same scale regardless of type, race, or
// equipment.
//
// "Static" inputs — weapon matchup damage, attack speed, race multipliers,
// base HP, shield capacity — are read from the existing config/registry
// tables (CombatConfig, WeaponMatchup, RaceConfig). This file duplicates
// none of them; it aggregates them.
//
// "Dynamic" inputs — current HP, shield HP, morale, fatigue, state, alive
// count — are read straight off the soldiers each call. Nothing is cached:
// the caller may invoke this every decision cycle and see the number move
// tick to tick.
//
// The formula has three stages:
//
//   1. OFFENSE — per fighting soldier, weapon damage per second scaled by
//      to-hit modifier and the attacker race's outgoing damage multiplier.
//      Ranged units additionally scale by a "ranged envelope" factor that
//      combines a baseline calibration (see RANGED_POWER_BASELINE) with
//      range reach and shot accuracy relative to the global defaults.
//      Melee and ranged are tallied separately so a caller can ask "how
//      much of this unit's power is shooting?" (e.g. to decide whether
//      cavalry can safely close) by reading the fields instead of the
//      total.
//
//   2. DURABILITY — per living fighting soldier, effective max HP (which
//      already includes the race HP multiplier and skeleton brittleness,
//      applied at Soldier construction) plus a weighted share of remaining
//      shield HP. Shields count fractionally (see SHIELD_DURABILITY_WEIGHT)
//      because they only absorb damage from the frontal arc — the same
//      shield pool is worth nothing against a flank attack.
//
//   3. STATE MULTIPLIERS — applied to (offense + durability * weight):
//        moraleFactor   avg(morale / maxMorale) among fighters
//        healthFactor   avg(hp / maxHp) among fighters
//        fatigueFactor  1 at full fatigue, MIN_FATIGUE_FACTOR at zero
//        undeadMult     1.15 for a skeleton-bodied unit, 1.0 otherwise
//
// Routing and shattered soldiers are excluded from every sum — they
// contribute no offense, no durability, and no state averages. A unit at
// half strength has roughly half the raw sum, and a unit with half its
// living soldiers routing has roughly half again; no separate "alive
// multiplier" is applied on top, because the sums already carry the loss.
//
// The per-soldier offense figures (melee and ranged) are exposed as static
// methods — meleePerSoldierOffense and rangedPerSoldierOffense — so other
// readers of "how much does one soldier of this type hit for" can share
// the exact same computation rather than re-deriving it. The live consumer
// is Unit.getRangedPower, which feeds the team's ranged-duel assessment
// (archer-pressure flip check).
//
// Consumers: Unit.getPower() is the public entry point. AI behaviors
// (target selection, reinforcement dispatch, plan role scoring) read the
// scalar total; UI and debugging read the breakdown.
import { CombatConfig, WeaponMatchup } from '../config/CombatConfig.js';
import { unitHasClass, UnitClass, getRangedRange, isCavalry } from '../config/UnitClasses.js';
import { raceOf, raceHasProperty } from '../config/RaceConfig.js';
import { Property } from '../config/Properties.js';

// Shield HP counts this fraction as much as soldier HP in the durability
// sum. Shields only protect the frontal arc — a shield unit hit from the
// flank gets no benefit from its shield pool at all — so the full pool is
// not worth a full soldier's HP. Tune here; if this needs to be shared
// with combat systems, promote to CombatConfig.
const SHIELD_DURABILITY_WEIGHT = 0.5;

// Offense vs durability weighting in the final raw sum. Offense dominates
// (killing the enemy ends a fight faster than outlasting them), but
// durability is not negligible — a high-HP low-damage unit is still a
// useful anvil and a valid reinforcement.
const OFFENSE_WEIGHT = 1.0;
const DURABILITY_WEIGHT = 0.25;

// Fatigue factor floor. A soldier at zero fatigue still fights, just
// worse; the state multipliers are not intended to zero the unit out
// (morale already does that at the routing threshold). At full fatigue
// the factor is 1.0; at zero it is this value; linear in between.
const MIN_FATIGUE_FACTOR = 0.6;

// Undead power bonus, applied to FOOT undead only. Skeleton-bodied foot
// units already carry a real HP discount (CombatConfig.skeleton.hpMultiplier)
// and a slower foot movement, the latter of which the offense/durability
// terms above do NOT reflect — this multiplier is the deliberate
// compensation on the SCORE, so an undead foot unit reads as the stronger
// option at the card level despite its lower raw durability. Applied here,
// in the single power formula, so the number is IDENTICAL everywhere it is
// read: the AI's per-unit power, the Custom Battle card, the campaign card
// display, and the campaign gold price (via UnitPreview.computeUnitPrice
// -> this method).
//
// CAVALRY ARE EXCLUDED. Undead CAVALRY already skip the slow-foot
// move-speed penalty entirely (see CombatConfig.skeleton.moveSpeedMultiplier's
// isCavalry gate in Soldier.effectiveMoveSpeed), so the downside this
// bonus exists to pay back does not apply to them. Undead cavalry also
// already score heavily through the mass-driven durability term and the
// raw lance damage; the flat +15% on top pushed a skeleton horseman's
// card score ABOVE its living counterpart despite identical offense and
// strictly lower HP — the opposite of the intended read. Gating on
// isCavalry restores the ordering without touching any other unit class.
// See the isCavalry check at the application site below.
const UNDEAD_POWER_MULT = 1.15;

// Fallback multiplier for a race that declares Property.FAST_TIRING but
// does not supply a `fastTiring.powerMultiplier` on its race entry.
// 1.0 = no penalty, so a mis-configured race is inert rather than
// silently scoring lower. Real tuning lives on the race entry — see
// RaceConfig.goblin.fastTiring for the goblin value and the rationale.
const DEFAULT_FAST_TIRING_POWER_MULT = 1.0;

// Ranged baseline calibration.
//
// The raw damage × attacks-per-second × to-hit formula systematically
// undervalues ranged units in this sim, because:
//
//   - Archer volley cadence is one volley per rangedCooldownTicks (35)
//     for the whole unit, versus a melee soldier's one swing per
//     baseMeleeCooldownTicks (4). Per soldier, that is roughly 1/9 the
//     attack rate of a melee unit.
//
//   - Archers deal damage without melee retaliation, force the enemy to
//     close under fire, punish unshielded targets harder than the
//     to-hit table shows (bow's shieldBlock.weaponTypeBlockMult is 1.4
//     — bows are easy to block), and chip morale through stagger and
//     hit events. None of these "soft" contributions are visible to a
//     raw-DPS formula.
//
// This constant is a flat multiplicative boost applied equally to every
// ranged unit — it does NOT differentiate between them. Range and
// accuracy differentiation come from RANGED_ENVELOPE_DIVISOR (below)
// and the per-type rangedRange / rangedAccuracy fields.
//
// Together with RANGED_ENVELOPE_DIVISOR, it is calibrated so a
// full-strength human archer unit (12 soldiers, range 21, accuracy 1.8)
// scores roughly 1000 on the preview scale. Tune this constant UP to
// make the AI value every archer more, DOWN to move back toward the
// raw-DPS reading. For range-specific retuning (a longbowman that
// should scale better than a goblin archer), use the divisor below or
// the per-type range/accuracy fields instead.
const RANGED_POWER_BASELINE = 5.0;

// Ranged-envelope range divisor. A ranged unit's own range (see
// getRangedRange) is divided by this number to produce the range factor
// inside the envelope scale.
//
// DELIBERATELY NOT CombatConfig.rangedRange. The sim's actual firing
// range and the power score's range calibration are separate concerns,
// and coupling them meant a change to one silently rebalanced the other.
// This constant is scoring-only; it does not affect where an arrow
// lands or how far a shot travels.
//
// A SMALLER divisor boosts every ranged unit's power score — each
// unit's rangeFactor grows proportionally. A larger divisor weakens
// them. Relative differentiation between types is preserved: whatever
// this value is, a unit at range R1 and one at range R2 differ by a
// factor of R1 / R2. So a goblin archer at range 12 always reads at
// 12/21 of a full-envelope archer at range 21, no matter what this
// constant is.
//
// 4.25 is the shipped value, chosen so a full-strength human archer
// unit lands at roughly 1000. Lower it to raise archer power, raise it
// to lower archer power.
const RANGED_ENVELOPE_DIVISOR = 4.25;

export class UnitPower {
  // Compute a power breakdown for the given Unit. `options`:
  //   includeRanged     (default true)  — set false to read melee-only
  //                                       power, e.g. for a horse-archer
  //                                       unit the AI is considering as a
  //                                       melee flanker.
  //   includeDurability (default true)  — set false for a pure-offense
  //                                       read (used when scoring a target
  //                                       whose ability to absorb damage is
  //                                       irrelevant, e.g. "how fast can I
  //                                       delete this unit").
  static compute(unit, options = {}) {
    const includeRanged = options.includeRanged !== false;
    const includeDurability = options.includeDurability !== false;

    const deployed = unit.soldiers.length;
    if (deployed === 0) return this._empty(deployed);

    const typeDef = unit.soldiers[0]?.unitTypeDef;
    if (!typeDef) return this._empty(deployed);

    const isRangedUnit = unitHasClass(typeDef, UnitClass.RANGED);

    // Per-soldier offense, computed once — it depends only on the unit's
    // type, not on any individual soldier's current state. Routing and
    // shattered soldiers are excluded from the fighter count below, so the
    // per-soldier figure is simply multiplied by however many are actually
    // still fighting.
    const perSoldierOffense = isRangedUnit
      ? this.rangedPerSoldierOffense(typeDef)
      : this.meleePerSoldierOffense(typeDef);

    const maxFatigue = CombatConfig.fatigue.max ?? 100;

    let meleeOffense = 0;
    let rangedOffense = 0;
    let durability = 0;
    let moraleSum = 0;
    let healthSum = 0;
    let fatigueSum = 0;
    let fighters = 0;

    for (const s of unit.soldiers) {
      if (!s.isAlive()) continue;
      // Routers and shattered soldiers are not fighting. Their HP does
      // not defend the line and their morale is, by definition, already
      // broken — excluding them from every sum is what makes the total
      // reflect "this unit as a fighting force right now", not "this
      // unit's roster on paper".
      if (s.state === 'routing' || s.state === 'shattered') continue;
      fighters++;

      if (perSoldierOffense > 0) {
        if (isRangedUnit) rangedOffense += perSoldierOffense;
        else meleeOffense += perSoldierOffense;
      }

      if (includeDurability) {
        // s.maxHp is the authoritative post-modifier value — the Soldier
        // constructor already applied race HP multiplier and skeleton
        // brittleness to it. Reapplying either here would double-count.
        durability += s.maxHp;
        if (s.hasShield && s.shieldHp > 0) {
          durability += s.shieldHp * SHIELD_DURABILITY_WEIGHT;
        }
      }

      moraleSum += s.maxMorale > 0 ? s.morale / s.maxMorale : 0;
      healthSum += s.maxHp > 0 ? s.hp / s.maxHp : 0;
      fatigueSum += maxFatigue > 0 ? s.fatigue / maxFatigue : 0;
    }

    if (fighters === 0) return this._empty(deployed);

    const avgMorale = moraleSum / fighters;
    const avgHealth = healthSum / fighters;
    const avgFatigue = fatigueSum / fighters;

    const moraleFactor = this._clamp01(avgMorale);
    const healthFactor = this._clamp01(avgHealth);
    const fatigueFactor = MIN_FATIGUE_FACTOR +
      (1 - MIN_FATIGUE_FACTOR) * this._clamp01(avgFatigue);

    // Undead swing on the SCORE, not on the underlying terms. Gated on
    // the race's own supportsUndead flag as defence-in-depth so a
    // misfired isUndead flag on a goblin cannot leak in a bonus the
    // race cannot carry. `unit.isUndead` is race-resolved on the live
    // Unit path (soldiers resolve in Soldier's constructor) and on the
    // preview path (see buildPreviewUnit), so the two agree.
    //
    // CAVALRY EXEMPT: undead CAVALRY skip this bonus entirely — see the
    // note on UNDEAD_POWER_MULT above for the full rationale. Gated on
    // isCavalry(typeDef) rather than reading the class list directly,
    // matching the exclusion pattern used by
    // CombatConfig.skeleton.moveSpeedMultiplier.
    const undeadMult =
      (unit.isUndead === true
       && raceOf(typeDef).supportsUndead !== false
       && !isCavalry(typeDef))
        ? UNDEAD_POWER_MULT
        : 1.0;

    // Fast-tiring race penalty. Applied as a flat multiplier on the
    // final total, in the same slot as undeadMult. See the FAST_TIRING
    // doc block in Properties.js for the full rationale: the sim
    // already drains the race faster, and fatigueFactor already
    // reflects the CURRENT average stamina, so this term only carries
    // the forward-looking piece — "a race that will be winded sooner
    // is worth less even when it is fresh".
    //
    // Read via raceHasProperty, so a per-type exclusion (see
    // UnitTypes.goblinArcher.excludesProperties) is honoured without
    // any extra plumbing.
    const staminaDurabilityMult = this._staminaDurabilityMultiplier(typeDef);
    const disciplineMult = this._disciplinePowerMultiplier(typeDef);
    const moraleCoeff = this._moraleCoefficient(typeDef, unit);

    const offense =
      (includeRanged ? rangedOffense : 0) + meleeOffense;
    const raw =
      offense * OFFENSE_WEIGHT + durability * DURABILITY_WEIGHT;
    const total = raw * moraleFactor * healthFactor * fatigueFactor
                * undeadMult * staminaDurabilityMult * disciplineMult
                * moraleCoeff;

    return {
      total,
      melee: meleeOffense,
      ranged: rangedOffense,
      durability,
      moraleFactor,
      healthFactor,
      fatigueFactor,
      fighters,
      deployed
    };
  }

  // Per-soldier melee offense (damage-per-second, scaled by to-hit and
  // race outgoing damage). Public so other readers of "how hard does one
  // soldier of this type hit in melee" share the exact computation rather
  // than re-deriving it. Returns 0 for a type with no weapon matchup.
  static meleePerSoldierOffense(typeDef) {
    if (!typeDef) return 0;
    const matchup = WeaponMatchup[typeDef.weaponType];
    if (!matchup) return 0;

    const speedMult = typeDef.attackSpeedMultiplier ?? 1;
    const cooldown = Math.max(
      1,
      Math.round(CombatConfig.baseMeleeCooldownTicks / speedMult)
    );
    const attacksPerSecond = CombatConfig.tickRateHz / cooldown;

    const toHitMod = matchup.toHitMod ?? 1;
    const raceDamageMult = raceOf(typeDef).damageMultiplier ?? 1.0;
    // Scoring-only weapon bias — spear 1.10, sword 0.90, others 1.00.
    // Missing entries default to 1.0 so a weapon added to the sim
    // without a power entry scores exactly on its raw per-soldier DPS.
    // Does NOT affect sim combat; see the comment block above
    // WeaponMatchup in CombatConfig.js for the rationale.
    const weaponPowerMult = matchup.powerMultiplier ?? 1.0;

    return matchup.damage
      * attacksPerSecond
      * toHitMod
      * raceDamageMult
      * weaponPowerMult;
  }

  // Per-soldier ranged offense (damage-per-second, scaled by to-hit, race
  // outgoing damage, and the ranged envelope). Public for the same reason
  // as meleePerSoldierOffense — Unit.getRangedPower reads this so the team
  // ranged-duel assessment agrees with the per-unit power score.
  static rangedPerSoldierOffense(typeDef) {
    if (!typeDef) return 0;
    const matchup = WeaponMatchup[typeDef.weaponType];
    if (!matchup) return 0;

    const attacksPerSecond = CombatConfig.tickRateHz / CombatConfig.rangedCooldownTicks;
    const toHitMod = matchup.toHitMod ?? 1;
    const raceDamageMult = raceOf(typeDef).damageMultiplier ?? 1.0;
    // Scoring-only weapon bias. Orthogonal to rangedEnvelopeScale: the
    // envelope encodes HOW FAR and HOW TIGHTLY the weapon reaches; this
    // encodes WHICH weapon it is. A future bow tweak (make all bows
    // score 5% higher) multiplies here and leaves the range/accuracy
    // differentiation intact. See the comment above WeaponMatchup.
    const weaponPowerMult = matchup.powerMultiplier ?? 1.0;

    return matchup.damage
      * attacksPerSecond
      * toHitMod
      * raceDamageMult
      * weaponPowerMult
      * this.rangedEnvelopeScale(typeDef);
  }

  // Envelope scale for a ranged unit type. Three factors, multiplied:
  //
  //   RANGED_POWER_BASELINE — the flat calibration boost. Applies
  //                           equally to every ranged unit; it does not
  //                           differentiate types. See the constant's
  //                           own comment for how to retune.
  //
  //   rangeFactor           = unit range / RANGED_ENVELOPE_DIVISOR. The
  //                           divisor is a scoring-only constant,
  //                           deliberately separate from
  //                           CombatConfig.rangedRange so the sim's
  //                           firing range and the power score's range
  //                           calibration can be tuned independently
  //                           — see the divisor's comment for the
  //                           current value and how to retune. The
  //                           numerator is the type's own range via
  //                           getRangedRange, the shared resolver
  //                           every other consumer reads
  //                           (TargetingSystem, RangedCombatSystem,
  //                           range circle), so a per-type override
  //                           flows through here automatically. A
  //                           shorter-ranged type (goblin archer at
  //                           12) scales below a full-envelope type at
  //                           21; a future longbowman at 25 scales
  //                           above.
  //
  //   accuracyFactor        = default accuracy / unit accuracy. A
  //                           looser-scattered type (goblin archers at
  //                           3.6 vs. the default 1.8) scales below 1.0;
  //                           a tighter-scattered type scales above.
  //
  // Public so Unit.getRangedPower can call rangedPerSoldierOffense (which
  // uses this internally) and no caller needs to duplicate the maths.
  static rangedEnvelopeScale(typeDef) {
    if (!typeDef) return 1;

    let scale = RANGED_POWER_BASELINE;

    const unitRange = getRangedRange(typeDef);
    if (RANGED_ENVELOPE_DIVISOR > 0) {
      scale *= unitRange / RANGED_ENVELOPE_DIVISOR;
    }

    const unitAcc = typeDef.rangedAccuracy ?? CombatConfig.arrow.defaultAccuracy;
    const refAcc = CombatConfig.arrow.defaultAccuracy;
    if (unitAcc > 0) scale *= refAcc / unitAcc;

    return scale;
  }

  // Flat multiplier applied to the final power total for a race that
  // carries Property.FAST_TIRING. Returns 1.0 (no effect) when:
  //   - the type is missing or does not carry the property,
  //   - the type excludes the property (see excludesProperties),
  //   - the race declares the property but ships no fastTiring tuning,
  //   - the tuning value is not a finite number.
  // The numeric tuning lives on the race entry — see
  // RaceConfig.goblin.fastTiring.powerMultiplier and the goblin entry's
  // own comment for the value and how to tune it.
  static _staminaDurabilityMultiplier(typeDef) {
    if (!typeDef) return 1.0;
    if (!raceHasProperty(typeDef, Property.FAST_TIRING)) return 1.0;
    const cfg = raceOf(typeDef).fastTiring;
    if (!cfg || typeof cfg.powerMultiplier !== 'number'
        || !Number.isFinite(cfg.powerMultiplier)) {
      return DEFAULT_FAST_TIRING_POWER_MULT;
    }
    return cfg.powerMultiplier;
  }

// Flat multiplier on the final power total for a unit's discipline
  // tier (see CombatConfig.discipline). Returns 1.0 when the tier does
  // not declare a multiplier or the type is missing, so a race/tier
  // that opts out of the tuning is inert rather than silently scoring
  // lower.
  //
  // This is a SCORING-only term: it changes what the AI and the preview
  // badges think the unit is worth, not what happens in the sim. The
  // mechanical cost of low discipline is already carried by the sim —
  // impetuous charges, loose formation, jitter — and this term is the
  // estimate of what that costs a unit over a battle.
  static _disciplinePowerMultiplier(typeDef) {
    if (!typeDef) return 1.0;
    const discKey = typeDef.discipline || 'normal';
    const cfg = CombatConfig.discipline[discKey]
      || CombatConfig.discipline.normal;
    const mult = cfg.powerMultiplier;
    if (typeof mult !== 'number' || !Number.isFinite(mult)) return 1.0;
    return mult;
  }

static _moraleCoefficient(typeDef, unit) {
    if (!typeDef) return 1.0;
    const race = raceOf(typeDef);
    // Undead are pinned at max morale every tick by MoraleSystem, so no
    // morale-based penalty applies. Gated on the race's own supportsUndead
    // flag so a mis-set isUndead on a non-undead race cannot leak the
    // exemption in.
    if (unit && unit.isUndead === true && race.supportsUndead !== false) {
      return 1.0;
    }
    // Morale ceiling scales sustained value by the ceiling itself only.
    //
    // The previous version (moraleMult * moraleMult * hpMult) stacked
    // three penalties for one underlying weakness and pushed goblins to
    // 0.343 — a full goblin unit scored at roughly a quarter of an
    // equivalent human unit even though its bigger roster more than
    // compensates for the per-soldier stats. The AI, reading that
    // number, treated goblin formations as far weaker than they
    // actually play.
    //
    // - Squared morale: dropped. Regen rate is unchanged across races;
    //   only the ceiling differs, and a linear ceiling reduction is the
    //   honest model.
    // - hpMult: dropped. HP is already multiplied into the durability
    //   term above; applying it here again double-counts the same
    //   physical fragility.
    const moraleMult = race.maxMoraleMultiplier ?? 1.0;
    return moraleMult;
  }

static _empty(deployed = 0) {
    return {
      total: 0,
      melee: 0,
      ranged: 0,
      durability: 0,
      moraleFactor: 0,
      healthFactor: 0,
      fatigueFactor: 0,
      fighters: 0,
      deployed
    };
  }

  static _clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }
}
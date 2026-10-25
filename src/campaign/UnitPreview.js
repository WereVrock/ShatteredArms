// ===== UnitPreview.js =====
// Builds a synthetic "preview" unit and a matching campaign gold price for
// card-selection screens, where the unit being shown does not yet exist as
// a live sim Unit. Used by CampaignFlow and CustomBattleSetup so that:
//
//   - right-clicking a card opens the UnitInfoPanel populated with a
//     full-strength reading of the unit the card represents,
//   - each campaign card can display a gold PRICE derived from the unit's
//     power, and
//   - Custom Battle can show a raw power score via preview.getPower().
//
// POWER FORMULA — SINGLE SOURCE OF TRUTH:
// The power number shown on a card, on a Custom Battle row, and read by
// the AI all comes from UnitPower.compute. This module no longer carries
// its own copy of the formula — it only builds the synthetic Unit-shaped
// object UnitPower.compute reads, and (for the campaign) divides the
// resulting total by POWER_PER_GOLD to produce a gold price.
//
// Two entry points:
//
//   computeUnitPrice({ typeDef, isUndead, aliveCount, championCostMultipliers })
//     Scalar. Campaign gold price for the unit:
//       floor( UnitPower.compute(preview).total / POWER_PER_GOLD )
//     Used for recruiting a new unit and (at full-strength aliveCount)
//     for healing a depleted one. Pricing against the live power formula
//     means any weight change, race multiplier, weapon bias, or the
//     undead bonus propagates to price automatically — no second formula
//     to keep in sync.
//
//     `championCostMultipliers` is optional. When supplied, it is the
//     active champion's cost-multiplier table (see
//     ChampionConfig.goblin_warlord.costMultipliers) and REPLACES the
//     default undead premium — the champion's `undead` key is the final
//     multiplier for skeletons, not a value stacked on top of
//     UNDEAD_RECRUITMENT_COST_MULT. When absent, the default undead
//     premium applies.
//
//   buildPreviewUnit({ id, typeDef, isUndead, aliveCount, maxCount, teamId })
//     Returns a minimal object matching the exact shape UnitInfoPanel
//     reads, PLUS a getPower(options) method that delegates to
//     UnitPower.compute. Callers read preview.getPower().total.
//
// No state. No side effects.

import { CombatConfig } from '../config/CombatConfig.js';
import { MoraleConfig } from '../config/MoraleConfig.js';
import { raceOf } from '../config/RaceConfig.js';
import { UnitPower } from '../sim/UnitPower.js';

// Campaign economy: one gold per 10 power, rounded down. Kept as a named
// constant rather than a magic number so the intent is legible at the
// call site.
const POWER_PER_GOLD = 10;

// Recruitment cost premium for undead recruits, applied when NO champion
// overrides pricing. Skeleton-bodied units are cheaper per-power to field
// in combat terms (lower HP, lower mass) but carry real campaign value:
// they cannot rout, so they never extract and never need to be
// re-recruited between battles. Without this premium, a skeleton spearman
// priced at or below its living equivalent while providing strictly
// better staying power, and undead became the trivially correct purchase
// at every reward screen.
//
// Applied at the price step only — the AI's UnitPower.compute reads are
// unchanged, so the AI does not overvalue undead in its target selection
// or reinforcement dispatch. Tune here to shift the undead market price
// without touching anything else.
//
// A champion that declares its own `costMultipliers` (see ChampionConfig)
// REPLACES this value entirely rather than stacking on top of it.
const UNDEAD_RECRUITMENT_COST_MULT = 1.5;

// Per-soldier max HP, matching the Soldier constructor's path: base HP
// from the type, scaled by the race's HP multiplier, then (if undead) the
// skeleton brittleness discount. Rounded and floored at 1, same as a real
// Soldier's maxHp.
function maxHpForSoldier(typeDef, isUndead, race) {
  const hpMult = race.hpMultiplier ?? 1.0;
  let maxHp = typeDef.baseHp * hpMult;
  if (isUndead) maxHp *= CombatConfig.skeleton.hpMultiplier ?? 1.0;
  return Math.max(1, Math.round(maxHp));
}

// Per-soldier morale ceiling, matching Soldier's race multiplier path.
// MoraleConfig.maxMorale is the universal baseline (100); a race's
// maxMoraleMultiplier scales it (goblins ship at 0.7).
function maxMoraleForSoldier(race) {
  const mult = race.maxMoraleMultiplier ?? 1.0;
  return Math.max(1, Math.round(MoraleConfig.maxMorale * mult));
}

// Campaign gold price. Delegates to UnitPower.compute so the price and
// the AI's own per-unit power score cannot drift apart: any change to a
// weight, race multiplier, weapon bias, or the undead bonus moves both.
//
// The caller decides what `aliveCount` means: a fresh recruit's default
// size for a new-unit purchase, or a depleted unit's maxCount for the
// paid heal. Pricing a heal at maxCount is what makes "restore to full"
// cost the same as "buy new".
//
// `championCostMultipliers` is optional. When supplied, it is the active
// champion's cost-multiplier table (see ChampionConfig.goblin_warlord
// .costMultipliers) and REPLACES the default undead premium — the
// champion's `undead` key is the final multiplier for skeletons, not a
// value stacked on top of UNDEAD_RECRUITMENT_COST_MULT. When absent, the
// default undead premium applies.
export function computeUnitPrice({
  typeDef, isUndead, aliveCount, championCostMultipliers
}) {
  const preview = buildPreviewUnit({
    id: 'price-preview',
    typeDef,
    isUndead,
    aliveCount,
    maxCount: aliveCount,
    teamId: 'blue'
  });
  const basePower = preview.getPower().total;
  let price = Math.floor(basePower / POWER_PER_GOLD);

  if (championCostMultipliers) {
    // Undead branch first: a skeleton's race is still 'human', but the
    // undead flag is the more specific categorisation and should win.
    let mult = 1.0;
    if (isUndead) {
      mult = championCostMultipliers.undead ?? 1.0;
    } else if (typeDef && typeDef.race) {
      mult = championCostMultipliers[typeDef.race] ?? 1.0;
    }
    price = Math.round(price * mult);
  } else if (isUndead) {
    // No champion: default undead premium.
    price = Math.round(price * UNDEAD_RECRUITMENT_COST_MULT);
  }
  return price;
}

export function buildPreviewUnit({
  id, typeDef, isUndead, aliveCount, maxCount, teamId
}) {
  // Undead is a race-level capability. Mirror Soldier's resolution here so
  // a preview of a goblin never shows as a skeleton even if the caller
  // passed isUndead: true — the panel and the roster must agree.
  const race = raceOf(typeDef);
  const raceAllowsUndead = race.supportsUndead !== false;
  const effectiveUndead = raceAllowsUndead && !!isUndead;

  const hp = maxHpForSoldier(typeDef, effectiveUndead, race);
  const morale = maxMoraleForSoldier(race);
  const shieldHp = typeDef.hasShield ? CombatConfig.shieldMaxHp : 0;

  const totalSlots = Math.max(0, maxCount | 0);
  const aliveSlots = Math.max(0, Math.min(aliveCount | 0, totalSlots));

  const soldiers = [];
  for (let i = 0; i < totalSlots; i++) {
    const isAlive = i < aliveSlots;
    soldiers.push({
      unitTypeDef: typeDef,
      isUndead: effectiveUndead,
      hp: isAlive ? hp : 0,
      maxHp: hp,
      morale: isAlive ? morale : 0,
      maxMorale: morale,
      fatigue: isAlive ? 100 : 0,
      hasShield: typeDef.hasShield,
      shieldHp: isAlive ? shieldHp : 0,
      killsThisBattle: 0,
      friendlyFireKillsThisBattle: 0,
      isAlive: () => isAlive
    });
  }

  return {
    id,
    teamId,
    isUndead: effectiveUndead,
    soldiers,
    getAliveSoldiers() {
      return soldiers.filter(s => s.isAlive());
    },
    // Same surface a live Unit exposes. Card display, the Custom Battle
    // row, and any debug overlay all read this and therefore see the
    // exact number the AI sees.
    getPower(options = {}) {
      return UnitPower.compute(this, options);
    }
  };
}
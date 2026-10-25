// ===== UnitXp.js =====
// Unit-level XP and level-up bonuses.
//
// SAME XP SOURCE AS CHAMPION XP. Every attack roll a soldier makes — and
// every attack roll made against them — accrues raw XP equal to the
// OTHER party's per-soldier power times
// CombatConfig.championXpPerSoldierPower. Both the champion's personal
// track and the unit's track read the SAME field (Soldier.championXpRaw);
// the champion applies the curve to his own total, the unit applies it to
// the sum across all its soldiers.
//
// SAME DIMINISHING CURVE. effectiveUnitXp() reuses ChampionSkills'
// effectiveXp — a battle that produces an enormous raw total (a full
// unit making and taking many hundreds of swings) tapers the same way a
// single champion's grind does. One curve, one set of semantics.
//
// DIFFERENT THRESHOLDS. Because unit XP is a SUM across all soldiers, the
// raw numbers are roughly an order of magnitude larger than a champion's.
// The thresholds here are scaled accordingly: a heavy-involvement
// 15-soldier unit earning ~120k raw XP in a battle lands around level 3
// after one battle, level 4-5 after two or three. A unit in a 10-battle
// campaign that consistently fights will reach level 6-7.
//
// BONUSES. Applied at battle build time (CampaignBattleBuilder), on every
// soldier of the levelled unit:
//   - Melee: +10 max morale per level above 1.
//   - Ranged: scatter radius × 0.9 per level above 1 ("10% more accurate"
//     per level in the codebase's vocabulary — scatter radius goes DOWN
//     as accuracy goes up).
//
// The champion's own unit levels with the same rules. The champion
// override (maxMorale forced to 200) is applied AFTER the level bonus, so
// the champion's morale is unaffected by unit level — only the guards
// benefit.

import { effectiveXp } from './ChampionSkills.js';

// Cumulative XP thresholds. Index i = XP required to reach level (i + 1).
//
// Calibration: a light first battle for a 15-soldier melee unit earns
// roughly 30-60k raw → ~20-25k effective. A heavy engagement earns
// 200-400k raw → ~50-55k effective. Long grinding fights taper off via
// the log curve; the thresholds above scale accordingly.
export const UNIT_LEVEL_THRESHOLDS = [
  0,        // level 1
  20000,    // level 2  — one light battle
  55000,    // level 3  — one heavy battle
  110000,   // level 4  — ~3 battles
  200000,   // level 5  — ~5 battles
  330000,   // level 6  — ~8 battles
  500000,   // level 7  — ~12 battles
  720000,   // level 8
  1000000,  // level 9
];

export const UNIT_MAX_LEVEL = UNIT_LEVEL_THRESHOLDS.length;

// Unit level corresponding to a total accumulated XP value.
export function unitLevelForXp(totalXp) {
  let level = 1;
  for (let i = 0; i < UNIT_LEVEL_THRESHOLDS.length; i++) {
    if (totalXp >= UNIT_LEVEL_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}

// Apply the same diminishing curve the champion uses. Kept as its own
// named export so the sim side (and any future UI) does not need to know
// it is literally the champion's function.
export function effectiveUnitXp(rawXp) {
  return effectiveXp(rawXp);
}

// XP required for the next level, or null at max. Used by future UI to
// show progress toward the next rank; harmless today, kept close to the
// thresholds so any tuning pass touches one file.
export function xpForNextUnitLevel(level) {
  const i = Math.max(1, Math.floor(level));
  if (i >= UNIT_LEVEL_THRESHOLDS.length) return null;
  return UNIT_LEVEL_THRESHOLDS[i];
}

// Bonus description, used by future UI. Kept in the data file so a
// tuning change lands in one place, and so a future panel can render
// "Level N — +10 max morale" or "Level N — 20% more accurate" without
// duplicating the formula.
export function unitLevelBonusDescription(level, isRanged) {
  const bonus = Math.max(0, level - 1);
  if (bonus === 0) return '';
  if (isRanged) {
    const pct = Math.round((1 - Math.pow(0.9, bonus)) * 100);
    return `${pct}% more accurate`;
  }
  return `+${10 * bonus} max morale`;
}

// Display-ready progression for one roster entry. Returns:
//   frac  — 0..1 progress toward the next level (1 at max)
//   text  — "45000 / 55000" or "Max level"
//
// Used by CampaignBattleBuilder to pre-compute panel-ready fields on
// each unit at battle build time, so the UI does not import from the
// campaign layer just to render a progress bar.
export function unitXpProgress(level, xp) {
  const lvl = Math.max(1, Math.floor(level || 1));
  const cur = xp || 0;
  if (lvl >= UNIT_LEVEL_THRESHOLDS.length) {
    return { frac: 1, text: 'Max level' };
  }
  const lo = UNIT_LEVEL_THRESHOLDS[lvl - 1];
  const hi = UNIT_LEVEL_THRESHOLDS[lvl];
  const span = Math.max(1, hi - lo);
  const into = Math.max(0, cur - lo);
  return {
    frac: Math.max(0, Math.min(1, into / span)),
    text: `${Math.round(into)} / ${span}`
  };
}
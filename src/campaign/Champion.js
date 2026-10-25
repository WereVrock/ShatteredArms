// ===== Champion.js =====
// Campaign-level champion entity. Owns XP, level, unspent skill points, and
// the set of unlocked node ids. Pure data + method library: never touches
// the sim, never touches the DOM.
//
// The champion's STATS at battle time (max HP, combat mods, bodyguard
// buffs) are computed at the moment the battle roster is built — see
// CampaignBattleBuilder.buildChampionUnit. This class only stores the
// persistent progression.

import { ChampionConfig } from './ChampionConfig.js';
import {
  effectiveXp,
  levelForXp,
  MAX_LEVEL,
  computeCombatMods,
  computeBodyguardMods,
  isNodeUnlockable,
} from './ChampionSkills.js';

export class Champion {
  constructor(defId) {
    this.defId = defId;
    this.xp = 0;
    this.level = 1;
    this.unspentPoints = 0;
    this.unlockedSkills = new Set();

    // Id of the champion's own roster entry. Set once at campaign start
    // and preserved so the battle builder can locate the entry without
    // relying on typeId alone (a future second champion with the same
    // retinue type would need this).
    this.rosterEntryId = null;
  }

  get def() {
    return ChampionConfig[this.defId] || null;
  }

  get displayName() {
    return this.def?.displayName || 'Champion';
  }

  get isMaxLevel() {
    return this.level >= MAX_LEVEL;
  }

  get combatMods() {
    return computeCombatMods(this.unlockedSkills);
  }

  get bodyguardMods() {
    return computeBodyguardMods(this.unlockedSkills);
  }

  // Race-based recruitment cost multipliers for this champion, or null if
  // the champion does not customise pricing. Consumed by
  // UnitPreview.computeUnitPrice — when non-null, the champion's table
  // replaces the default undead premium.
  get costMultipliers() {
    return this.def?.costMultipliers || null;
  }

  // Awards post-battle XP. `rawXp` is the raw amount accrued in the sim;
  // the diminishing curve is applied here, so a single battle cannot
  // trivially jump the champion multiple levels. Returns { gained,
  // levelsGained, newLevel }.
  awardBattleXp(rawXp) {
    const gained = effectiveXp(rawXp);
    if (!(gained > 0)) return { gained: 0, levelsGained: 0, newLevel: this.level };

    this.xp += gained;
    const newLevel = levelForXp(this.xp);
    const levelsGained = newLevel - this.level;
    if (levelsGained > 0) {
      this.level = newLevel;
      this.unspentPoints += levelsGained;
    }
    return { gained, levelsGained, newLevel: this.level };
  }

  canUnlock(nodeId) {
    if (this.unspentPoints <= 0) return false;
    return isNodeUnlockable(nodeId, this.unlockedSkills);
  }

  unlock(nodeId) {
    if (!this.canUnlock(nodeId)) return false;
    this.unlockedSkills.add(nodeId);
    this.unspentPoints -= 1;
    return true;
  }

  toJSON() {
    return {
      defId: this.defId,
      xp: this.xp,
      level: this.level,
      unspentPoints: this.unspentPoints,
      unlockedSkills: [...this.unlockedSkills],
      rosterEntryId: this.rosterEntryId,
    };
  }

  static fromJSON(data) {
    if (!data || typeof data !== 'object') return null;
    if (!ChampionConfig[data.defId]) return null;
    const c = new Champion(data.defId);
    c.xp = typeof data.xp === 'number' ? data.xp : 0;
    c.level = typeof data.level === 'number' ? data.level : 1;
    c.unspentPoints = typeof data.unspentPoints === 'number' ? data.unspentPoints : 0;
    c.unlockedSkills = new Set(Array.isArray(data.unlockedSkills) ? data.unlockedSkills : []);
    c.rosterEntryId = typeof data.rosterEntryId === 'string' ? data.rosterEntryId : null;
    return c;
  }
}
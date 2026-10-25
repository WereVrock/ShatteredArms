// ===== ChampionSkills.js =====
// Pure data + pure functions for champion XP and skill trees.
//
// XP model and thresholds are unchanged from the previous revision — see
// the XP section below. What changed is the SKILL TREE STRUCTURE:
//
//   - Ferocity and Endurance are MERGED into a single Combat tree,
//     one powerful offence node and one powerful defence node per tier.
//   - The third tree is Blood Magic — sacrifice, life-drain, thralls,
//     and the last-chance Blood Pact revive.
//   - Retinue is retained, but every player-facing string says "blood
//     guard" instead of "bodyguard".
//
// All three trees share the tier-unlock contract from before: tier 2
// requires >=1 point spent in the same tree, tier 3 requires >=2.

export const XP_DIMINISH_SCALE = 15000;

export function effectiveXp(rawXp) {
  if (!(rawXp > 0)) return 0;
  return XP_DIMINISH_SCALE * Math.log(1 + rawXp / XP_DIMINISH_SCALE);
}

export const LEVEL_THRESHOLDS = [
  0,        // level 1
  2000,     // level 2
  7000,     // level 3
  20000,    // level 4
  50000,    // level 5
  100000,   // level 6
  180000,   // level 7
  300000,   // level 8
  480000,   // level 9
  720000,   // level 10
];

export const MAX_LEVEL = LEVEL_THRESHOLDS.length;

export function xpForLevel(level) {
  const i = Math.max(0, Math.min(MAX_LEVEL - 1, Math.floor(level) - 1));
  return LEVEL_THRESHOLDS[i];
}

export function levelForXp(totalXp) {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (totalXp >= LEVEL_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}

// Display-ready progression for a champion. Mirrors UnitXp.unitXpProgress
// in shape and semantics, so the same panel code can render either. Used
// by CampaignBattleBuilder to pre-compute panel-ready fields on the
// champion's unit at battle build time, so the UI never has to reach
// into the campaign state to render a progress bar.
export function championXpProgress(level, xp) {
  const lvl = Math.max(1, Math.floor(level || 1));
  const cur = xp || 0;
  if (lvl >= MAX_LEVEL) {
    return { frac: 1, text: 'Max level' };
  }
  const lo = xpForLevel(lvl);
  const hi = xpForLevel(lvl + 1);
  const span = Math.max(1, hi - lo);
  const into = Math.max(0, cur - lo);
  return {
    frac: Math.max(0, Math.min(1, into / span)),
    text: `${Math.round(into)} / ${span}`
  };
}

// ---------------------------------------------------------------------------
// SKILL TREES
// ---------------------------------------------------------------------------
// Effect keys consumed by the sim. Keys ending in 'Mult', 'Chance',
// 'Fraction', or 'Threshold' combine multiplicatively when more than one
// node supplies them; other numeric keys combine additively. Boolean keys
// are last-wins.
//
// New this revision:
//   blastOnHitBelowHpThreshold + blastMassMult + blastCooldownSeconds
//     Blood Fury. When the champion takes a melee hit while below the
//     threshold HP fraction, blasts the attacker with blastMassMult ×
//     the champion's own mass. Uses the charge formula (bonus damage,
//     knockback, throw, knockdown). Cooldown-limited.
//   healOnGuardDeath
//     Blood Debt. When any blood guard of the champion's unit dies, the
//     champion is healed to full.
//   orphanedMountChance
//     Orphaned Mount. When a blood guard dies, chance the mount survives
//     as a riderless beast. (Deferred until render layer exposes mount
//     state — the flag is read and logged, no effect yet.)
//   bloodThrallBaseChance, bloodThrallMarkedChance, bloodThrallDurationTicks,
//   bloodThrallStatMult
//     Blood Thrall. On each champion kill, chance to raise the dead enemy
//     as a half-stat thrall that auto-targets the champion's nearest
//     enemy. A soldier who has struck the champion in melee is "marked";
//     marked kills raise at bloodThrallMarkedChance (100% by default).
//     Thralls live for bloodThrallDurationTicks, then expire.
//   bloodPactHpPerGuard
//     Blood Pact. When the champion dies with at least one blood guard
//     alive, all guards are sacrificed instantly and the champion revives
//     at the death position with bloodPactHpPerGuard × guardsSacrificed HP.

export const SKILL_TREES = [
  {
    id: 'combat',
    name: 'Combat',
    description: 'The champion as a personal killer and survivor.',
    tiers: [
      {
        tier: 1,
        nodes: [
          {
            id: 'bloodletting',
            name: 'Bloodletting',
            description: '+2 damage and +15% to-hit on every melee attack.',
            effect: { flatDamage: 2, toHitMult: 1.15 },
          },
          {
            id: 'ironbound',
            name: 'Ironbound',
            description: '+15 max HP and −2 damage taken from every hit (floor 1).',
            effect: { maxHpBonus: 15, damageTakenFlat: 2 },
          },
        ],
      },
      {
        tier: 2,
        nodes: [
          {
            id: 'crimson_fury',
            name: 'Crimson Fury',
            description: '+25% attack speed.',
            effect: { attackSpeedMult: 1.25 },
          },
          {
            id: 'unbroken',
            name: 'Unbroken',
            description:
              'Regenerate 1 HP per tick while idle, and +30% damage while '
              + 'below 30% HP.',
            effect: { idleRegen: 1.0, lowHpThreshold: 0.30, lowHpDamageMult: 1.30 },
          },
        ],
      },
      {
        tier: 3,
        nodes: [
          {
            id: 'carnage',
            name: 'Carnage',
            description:
              'Double damage against routing or shattered enemies. Each '
              + 'attack also strikes one other nearby enemy for 50%.',
            effect: { routingTargetDamageMult: 2.0, wideArcFraction: 0.5 },
          },
          {
            id: 'vengeful',
            name: 'Vengeful',
            description:
              '+6 max HP per champion level, and 4 damage back to any ' +
              'attacker who strikes the champion in melee.',
            effect: { maxHpPerLevel: 6, retaliationDamage: 4 },
          },
        ],
      },
    ],
  },

  {
    id: 'retinue',
    name: 'Retinue',
    description: 'The champion\'s blood guard — the few who fight at his side.',
    tiers: [
      {
        tier: 1,
        nodes: [
          {
            id: 'battle_drilled',
            name: 'Battle Drilled',
            description: 'Blood guards gain +10 max HP each.',
            effect: { bodyguardMaxHpBonus: 10 },
          },
          {
            id: 'tempered_steel',
            name: 'Tempered Steel',
            description: 'Blood guards deal +15% damage.',
            effect: { bodyguardDamageMult: 1.15 },
          },
        ],
      },
      {
        tier: 2,
        nodes: [
          {
            id: 'shieldwall',
            name: 'Shieldwall',
            description: 'Blood guards gain +50% shield HP.',
            effect: { bodyguardShieldHpMult: 1.50 },
          },
          {
            id: 'devoted',
            name: 'Devoted',
            description:
              'Blood guards gain +25 max morale and cannot rout while the '
              + 'champion still fights.',
            effect: { bodyguardMoraleBonus: 25, bodyguardCannotRout: true },
          },
        ],
      },
      {
        tier: 3,
        nodes: [
          {
            id: 'interpose',
            name: 'Interpose',
            description:
              'When the champion is struck, a nearby healthy blood guard '
              + 'has a 40% chance to absorb the hit instead.',
            effect: { interposeChance: 0.40 },
          },
          {
            id: 'shoulder_to_shoulder',
            name: 'Shoulder to Shoulder',
            description:
              'Blood guards gain +5% damage and +5% to-hit per other living '
              + 'blood guard in the unit.',
            effect: { shoulderToShoulder: true },
          },
        ],
      },
    ],
  },

  {
    id: 'blood_magic',
    name: 'Blood Magic',
    description: 'The champion as a blood-warlock, feeding on the fight itself.',
    tiers: [
      {
        tier: 1,
        nodes: [
          {
            id: 'blood_rite',
            name: 'Blood Rite',
            description: 'The champion heals 8 HP per kill.',
            // No per-battle cap. `Infinity` is written explicitly rather
            // than omitting the key so any consumer that performs a
            // numeric `healed >= cap` check reads "the cap is never
            // reached". The apply-site should also be updated to skip
            // cap bookkeeping entirely — this value is a belt-and-braces
            // safety net while the apply-site is migrated.
            effect: { healOnKill: 8, healOnKillCap: Infinity },
          },
          {
            id: 'blood_fury',
            name: 'Blood Fury',
            description:
              'When struck in melee below 50% HP, the champion blasts the '
              + 'attacker back with twice his own mass. 60-second cooldown.',
            effect: {
              blastOnHitBelowHpThreshold: 0.50,
              blastMassMult: 2.0,
            },
          },
        ],
      },
      {
        tier: 2,
        nodes: [
          {
            id: 'blood_debt',
            name: 'Blood Debt',
            description: 'When a blood guard dies, the champion is healed to full.',
            effect: { healOnGuardDeath: true },
          },
          {
            id: 'orphaned_mount',
            name: 'Orphaned Mount',
            description:
              'When a blood guard dies, his beast may survive as a riderless '
              + 'mount — worse fighter, still charge-capable.',
            effect: { orphanedMountChance: 0.50 },
          },
        ],
      },
      {
        tier: 3,
        nodes: [
          {
            id: 'blood_thrall',
            name: 'Blood Thrall',
            description:
              'The champion\'s own kills raise a blood thrall at 20% — or '
              + '100% if the dead soldier struck him in melee first. His '
              + 'retinue\'s kills raise one at 5%, or 50% when marked. A '
              + 'thrall keeps its original race (an undead falls as undead, '
              + 'a living soldier rises as living), fights with half its '
              + 'stats, never routs, and hunts the champion\'s nearest '
              + 'enemy.',
            effect: {
              // Killer = the champion himself.
              bloodThrallChampionBaseChance: 0.20,
              bloodThrallChampionMarkedChance: 1.00,
              // Killer = any blood guard of the champion's retinue.
              bloodThrallRetinueBaseChance: 0.05,
              bloodThrallRetinueMarkedChance: 0.50,
              bloodThrallStatMult: 0.5,
            },
          },
          {
            id: 'blood_pact',
            name: 'Blood Pact',
            description:
              'When the champion dies with at least one blood guard alive, '
              + 'every guard is sacrificed. The champion revives at that spot '
              + 'with 15 HP per guard sacrificed.',
            effect: { bloodPactHpPerGuard: 15 },
          },
        ],
      },
    ],
  },
];

export function findNode(nodeId) {
  for (const tree of SKILL_TREES) {
    for (const tier of tree.tiers) {
      for (const node of tier.nodes) {
        if (node.id === nodeId) return { tree, tier, node };
      }
    }
  }
  return null;
}

export function pointsInTree(treeId, unlockedSkillIds) {
  let n = 0;
  for (const tree of SKILL_TREES) {
    if (tree.id !== treeId) continue;
    for (const tier of tree.tiers) {
      for (const node of tier.nodes) {
        if (unlockedSkillIds.has(node.id)) n++;
      }
    }
  }
  return n;
}

export function isNodeUnlockable(nodeId, unlockedSkillIds) {
  const found = findNode(nodeId);
  if (!found) return false;
  if (unlockedSkillIds.has(nodeId)) return false;

  const { tree, tier } = found;
  if (tier.tier <= 1) return true;
  const spent = pointsInTree(tree.id, unlockedSkillIds);
  return spent >= tier.tier - 1;
}

// Aggregates champion-side effects (applied to the champion soldier).
// Bodyguard-side keys (bodyguard*) are filtered out here so they do not
// leak into combatMods on the champion itself.
export function computeCombatMods(unlockedSkillIds) {
  const mods = {};
  for (const tree of SKILL_TREES) {
    for (const tier of tree.tiers) {
      for (const node of tier.nodes) {
        if (!unlockedSkillIds.has(node.id)) continue;
        for (const [k, v] of Object.entries(node.effect)) {
          if (k.startsWith('bodyguard')) continue;
          applyEffectField(mods, k, v);
        }
      }
    }
  }
  return mods;
}

// Aggregates bodyguard-side effects (Retinue tree only).
export function computeBodyguardMods(unlockedSkillIds) {
  const mods = {};
  for (const tree of SKILL_TREES) {
    if (tree.id !== 'retinue') continue;
    for (const tier of tree.tiers) {
      for (const node of tier.nodes) {
        if (!unlockedSkillIds.has(node.id)) continue;
        for (const [k, v] of Object.entries(node.effect)) {
          applyEffectField(mods, k, v);
        }
      }
    }
  }
  return mods;
}

function applyEffectField(mods, key, value) {
  if (typeof value === 'boolean') {
    mods[key] = value;
    return;
  }
  if (typeof value !== 'number') {
    mods[key] = value;
    return;
  }
  const multiplicative =
    key.endsWith('Mult') || key.endsWith('Chance')
    || key.endsWith('Fraction') || key.endsWith('Threshold');
  if (mods[key] === undefined) {
    mods[key] = value;
  } else if (multiplicative) {
    mods[key] *= value;
  } else {
    mods[key] += value;
  }
}
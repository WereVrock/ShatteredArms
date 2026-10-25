// ===== ChampionConfig.js =====
// Data-only definitions for campaign champions. A champion is a
// roster-level entity, not a sim-level Unit: it exists as an entry in the
// campaign roster, gets injected into a specific soldier at battle-build
// time, and (on death) ends the campaign.
//
// Adding a second champion is a new entry here plus (optionally) new
// skill trees in ChampionSkills.js. No new class.
//
// --- Fields -----------------------------------------------------------
//   id                       canonical string id
//   displayName              UI label
//   unitTypeId               UnitTypes id the champion's retinue uses
//   initialBodyguards        number of hobgoblins the champion starts with
//                            (champion itself is separate — total unit size
//                            at campaign start is initialBodyguards + 1)
//   championHpMultiplier     multiplier applied to the champion's
//                            retinue bodyguard HP to derive the champion
//                            soldier's own max HP, BEFORE skill bonuses
//                            (Ironbound, Vengeful). Read by BOTH
//                            previewStartingStats (the pre-run preview
//                            screen) AND applyChampionToUnit (the battle
//                            build) via the same bodyguardHp × multiplier
//                            formula — one source of truth, so the number
//                            the player sees on the preview screen is
//                            the number the sim uses.
//   passive                  an always-on champion trait, shown on the
//                            champion info panel, never spendable as a
//                            skill node. See PassiveShape below.
//
// PassiveShape:
//   name                          UI label
//   description                   UI description
//   guaranteedGoblinOffer         if true, every reward screen always
//                                 includes at least one goblin-type offer.
//                                 Existing goblin offers count; the roller
//                                 only adds/replaces when needed.
//   skeletonOfferChanceMultiplier multiplies CampaignConfig.skeletonOfferChance
//                                 when rolling reward offers.

// ---------------------------------------------------------------------------
// FEATURE FLAG — champion system on/off.
//
// When false:
//   - startNewCampaign skips the champion picker entirely.
//   - No Champion instance is created, no retinue entry is added.
//   - Every downstream reader (state.champion?.…) is null-safe and
//     degrades to "no champion" — the campaign runs identically to a
//     pre-champion build.
//   - Any `champion` field present on a legacy save is stripped by
//     CampaignState.load, so a half-built champion from a WIP build
//     cannot leak into a clean run.
//
// Flip to true to re-enable the champion system exactly as it is now.
// No other code change is required — the flows are all gated on
// `state.champion` being non-null, and startNewCampaign is the only
// site that creates one.
//
// This flag FORCES the champion system on regardless of the player's
// runtime setting. When false, the system can still be enabled at
// runtime via the "Enable test features" toggle in the main-menu
// Settings dialog — see areChampionsEnabled() below. Read that function
// at every gate, not this constant directly: the runtime setting is only
// meaningful if it is honoured consistently across all decision sites.
export const CHAMPIONS_ENABLED = false;

export const ChampionConfig = {
  goblin_warlord: {
    id: 'goblin_warlord',
    displayName: 'Goblin Warlord',
    description:
      'A brutal chieftain who fights in the front rank, guarded by a small '
      + 'retinue of hobgoblins. Where the Warlord strikes, the horde '
      + 'follows. When the Warlord falls, the campaign ends.',
    unitTypeId: 'goblinWarlordRetinue',
    // Six blood guards alongside the champion, seven soldiers total. The
    // retinue is a single-row formation (preferredRows: 1 on the type),
    // so the champion and his guards stand shoulder to shoulder.
    initialBodyguards: 6,
    championHpMultiplier: 3.0,
    passive: {
      name: "Warlord's Muster",
      description:
        'Goblins muster to his banner cheaply; humans and skeletons '
        + 'cost him more. Every reward screen offers a goblin recruit, '
        + 'and skeleton recruits appear half as often.',
      guaranteedGoblinOffer: true,
      skeletonOfferChanceMultiplier: 0.5,
    },

    // Race-based recruitment cost multipliers. Applied at the price step
    // (see UnitPreview.computeUnitPrice) — the champion's market, not
    // their sim-side stats. When a champion is active, these replace the
    // default undead premium entirely, so a champion's `undead` value is
    // the FINAL multiplier, not stacked on top of the default.
    //
    // The Warlord runs a goblin army cheaply and pays a premium for
    // anything that does not come from the horde: humans are foreign
    // mercenaries, and skeletons require a necromancer's work.
    //
    // Keyed by race id, plus `undead` as a special key checked BEFORE
    // race (a skeleton's race is still 'human', but the undead branch is
    // the one that should apply).
    costMultipliers: {
      goblin: 0.5,
      human: 1.3,
      undead: 2.0,
    },
  },

  // A mercenary company, not a champion. No Champion instance is created,
  // no retinue unit exists, and no skill tree grows. What it provides is a
  // starting rider and a per-victory payment — see CampaignFlow's
  // _commitPseudoCommander and handleBattleEnded.
  //
  // The pseudoCommander flag distinguishes this entry from a real champion
  // for every code path that cares (currently: CampaignFlow's champion
  // preview commit step). Real champions leave it unset.
  mercenary_captains: {
    id: 'mercenary_captains',
    displayName: 'Mercenary Captains',
    description:
      'You play as a band of mercenary captains — no single leader, no '
      + 'banner to rally behind, no one figurehead whose fall ends the '
      + 'campaign. The captains ride together for as long as the coin '
      + 'flows and the fight is worth it. You start with an experienced '
      + 'rider in your company, and you squeeze 50 more gold out of every '
      + 'victory.',
    pseudoCommander: true,
    startingUnit: { typeId: 'horsemen', isUndead: false, level: 2 },
    goldPerWin: 50,
    startingEffects: [
      { label: 'Starting force', value: '1 × Horsemen (shielded, level 2)' },
      { label: 'Extra income', value: '+50 gold per victory' },
    ],
    passive: {
      name: 'No Figurehead',
      description:
        'The captains do not band under a commander. There is no key '
        + 'leader to lose — your campaign ends only when the company is '
        + 'wiped out or driven from the field.',
    },
  },
};

// Convenience: list of champion ids, in the order they should be shown.
export const CHAMPION_IDS = ['goblin_warlord', 'mercenary_captains'];

export function getChampionConfig(id) {
  return ChampionConfig[id] || null;
}

// Runtime gate for the champion system. True when EITHER the compile-time
// CHAMPIONS_ENABLED flag is set OR the player has flipped "Enable test
// features" in the main-menu Settings dialog. Every decision site that
// used to read CHAMPIONS_ENABLED directly should call this instead — a
// runtime toggle is only meaningful if it is honoured at every gate, not
// just some.
export function areChampionsEnabled() {
  return CHAMPIONS_ENABLED || SettingsStore.get().enableTestFeatures === true;
}

// Resolves a champion definition into the concrete numbers the preview
// screen shows, so the UI does not have to know how HP is derived from
// the unit type + race + champion multiplier. Called by CampaignFlow when
// opening the champion preview; the returned object is presentation-ready.
//
// Returns null if the definition's unit type cannot be resolved (defensive
// against a future champion whose unitTypeId has a typo — the UI should
// degrade to name + description only, not throw).
import { UnitTypes } from '../config/UnitTypes.js';
import { raceOf } from '../config/RaceConfig.js';
import { SettingsStore } from '../ui/settings/SettingsStore.js';
export function previewStartingStats(def) {
  if (!def) return null;
  const unitType = UnitTypes[def.unitTypeId];
  if (!unitType) return null;

  const race = raceOf(unitType);
  const hpMult = race.hpMultiplier ?? 1.0;
  const bodyguardHp = Math.max(1, Math.round(unitType.baseHp * hpMult));
  const championHp = Math.round(bodyguardHp * (def.championHpMultiplier ?? 1.0));

  return {
    bodyguardCount: def.initialBodyguards || 0,
    bodyguardHp,
    championHp,
    bodyguardTypeName: unitType.displayName,
  };
}
// ===== CampaignRewards.js =====
// Between-battle reward generation.
//
// Offers are drawn from the full campaign pool (human + goblin, shielded
// + unshielded) with no pairing rules; duplicates are allowed.
//
// Base offers: CampaignConfig.rewardBaseOffers (default 3).
// If at least one of the base offers is a goblin, a 4th goblin-only offer
// is appended. A 5th offer — a duplicate of a goblin already on offer —
// is appended with CampaignConfig.rewardDuplicateGoblinChance probability.
//
// Recovery (paying to heal one depleted unit) is handled by CampaignFlow
// (see _showHealPicker). This module returns unit offers only.

import { UnitFamilies } from './UnitFamilies.js';
import { CampaignConfig } from './CampaignConfig.js';

// Returns [{ typeId, isUndead }, ...]. `roster` is accepted for API
// compatibility with the previous signature and is currently unused.
export function generateRewards(roster, modifiers = null) {
  const offers = [];

  // Champion passives can shift the base skeleton chance for this reward
  // roll. modifiers.skeletonOfferChanceMultiplier is set by the Goblin
  // Warlord's Warlord's Blood (0.5 = halved). Defaults to 1.0 (no change).
  const skeletonMult = modifiers?.skeletonOfferChanceMultiplier ?? 1;
  const skeletonChance = CampaignConfig.skeletonOfferChance * skeletonMult;

  for (let i = 0; i < CampaignConfig.rewardBaseOffers; i++) {
    offers.push(UnitFamilies.randomOffer({ skeletonChance }));
  }

  // Champion passive: guaranteed goblin offer. If the base roll produced
  // no goblin, replace the last base offer with one. Replacement rather
  // than appending keeps the offer count stable across champions.
  if (modifiers?.guaranteedGoblinOffer
      && !offers.some(o => UnitFamilies.isGoblinTypeId(o.typeId))) {
    offers[offers.length - 1] = UnitFamilies.randomGoblinOffer({ skeletonChance });
  }

  const hasGoblin = offers.some(o => UnitFamilies.isGoblinTypeId(o.typeId));
  if (!hasGoblin) return offers;

  // Guaranteed goblin slot.
  offers.push(UnitFamilies.randomGoblinOffer({ skeletonChance }));

  // Optional duplicate-goblin slot.
  if (Math.random() < CampaignConfig.rewardDuplicateGoblinChance) {
    const goblins = offers.filter(o => UnitFamilies.isGoblinTypeId(o.typeId));
    if (goblins.length > 0) {
      const source = goblins[Math.floor(Math.random() * goblins.length)];
      offers.push({ typeId: source.typeId, isUndead: source.isUndead });
    }
  }

  return offers;
}
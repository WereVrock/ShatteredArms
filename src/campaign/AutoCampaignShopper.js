import { CampaignRoster } from './CampaignRoster.js';
import { CampaignConfig } from './CampaignConfig.js';
import { UnitFamilies } from './UnitFamilies.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { computeUnitPrice } from './UnitPreview.js';

// Buying behaviour of the automated campaign player. Pure data on the
// campaign state: no UI, no storage.
//
//   - Initial selection: every round rolls two distinct offers (same rule
//     as CampaignFlow._rollInitialOffer) and takes a RANDOM affordable one.
//   - After a win: buys random affordable offers until nothing affordable
//     is left, then spends leftover gold on reinforcing the most depleted
//     unit it can afford.

function priceOfOffer(offer) {
  const typeDef = UnitTypes[offer.typeId];
  const size = CampaignConfig.defaultSizes[offer.typeId];
  return computeUnitPrice({
    typeDef,
    isUndead: offer.isUndead,
    aliveCount: size,
    championCostMultipliers: null
  });
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function rollDistinctOffers(state) {
  const excluded = new Set(state.roster.map(e => e.typeId));
  const offers = [];
  let attempts = 0;
  while (offers.length < CampaignConfig.initialOffersPerRound && attempts < 500) {
    attempts++;
    const offer = UnitFamilies.randomOffer({
      skeletonChance: CampaignConfig.skeletonOfferChance
    });
    if (excluded.has(offer.typeId)) continue;
    if (offers.some(o => o.typeId === offer.typeId)) continue;
    offers.push(offer);
  }
  return offers;
}

function reinforcePrice(entry) {
  return computeUnitPrice({
    typeDef: UnitTypes[entry.typeId],
    isUndead: entry.isUndead,
    aliveCount: entry.maxCount,
    championCostMultipliers: null
  });
}

export const AutoCampaignShopper = {
  pickStartingArmy(state) {
    for (let round = 0; round < CampaignConfig.initialPickRounds; round++) {
      const offers = rollDistinctOffers(state);
      const affordable = offers.filter(o => priceOfOffer(o) <= state.gold);
      if (affordable.length === 0) continue;
      const chosen = pickRandom(affordable);
      state.gold -= priceOfOffer(chosen);
      CampaignRoster.addUnit(state.roster, chosen.typeId, chosen.isUndead);
    }
  },

  shopAfterWin(state) {
    const offers = (state.rewardOptions || []).slice();

    for (;;) {
      const affordable = offers.filter(o => priceOfOffer(o) <= state.gold);
      if (affordable.length === 0) break;
      const chosen = pickRandom(affordable);
      offers.splice(offers.indexOf(chosen), 1);
      state.gold -= priceOfOffer(chosen);
      CampaignRoster.addUnit(state.roster, chosen.typeId, chosen.isUndead);
    }
    state.rewardOptions = offers;

    // Leftover gold: reinforce the most depleted unit we can afford.
    if (state.recoveredThisReward) return;
    const candidates = state.roster.filter(
      e => e.aliveCount < e.maxCount && reinforcePrice(e) <= state.gold
    );
    if (candidates.length === 0) return;
    candidates.sort(
      (a, b) => a.aliveCount / a.maxCount - b.aliveCount / b.maxCount
    );
    const target = candidates[0];
    state.gold -= reinforcePrice(target);
    CampaignRoster.recoverUnit(state.roster, target.id);
    state.recoveredThisReward = true;
  }
};
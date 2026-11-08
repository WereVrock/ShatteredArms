import { CampaignRoster } from './CampaignRoster.js';
import { CampaignConfig } from './CampaignConfig.js';
import { CampaignArmy } from './CampaignArmy.js';
import { UnitFamilies } from './UnitFamilies.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { computeUnitPrice } from './UnitPreview.js';
import { canMerge, mergeInRoster } from './UnitMerge.js';

// Buying behaviour of the automated campaign player. Pure data on the
// campaign state: no UI, no storage.
//
// Virtual players play by the same rules the human player does — same
// unit cap, same merge mechanics. They do NOT cheat past the cap:
//
//   - Initial selection: every round rolls two distinct offers (same rule
//     as CampaignFlow._rollInitialOffer) and takes a RANDOM affordable one.
//     Initial picks are 5 units, always under any cap, so they all field.
//   - After a win: buys random affordable offers while a purchase is
//     USEFUL — i.e. there is an open fielded slot, or a same-type entry
//     on the roster to merge into. Once the cap is full and no merge
//     target exists, further purchases would only fill reserve slots the
//     unit cannot join the battle from, so they are skipped and the gold
//     is spent on reinforcing a depleted unit instead.

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

// True when a purchase of `offer` would actually help — i.e. there is an
// open fielded slot, or the roster already holds a same-type entry to
// merge into. A purchase that lands in reserve with no merge partner just
// wastes the gold the same way it would for a human player.
function offerIsUseful(state, offer, cap) {
  if (CampaignArmy.openSlots(state.roster, cap) > 0) return true;
  return state.roster.some(e =>
    e.typeId === offer.typeId && !!e.isUndead === !!offer.isUndead
  );
}

export const AutoCampaignShopper = {
  pickStartingArmy(state) {
    const cap = CampaignArmy.capFor(state.champion);
    for (let round = 0; round < CampaignConfig.initialPickRounds; round++) {
      const offers = rollDistinctOffers(state);
      const affordable = offers.filter(o => priceOfOffer(o) <= state.gold);
      if (affordable.length === 0) continue;
      const chosen = pickRandom(affordable);
      state.gold -= priceOfOffer(chosen);
      const entry = CampaignRoster.addUnit(
        state.roster, chosen.typeId, chosen.isUndead
      );
      CampaignArmy.placeNew(state.roster, entry, cap);
    }
  },

  shopAfterWin(state) {
    const cap = CampaignArmy.capFor(state.champion);
    const offers = (state.rewardOptions || []).slice();

    for (;;) {
      const affordable = offers.filter(o => priceOfOffer(o) <= state.gold);
      const useful = affordable.filter(o => offerIsUseful(state, o, cap));
      if (useful.length === 0) break;

      const chosen = pickRandom(useful);
      offers.splice(offers.indexOf(chosen), 1);
      state.gold -= priceOfOffer(chosen);

      const openSlots = CampaignArmy.openSlots(state.roster, cap);
      const bought = CampaignRoster.addUnit(
        state.roster, chosen.typeId, chosen.isUndead
      );

      if (openSlots > 0) {
        // Fresh slot: place as fielded.
        CampaignArmy.placeNew(state.roster, bought, cap);
        continue;
      }

      // Cap is full — offerIsUseful guaranteed a merge target exists.
      // Prefer a fielded target so the merge does not accidentally
      // promote a reserve entry past the cap.
      const target =
        state.roster.find(
          e => e !== bought && canMerge(e, bought) && CampaignArmy.isFielded(e)
        ) ||
        state.roster.find(e => e !== bought && canMerge(e, bought));

      if (target) {
        mergeInRoster(state.roster, target.id, bought.id);
      } else {
        // Defensive fallback: offerIsUseful should have prevented this.
        // Park the unit in reserve so the roster stays valid.
        CampaignArmy.placeNew(state.roster, bought, cap);
      }
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
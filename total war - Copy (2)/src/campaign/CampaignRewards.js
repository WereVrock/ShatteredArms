import { UnitFamilies } from './UnitFamilies.js';
import { CampaignConfig } from './CampaignConfig.js';

// Between-battle rewards. Three options:
//   1. Recruit a new unit — random type, own shield/skeleton roll shared
//      with option 2's shield roll (same pair semantics as the initial picker).
//   2. Recruit a new unit — different family from option 1.
//   3. Recover one existing unit to full strength.
//
// Both unit offers are drawn from a single call to pickTwoOffers so the
// shield-roll rule is applied exactly as it is on the initial picker.

export function generateRewards(roster) {
  const [offerA, offerB] = UnitFamilies.pickTwoOffers({
    shieldedChance: CampaignConfig.shieldedOfferChance,
    skeletonChance: CampaignConfig.skeletonOfferChance
  });

  return [
    { kind: 'unit', typeId: offerA.typeId, isUndead: offerA.isUndead },
    { kind: 'unit', typeId: offerB.typeId, isUndead: offerB.isUndead },
    { kind: 'recover' }
  ];
}
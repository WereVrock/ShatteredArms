// Difficulty tier configuration. Two named presets, not a slider — see the
// roadmap's tier-configuration entry. Both tiers run identical plan-layer
// machinery; only these parameters differ. Weakened plays worse because the
// same decision-making is dialed back, not because it makes worse decisions
// by construction.
//
// Parameter key / consumer:
//   qualityFloorFraction     -> WeightedSelect (B4). Narrower = picks closer to top.
//   softmaxTemperature       -> WeightedSelect (B4). Lower = more deterministic.
//   riskTolerance            -> PlanRiskGate (B3). Higher = accepts riskier plans.
//   abortThresholdMult       -> PlanScheduler. Scales plan phase timeouts.
//   reactionDelayTicks       -> reserved for Stage F; not consumed yet.
//   pinMinHoldDurationTicks  -> PinDetector (B2). 0 disables exploit-resistance.
//   concentrationAggressiveness -> future weak-point multiplier.
//   chargeReadinessBar       -> future ChargeReadiness tuning.
//   telegraphing             -> reserved for Stage F; not consumed yet.
//   enabledPlans             -> plan pool membership.

export const AITierConfig = {
  best_possible: {
    qualityFloorFraction: 0.9,
    softmaxTemperature: 0.4,
    riskTolerance: 0.7,
    abortThresholdMult: 0.85,
    reactionDelayTicks: 0,
    pinMinHoldDurationTicks: 30,
    concentrationAggressiveness: 1.2,
    chargeReadinessBar: 'permissive',
    telegraphing: false,
    // When true, BattleAssessment reads own-vs-enemy cavalry strength and
    // sets skirmishersWithoutCavalryCover when the enemy has decisive
    // cavalry superiority. SkirmisherBehavior then holds archers just in
    // front of the melee line instead of advancing to standoff. When
    // false, this read is skipped entirely — archers behave as if the
    // cavalry balance is irrelevant, which against a stronger enemy
    // cavalry force gets them caught in the open. Set to false on
    // weakened to make the AI visibly weaker without dumb-AI behavior.
    skirmishersRespectCavalryBalance: true,
    // Empty: no advanced tactics yet. Retreat still fires because
    // PlanScheduler special-cases posture==='retreat' outside this list.
    enabledPlans: []
  },

  weakened: {
    qualityFloorFraction: 0.6,
    softmaxTemperature: 1.4,
    riskTolerance: 0.35,
    abortThresholdMult: 1.25,
    reactionDelayTicks: 8,
    pinMinHoldDurationTicks: 8,
    concentrationAggressiveness: 0.7,
    chargeReadinessBar: 'conservative',
    telegraphing: true,
    // See best_possible. Weakened ignores the cavalry-balance read so
    // archers advance to standoff regardless of the enemy's cavalry
    // strength — a real, exploitable weakness (send cavalry wide against
    // the weakened AI's archers and they die in the open).
    skirmishersRespectCavalryBalance: false,
    enabledPlans: []
  }
};

export const DEFAULT_AI_TIER = 'best_possible';

export function getTierConfig(name) {
  return AITierConfig[name] || AITierConfig[DEFAULT_AI_TIER];
}
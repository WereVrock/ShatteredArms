// ===== AITierConfig.js =====
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
//   decisionIntervalTicks    -> TeamAI.tick(). Ticks between _decide()
//                               cycles. Lower = reacts faster; higher =
//                               slower to respond to a changing field.
//                               Falls back to AIConfig.decisionIntervalTicks
//                               when omitted from a tier.
//   pinMinHoldDurationTicks  -> PinDetector (B2). 0 disables exploit-resistance.
//   concentrationAggressiveness -> future weak-point multiplier.
//   chargeReadinessBar       -> future ChargeReadiness tuning.
//   telegraphing             -> reserved for Stage F; not consumed yet.
//   enabledPlans             -> plan pool membership.
//
// --- Tier-level handicap knobs added for weakened ---
//   postureOverrides              -> TeamAI._postureProfile(). Per-posture
//                                    parameter overrides merged on top of
//                                    AIConfig.posture[posture]. Undefined
//                                    (best-possible) is a no-op.
//   skipCorridorCheck             -> ChargeReadiness.shouldSkipCorridor().
//                                    When true, the corridor sample is
//                                    bypassed entirely and cavalry charges
//                                    through spear screens. Deliberately
//                                    off for weakened — it produces log
//                                    lines that read as bug reports.
//                                    Set true only if a scenario wants the
//                                    AI to visibly make that specific
//                                    mistake on purpose.
//   cavalryAttemptForgiveTicks    -> FlankerBehavior._excludedTargetIds().
//                                    How long a target that has survived
//                                    MAX_SOLO_ATTEMPTS charges stays
//                                    blacklisted. Lower = cav re-commits
//                                    to failed targets more eagerly.
//   maxAlternativesAssessed       -> FlankerBehavior._findCleanAlternative().
//                                    How many fallback targets are probed
//                                    when the primary is refused. Lower =
//                                    cav accepts the first plausible pick
//                                    without comparing.
//   lineAssaultLocalThreatRadius  -> LineAssault._pickTarget(). Radius of
//                                    the local-threat override. 0 disables
//                                    the override entirely — line units
//                                    walk past adjacent enemies toward
//                                    their sticky target. This is the
//                                    single most visible "stupider AI"
//                                    handicap; reintroduces the exact bug
//                                    the override was added to fix.
//   focusFirePreferNearest        -> FocusFireCoordinator._pickFocusTarget().
//                                    When true, archers shoot whatever's
//                                    nearest by centroid instead of
//                                    finishing wounded / unshielded units.

export const AITierConfig = {
  best_possible: {
    qualityFloorFraction: 0.9,
    softmaxTemperature: 0.4,
    riskTolerance: 0.7,
    abortThresholdMult: 0.85,
    reactionDelayTicks: 0,
    // Full-speed decision cadence — matches the pre-tier global default
    // (AIConfig.decisionIntervalTicks). Declared explicitly per tier so
    // a future edit to the global cannot silently slow this tier down.
    decisionIntervalTicks: 15,
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

    // When true, cavalry that finds itself in melee runs the full
    // threat-based disengage logic — an archer target is ground down
    // until an actual threat (enemy cav incoming, spears or swords
    // about to engage) appears, and non-archer targets use the base
    // timer. When false, cavalry uses only the simple fixed timer:
    // after cavalryMeleeCommitTicks in melee, disengage unconditionally,
    // no target inspection, no threat check. Weakened tier sets this
    // false so its charge-and-bounce rhythm is exactly what it was
    // before the threat-based logic existed — a real, exploitable
    // weakness (weakened cav cannot be trusted to finish off archers).
    cavalryThreatBasedDisengage: true,

    // Router-chase mode. 'smart' runs the full seven-condition chase
    // check in FlankerBehavior._canChaseRouter (speed, enemy cav count,
    // enemy cav size, skeleton-vs-human cav ratio, team power ratio
    // with hysteresis, spear corridor, archer-range path, then a 20%
    // roll). 'simple' runs only the corridor check and only when the
    // cav has no other valid non-routing target. Weakened uses 'simple'
    // so its router chases are uninformed and can be baited.
    routerChaseMode: 'smart',
    // Empty: no advanced tactics yet. Retreat still fires because
    // PlanScheduler special-cases posture==='retreat' outside this list.
    enabledPlans: []
    // No postureOverrides / skipCorridorCheck / handicap knobs declared:
    // best-possible's defaults are the un-overridden AIConfig values.
  },

  weakened: {
    // --- Live statistical knobs. These are the cheapest, most honest
    // handicap: WeightedSelect picks visible worse candidates instead of
    // near-optimal ones, and the decision cadence slows reaction time.
    qualityFloorFraction: 0.35,
    softmaxTemperature: 2.5,
    riskTolerance: 0.35,
    abortThresholdMult: 1.25,
    reactionDelayTicks: 8,
    // Weakened decides once per 260 ticks (~17s at 15Hz) instead of once
    // per 15 (~1s) — a 17x slower reaction to a changing field. A threat
    // that appears just after a decision cycle is not answered for up
    // to 260 ticks, where Best-possible would answer it within 15.
    //
    // Note from playtest analysis: at 100 ticks this handicap was
    // visibly inert — it masked Best-possible's target-thrashing by
    // accident (Weakened simply re-decided too rarely to thrash), but
    // it was not what made the tier play worse. The real levers are the
    // boolean flags and handicap knobs below. 260 is set because the
    // request was "15 seconds"; going higher starts to read as
    // paralysis rather than weakness — the AI visibly doesn't respond
    // to new threats on the field at all.
    decisionIntervalTicks: 260,
    pinMinHoldDurationTicks: 8,
    concentrationAggressiveness: 0.7,
    chargeReadinessBar: 'conservative',
    telegraphing: true,
    // See best_possible. Weakened ignores the cavalry-balance read so
    // archers advance to standoff regardless of the enemy's cavalry
    // strength — a real, exploitable weakness (send cavalry wide against
    // the weakened AI's archers and they die in the open).
    skirmishersRespectCavalryBalance: false,
    // See best_possible. Weakened uses the plain fixed-timer disengage:
    // cavalry touches, fights cavalryMeleeCommitTicks, leaves. It does
    // not check for incoming enemy cavalry before committing to a
    // fight, does not detect spears or swords closing in, and does not
    // extend its stay against archer targets. This is exactly the
    // original cav behavior — a charge-and-bounce rhythm that touches
    // archers, does some damage, and leaves them alive at half strength.
    cavalryThreatBasedDisengage: false,
    // See best_possible. Weakened only applies the spear-corridor check,
    // and only when the cav has no other valid non-routing target. No
    // speed check, no enemy-cav check, no power-ratio check, no
    // archer-range path check, no roll. Weakened cav will happily cross
    // the map to run down a router and be baited into archer fire doing
    // it — a real, exploitable weakness.
    routerChaseMode: 'simple',
    enabledPlans: [],

    // --- Posture overrides. Loosens the tier's caution a notch: an
    // aggressively-lenient posture is dialed back, so weakened cav
    // aborts more charges. A negative leniency subtracts from the
    // braced-majority threshold in ChargeReadiness.assess, i.e. the
    // tier refuses more charges than AIConfig.posture.hold would.
    postureOverrides: {
      hold: { chargeReadinessLeniency: -0.20 }
    },

    // --- Tier-level corridor skip. Deliberately off. Enabling it
    // produces cav charging into spear screens, which reads as a bug
    // to anyone scanning the log without tier context. Left as a
    // declared field so a scenario that specifically wants the AI to
    // make that mistake on purpose can flip it without a code change.
    skipCorridorCheck: false,

    // --- Target patience. Lower = cav re-commits to the same
    // failed-charge target sooner. 60 ticks (4s) makes a Weakened
    // cav bounce back onto a refused spear block repeatedly instead
    // of waiting the best-possible 30s before retrying.
    cavalryAttemptForgiveTicks: 60,

    // --- Fallback search depth. 1 means the cav accepts the first
    // plausible alternative that passes the corridor check instead
    // of ranking and comparing several.
    maxAlternativesAssessed: 1,

    // --- Line-unit local-threat override disabled. Reintroduces the
    // exact bug the override was added to fix: line units walk past
    // adjacent enemies toward their sticky target. Short-sighted, not
    // random — the most visible "weakened is a worse commander"
    // handicap in this config.
    lineAssaultLocalThreatRadius: 0,

    // --- Focus fire simplification. Archers shoot whatever's nearest
    // by centroid instead of finishing wounded or unshielded units.
    // A real handicap in the late fight; the mistake a novice AI makes.
    focusFirePreferNearest: true
  }
};

export const DEFAULT_AI_TIER = 'best_possible';

export function getTierConfig(name) {
  return AITierConfig[name] || AITierConfig[DEFAULT_AI_TIER];
}
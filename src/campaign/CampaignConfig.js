// ===== CampaignConfig.js =====
// Tunable campaign numbers. No logic here, only data.

export const CampaignConfig = {
  // --- Economy ---------------------------------------------------------
  // Player starts with this much gold and receives battleReward after every
  // won battle. Gold buys units on the initial picker and the between-
  // battle reward screen, and pays for the (optional) heal.
  startingGold: 1000,
  battleReward: 150,

  // Unit price is computed from the unit's full-strength preview power:
  //   price = floor(power / 10)
  // See UnitPreview.computeUnitPrice. The 10 lives there as a constant;
  // it is deliberately not exposed here to keep a single source of truth
  // for the economy formula. Change it in UnitPreview if needed.

  // --- Difficulty -------------------------------------------------------
  // Preset difficulty modifiers applied at campaign start. The player picks
  // one before the initial unit picker (see CampaignFlow._showDifficultyPicker).
  //
  //   aiTierName           — tier name applied to AITierPreference when a
  //                          campaign battle begins. 'weakened' selects
  //                          the weaker AI preset (see AITierConfig.js);
  //                          'best_possible' is the standard AI.
  //   enemyGoldSchedule    — per-difficulty handcrafted gold budget for the
  //                          first few battles (indices 0..N-1). Each entry
  //                          is the AI's total spending budget for that
  //                          battle; the generator buys units from the
  //                          campaign pool until the budget runs out. The
  //                          schedule diverges by difficulty from battle 2
  //                          onward.
  //   enemyGoldGrowthDelta — added to enemyGoldGrowthPerBattle for battles
  //                          past the end of this difficulty's own
  //                          schedule. +50 = faster escalation, -50 =
  //                          slower. Growth starts from THIS difficulty's
  //                          last scheduled value, so easy continues from
  //                          1600, normal from 1800, hard from 2000.
  //   firstBattleComposition — { human?: N, goblin?: M } describing the
  //                          fixed first-battle AI force. Counts are
  //                          absolute (not weights); the helper draws N
  //                          random human types and M random goblin types,
  //                          all living (isUndead: false). Omit the field
  //                          to leave battle 0 on the gold-budgeted draw.
  //   firstBattleGoldBonus — extra gold spent on ADDITIONAL units on top of
  //                          the fixed composition, drawn from the full
  //                          campaign pool. Only read when
  //                          firstBattleComposition is present. Lets a
  //                          harder tier field a strict superset of a
  //                          softer tier's opening force.
  //
  // Both first-battle fields are read ONLY inside
  // CampaignBattleBuilder.buildFirstBattleRoster, which is called ONLY
  // when battleIndex === 0 and the AI has no carried-over survivors. They
  // therefore have no effect on any later battle's gold.
  difficulties: {
    easy: {
      id: 'easy',
      label: 'Easy',
      description: 'Weaker AI, weaker enemy army.',
      aiTierName: 'weakened',
      enemyGoldSchedule: [350, 700, 1000, 1350, 1600],
      enemyGoldGrowthDelta: -50,
      firstBattleComposition: { goblin: 3 },
      firstBattleGoldBonus: 0
    },
    normal: {
      id: 'normal',
      label: 'Normal',
      description: 'Standard gameplay.',
      aiTierName: 'best_possible',
      enemyGoldSchedule: [350, 750, 1100, 1500, 1800],
      enemyGoldGrowthDelta: 0,
      firstBattleComposition: { human: 2, goblin: 1 },
      firstBattleGoldBonus: 0
    },
    hard: {
      id: 'hard',
      label: 'Hard',
      description: 'Stronger enemy army.',
      aiTierName: 'best_possible',
      enemyGoldSchedule: [350, 800, 1200, 1650, 2000],
      enemyGoldGrowthDelta: 50,
      firstBattleComposition: { human: 2, goblin: 1 },
      firstBattleGoldBonus: 120
    }
  },

  // --- Initial pick ----------------------------------------------------
  // N sequential rounds. Each round shows initialOffersPerRound random
  // units; the player must pick one (no skip). Unaffordable cards are
  // disabled. If every card in a round is unaffordable the round
  // auto-skips (see CampaignFlow._showInitialPicker).
  initialPickRounds: 5,
  initialOffersPerRound: 2,

  // --- Between-battle rewards ------------------------------------------
  // Base number of unit offers. If at least one of the base offers is a
  // goblin, a guaranteed goblin offer is appended. A fifth offer
  // (duplicating a goblin already on offer) is appended with
  // rewardDuplicateGoblinChance. The player buys any number of offers
  // they can afford, and can also pay to heal one depleted unit.
  rewardBaseOffers: 3,
  rewardDuplicateGoblinChance: 0.3,

  // --- Enemy gold ------------------------------------------------------
  // AI roster is generated by spending gold on random units until the
  // budget runs out.
  //
  // Each difficulty declares its OWN handcrafted schedule inside the
  // `difficulties` table above — that is what every campaign battle
  // actually reads (see CampaignBattleBuilder.goldForBattle). The array
  // below is the base schedule and acts purely as a fallback when a
  // difficulty entry is missing or does not declare one. It matches
  // difficulties.normal.enemyGoldSchedule deliberately, so the fallback
  // and the normal preset cannot drift apart.
  //
  // Battles past the end of a difficulty's schedule grow linearly by
  // (enemyGoldGrowthPerBattle + that difficulty's enemyGoldGrowthDelta)
  // from the schedule's last value.
  enemyGoldSchedule: [350, 750, 1100, 1500, 1800],
  enemyGoldGrowthPerBattle: 200,

  // --- Unit-roll knobs -------------------------------------------------
  // Independent chance that any single offered unit is a skeleton-bodied
  // version of its type. Rolled per card. Goblins cannot be skeletons
  // (RaceConfig.supportsUndead), so a goblin offer is always living.
  //
  // 0.2, down from 0.3. With 5 goblin types in the 12-type campaign pool,
  // a goblin offers no skeleton roll, so the effective per-offer skeleton
  // rate at base is (7/12) × 0.2 ≈ 11.7%. The undead recruitment cost
  // premium (see UnitPreview.UNDEAD_RECRUITMENT_COST_MULT) makes skeletons
  // a premium purchase; they should feel like one when they appear. The
  // champion's passive halves this further.
  skeletonOfferChance: 0.2,

  // Chance that a given AI roster unit is a skeleton-bodied version of
  // its type. Rolled per unit.
  aiUndeadChance: 0.25,

  // Default recruitment size per type id.
  defaultSizes: {
    spearman: 15,
    spearmanNoShield: 15,
    swordsman: 15,
    swordsmanNoShield: 15,
    // Goblin units are physically twice the size of their human
    // counterparts. See the long note in the previous revision for why
    // the doubled size is declared directly here rather than derived
    // from RaceConfig.goblin.unitSizeMultiplier.
    goblinSwordsman: 30,
    goblinSwordsmanNoShield: 30,
    goblinSpearman: 30,
    goblinSpearmanNoShield: 30,
    goblinArcher: 24,
    archer: 12,
    horsemen: 15,
    horsemenNoShield: 15,
    // Champion retinue types. The champion's own unit never enters the
    // recruitment pool, so its "size" is nominal — the champion unit's
    // roster entry sets aliveCount/maxCount directly. Kept in sync with
    // ChampionConfig.initialBodyguards + 1 so any code path that reads
    // defaultSizes for a fresh retinue (preview, price, layout) agrees
    // with the roster entry.
    hobgoblinSwordsman: 30,
    goblinWarlordRetinue: 7
  },

  // Battlefield layout. Player at negative Z facing south, AI at positive Z
  // facing north, matching the existing scenarios' facing convention.
  playerBaseZ: -16,
  aiBaseZ: 16,
  unitSpacing: 4.5,
  rankSpacing: 4.0,
  maxUnitsPerRank: 6,
  formationSpacing: 0.7
};
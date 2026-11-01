import { CampaignState } from './CampaignState.js';
import { CampaignRoster } from './CampaignRoster.js';
import { CampaignConfig } from './CampaignConfig.js';
import { ChampionConfig } from './ChampionConfig.js';
import { generateAIRoster, processAISurvivors } from './CampaignBattleBuilder.js';
import { generateRewards } from './CampaignRewards.js';
import { rosterPower } from './CampaignScore.js';
import { CampaignBattleResolver } from './CampaignBattleResolver.js';
import { AutoCampaignShopper } from './AutoCampaignShopper.js';
import { runAutoBattle } from './AutoBattleRunner.js';

// Plays one complete campaign headlessly and returns its result.
//
// Flow (same rules as the human campaign, minus every picker screen):
//   1. Mercenary Captains commander (starting level-2 horsemen, bonus
//      gold per win).
//   2. Random starting picks, then fight until the first loss.
//   3. After each win: gold, fresh offers, buy everything affordable.
//
// Nothing is saved to storage and no high score is submitted here.
//
// Returns { score, battles, wins, timedOut, aborted }.

function commitMercenaryCaptains(state) {
  const def = ChampionConfig.mercenary_captains;
  state.mercenaryCaptain = true;
  if (def && def.startingUnit) {
    const su = def.startingUnit;
    const entry = CampaignRoster.addUnit(state.roster, su.typeId, !!su.isUndead);
    if (entry && su.level) entry.level = su.level;
  }
}

export const AutoCampaignPlayer = {
  async play({
    profile,
    difficulty = 'normal',
    maxBattles = 40,
    maxTicks = 9000,
    abortSignal = { aborted: false },
    onBattle = null
  }) {
    const state = CampaignState.newCampaign();
    state.difficulty = difficulty;
    commitMercenaryCaptains(state);
    AutoCampaignShopper.pickStartingArmy(state);

    let wins = 0;
    let timedOut = 0;

    for (let battleIndex = 0; battleIndex < maxBattles; battleIndex++) {
      state.battleIndex = battleIndex;
      state.aiRoster = generateAIRoster(battleIndex, state.aiRoster, difficulty);
      state.battleAiStartPower = rosterPower(state.aiRoster);

      if (onBattle) onBattle({ battleIndex, ticks: 0 });

      const run = await runAutoBattle(state, {
        playerTierName: profile.tierName,
        maxTicks,
        abortSignal,
        onProgress: (ticks, power) => { if (onBattle) onBattle({ battleIndex, ticks, power }); }
      });

      if (run.aborted) {
        return { score: 0, battles: 0, wins, timedOut, aborted: true };
      }
      if (run.timedOut) timedOut++;

      const sim = run.simulation;
      // A battle that hit the tick cap was settled by BattleStalemate,
      // which names the winner explicitly. Otherwise the player won when
      // every red unit is defeated.
      const playerWon = run.stalemate
        ? run.stalemate.winnerTeam === 'blue'
        : sim.units
          .filter(u => u.teamId === 'red')
          .every(u => u.isDefeated());

      CampaignBattleResolver.applyPlayerLosses(state, sim);
      state.aiRoster = processAISurvivors(state.aiRoster, sim);
      CampaignBattleResolver.scoreBattle(state, sim, playerWon);
      CampaignBattleResolver.awardUnitXp(state, sim);

      if (!playerWon || state.roster.length === 0) break;

      wins++;
      state.gold += CampaignConfig.battleReward;
      const merc = ChampionConfig.mercenary_captains;
      if (merc && typeof merc.goldPerWin === 'number') state.gold += merc.goldPerWin;

      state.rewardOptions = generateRewards(state.roster, null);
      state.recoveredThisReward = false;
      AutoCampaignShopper.shopAfterWin(state);
    }

    return {
      score: Math.round(state.campaignScore || 0),
      battles: state.battleScores.length,
      wins,
      timedOut,
      aborted: false
    };
  }
};
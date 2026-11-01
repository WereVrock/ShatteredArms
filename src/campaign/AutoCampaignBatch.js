// ===== AutoCampaignBatch.js =====
import { AutoCampaignPlayer } from './AutoCampaignPlayer.js';
import { ChampionConfig } from './ChampionConfig.js';
import { HighscoreApi } from '../net/HighscoreApi.js';

// Runs N campaigns for each selected player profile, sequentially, and
// averages the results. Pure logic: progress goes out through callbacks,
// abort comes in through a mutable { aborted } signal.

// Board names used for the two derived "extreme" rows: the worst single
// run of the weakened AI and the best single run of the best-possible AI.
// These are only ever written to the board when the user opts in from the
// admin panel; they are never run as separate profiles.
export const EXTREME_PLAYER_NAMES = {
  weakenedLow: 'iskelet ibo',
  bestPossibleHigh: 'J Cezar'
};

function average(list) {
  if (list.length === 0) return 0;
  let sum = 0;
  for (const v of list) sum += v;
  return sum / list.length;
}

function boardEntry(playerName, score, battles, difficulty) {
  return {
    playerName,
    score: Math.round(score),
    battles: Math.round(battles),
    difficulty,
    commander: ChampionConfig.mercenary_captains.displayName,
    balanceVersion: HighscoreApi.balanceVersion(),
    gameVersion: HighscoreApi.gameVersionName(),
    submittedAt: Date.now()
  };
}

export const AutoCampaignBatch = {
  // Returns one result per profile:
  //   { profile, scores, battles, completedRuns, avgScore, avgBattles }
  // A run interrupted by abort is discarded, never averaged in.
  async run({
    profiles,
    runs,
    difficulty = 'normal',
    maxBattles = 40,
    maxTicks = 9000,
    abortSignal = { aborted: false },
    onBattle = null,
    onRunComplete = null
  }) {
    const results = [];

    for (const profile of profiles) {
      const scores = [];
      const battles = [];

      for (let runIndex = 0; runIndex < runs; runIndex++) {
        if (abortSignal.aborted) break;

        const outcome = await AutoCampaignPlayer.play({
          profile,
          difficulty,
          maxBattles,
          maxTicks,
          abortSignal,
          onBattle: (info) => {
            if (onBattle) onBattle({ profile, runIndex, runs, ...info });
          }
        });
        if (outcome.aborted) break;

        scores.push(outcome.score);
        battles.push(outcome.battles);
        if (onRunComplete) onRunComplete({ profile, runIndex, runs, outcome });
      }

      results.push({
        profile,
        scores,
        battles,
        completedRuns: scores.length,
        avgScore: average(scores),
        avgBattles: average(battles)
      });
      if (abortSignal.aborted) break;
    }

    return results;
  },

  // Board row for one result. Looks like any human submission: it carries
  // nothing that says it was automated.
  buildScoreEntry(result, difficulty) {
    return boardEntry(
      result.profile.playerName,
      result.avgScore,
      result.avgBattles,
      difficulty
    );
  },

  // Derives at most two extra board entries from a batch's raw runs:
  //   - weakened AI,    lowest  single-run score -> "iskelet ibo"
  //   - best_possible AI, highest single-run score -> "J Cezar"
  // A profile that was not run yields no entry. Each entry carries the
  // score and battle count of that specific extreme run, not an average.
  buildExtremeEntries(results, difficulty) {
    const entries = [];
    if (!results) return entries;

    const weakened = results.find(
      r => r.profile.tierName === 'weakened' && r.completedRuns > 0
    );
    if (weakened) {
      const idx = weakened.scores.indexOf(Math.min(...weakened.scores));
      entries.push(boardEntry(
        EXTREME_PLAYER_NAMES.weakenedLow,
        weakened.scores[idx],
        weakened.battles[idx],
        difficulty
      ));
    }

    const best = results.find(
      r => r.profile.tierName === 'best_possible' && r.completedRuns > 0
    );
    if (best) {
      const idx = best.scores.indexOf(Math.max(...best.scores));
      entries.push(boardEntry(
        EXTREME_PLAYER_NAMES.bestPossibleHigh,
        best.scores[idx],
        best.battles[idx],
        difficulty
      ));
    }

    return entries;
  }
};
// ===== AutoCampaignBatch.js =====
import { AutoCampaignPlayer } from './AutoCampaignPlayer.js';
import { ChampionConfig } from './ChampionConfig.js';
import { HighscoreApi } from '../net/HighscoreApi.js';

// Runs N campaigns for each selected player profile, sequentially, and
// averages the results. Pure logic: progress goes out through callbacks,
// abort comes in through a mutable { aborted } signal.

// Board names used for the derived "extreme" rows:
//   - Deli ibo    — lowest single-run score of the weakened AI
//   - J Cezar     — highest single-run score of the best-possible AI
//   - İskender 1.5 — J Cezar × 1.5 (derived from J Cezar, not run)
// These are only ever written to the board when the user opts in from the
// admin panel; they are never run as separate profiles.
export const EXTREME_PLAYER_NAMES = {
  weakenedLow: 'Deli ibo',
  bestPossibleHigh: 'J Cezar',
  iskender: '\u0130skender 1.5'
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

  // Derives the extra board entries from a batch's raw runs:
  //   - weakened AI,      lowest  single-run score -> "Deli ibo"
  //   - best_possible AI, highest single-run score -> "J Cezar"
  //   - best_possible AI, highest single-run score × 1.5 -> "İskender 1.5"
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
      const bestScore = best.scores[idx];
      const bestBattles = best.battles[idx];

      entries.push(boardEntry(
        EXTREME_PLAYER_NAMES.bestPossibleHigh,
        bestScore,
        bestBattles,
        difficulty
      ));

      // İskender 1.5 — derived from J Cezar's run, not run itself.
      // Score is J Cezar × 1.5; battles are copied from the same
      // underlying run (the raw run did not change, only the score).
      entries.push(boardEntry(
        EXTREME_PLAYER_NAMES.iskender,
        bestScore * 1.5,
        bestBattles,
        difficulty
      ));
    }

    return entries;
  }
};
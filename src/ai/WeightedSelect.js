// B4 — Weighted, non-deterministic selection among viable candidates.
//
// Every decision point that would otherwise be a deterministic argmax
// ("pick the best X") instead:
//   1. Scores all candidates using existing scoring logic.
//   2. Excludes candidates whose score falls below a quality floor —
//      "within X% of the top-scored candidate," not an absolute threshold,
//      so suboptimal never becomes bad.
//   3. Weighted-random-samples the survivors, weighted toward higher
//      scores via softmax over (score - best) / temperature.
//
// This is deliberately the ONLY source of non-determinism in the AI. It
// does not read the player, remember prior battles, or adapt. Replaying
// the same opening produces different — but consistently good — choices.
export class WeightedSelect {
  // candidates: any array.
  // opts.getScore: (candidate) -> number (higher is better).
  // opts.qualityFloorFraction: 0..1. 0.9 = only top-10%-band eligible;
  //   0.6 = top-40%-band eligible.
  // opts.temperature: softmax temperature. Lower = more deterministic.
  //
  // Returns one of the candidates, or null if the array is empty.
  static pick(candidates, opts) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const getScore = opts.getScore;
    const scored = candidates.map(c => ({ candidate: c, score: getScore(c) }));

    let best = -Infinity;
    for (const e of scored) if (e.score > best) best = e.score;
    if (!isFinite(best)) return candidates[0];

    const fraction = clamp01(opts.qualityFloorFraction ?? 1.0);
    const threshold = best - (1 - fraction) * Math.abs(best || 1);
    const eligible = scored.filter(e => e.score >= threshold);
    if (eligible.length === 0) return candidates[0];
    if (eligible.length === 1) return eligible[0].candidate;

    const temp = Math.max(1e-6, opts.temperature ?? 1.0);
    const weights = eligible.map(e => Math.exp((e.score - best) / temp));
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return eligible[0].candidate;

    let r = Math.random() * total;
    for (let i = 0; i < eligible.length; i++) {
      r -= weights[i];
      if (r <= 0) return eligible[i].candidate;
    }
    return eligible[eligible.length - 1].candidate;
  }
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
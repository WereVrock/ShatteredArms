// B3 — Plan / action cost-risk gate.
//
// A plan that succeeds 70% of the time and fails catastrophically the other
// 30% is worse than reactive behavior. Feasibility (entry/exit conditions)
// asks "will it land?" — the risk gate asks the separate question "is it
// worth the cost if it doesn't?"
//
// Each plan reports an expected outcome as { upside, downside, successProb }:
//   upside       — projected benefit if the plan lands clean (0..1 scale)
//   downside     — projected cost if the plan fails badly (0..1 scale)
//   successProb  — the plan's own confidence estimate (0..1)
//
// Expected value = p * upside - (1 - p) * downside.
// A plan is allowed iff its EV does not fall below
// (-riskTolerance * downside) — i.e., the worst-case expected loss stays
// inside the tier's tolerance.
//
// This is a conservative prior ("assume average-case enemy response"),
// deliberately NOT tuned against opponent history. Any opponent modeling is
// a non-goal; unpredictability comes from B4, not from reading the player.
export class PlanRiskGate {
  static evaluate(candidate, tierCfg) {
    if (!candidate) return { allowed: false, reason: 'no candidate' };
    const upside = num(candidate.upside, 0);
    const downside = num(candidate.downside, 0);
    const p = clamp01(candidate.successProb ?? 0.5);

    const ev = p * upside - (1 - p) * downside;
    const tolerance = clamp01(tierCfg.riskTolerance ?? 0.5);
    const minEv = -tolerance * downside;

    if (ev < minEv) {
      return {
        allowed: false,
        expectedValue: ev,
        reason: `EV ${ev.toFixed(3)} below tolerance ${minEv.toFixed(3)} (p=${p.toFixed(2)})`
      };
    }
    return { allowed: true, expectedValue: ev, reason: 'ok' };
  }
}

function num(v, d) {
  return typeof v === 'number' && isFinite(v) ? v : d;
}
function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
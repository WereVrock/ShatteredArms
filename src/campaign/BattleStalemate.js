import { teamPowerFromSim } from './CampaignScore.js';

// Resolves a battle that hit the tick cap without a winner. It always
// produces a winner:
//
//   Normal case (at least one side lost power during the battle)
//     1. Per-tick power loss of each side = (power at start - power now) / ticks.
//     2. Estimated ticks until a side reaches 0 power = power now / its loss
//        rate. The side that gets there first loses; that is the estimate T.
//     3. The loser is wiped out. The winner is charged (its loss rate * T) in
//        power, taken by killing random soldiers until that amount is removed.
//
//   No-trend case (neither side lost any power)
//     Nothing can be extrapolated, so the side with more power left wins and
//     the loser is wiped out. The winner loses nothing. An exact tie goes to
//     red, so the player never wins on a coin flip.
//
// At least one winner soldier is always left alive. Returns
// { resolved, winnerTeam, loserTeam, estimatedTicks, byPowerComparison, ... }.
//
// Pure sim manipulation: no DOM, no storage.

const TEAMS = ['blue', 'red'];

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function kill(soldier) {
  soldier.hp = 0;
  soldier.state = 'dead';
  soldier.targetId = null;
}

// One entry per living soldier of the team: { soldier, power }, where power
// is the unit's current power split evenly across its living soldiers.
// Riderless mounts are skipped: they never persist and carry no power.
function soldierPowers(units, teamId) {
  const list = [];
  for (const unit of units) {
    if (unit.teamId !== teamId) continue;
    const alive = unit.getAliveSoldiers().filter(s => !s.isRiderlessMount);
    if (alive.length === 0) continue;
    const each = unit.getPower().total / alive.length;
    for (const soldier of alive) list.push({ soldier, power: each });
  }
  return list;
}

function wipeTeam(units, teamId) {
  for (const unit of units) {
    if (unit.teamId !== teamId) continue;
    for (const s of unit.getAliveSoldiers()) kill(s);
  }
}

function killRandomUntilPowerLost(candidates, powerToLose) {
  shuffle(candidates);
  let lost = 0;
  let killed = 0;
  // Always keep one soldier alive.
  for (let i = 0; i < candidates.length - 1 && lost < powerToLose; i++) {
    kill(candidates[i].soldier);
    lost += candidates[i].power;
    killed++;
  }
  return { lost, killed };
}

export const BattleStalemate = {
  snapshotPower(units) {
    return {
      blue: teamPowerFromSim(units, 'blue'),
      red: teamPowerFromSim(units, 'red')
    };
  },

  // startPower: result of snapshotPower at tick 0. ticks: ticks simulated.
  resolve(sim, startPower, ticks) {
    if (!startPower || ticks <= 0) return { resolved: false };

    const endPower = this.snapshotPower(sim.units);
    const rate = {};
    const ticksToZero = {};
    for (const t of TEAMS) {
      rate[t] = Math.max(0, (startPower[t] - endPower[t]) / ticks);
      ticksToZero[t] = rate[t] > 0 ? endPower[t] / rate[t] : Infinity;
    }

    const noTrend = ticksToZero.blue === Infinity && ticksToZero.red === Infinity;

    let loser;
    let estimatedTicks;
    let winnerLoss;

    if (noTrend) {
      loser = endPower.blue > endPower.red ? 'red' : 'blue';
      if (endPower.blue === endPower.red) loser = 'blue';
      estimatedTicks = Infinity;
      winnerLoss = 0;
    } else {
      if (ticksToZero.blue === ticksToZero.red) {
        loser = endPower.blue <= endPower.red ? 'blue' : 'red';
      } else {
        loser = ticksToZero.blue < ticksToZero.red ? 'blue' : 'red';
      }
      const winnerTeam = loser === 'blue' ? 'red' : 'blue';
      estimatedTicks = ticksToZero[loser];
      // Winner power loss over the estimated time, clamped below its total.
      winnerLoss = Math.min(
        rate[winnerTeam] * estimatedTicks,
        endPower[winnerTeam] * 0.95
      );
    }

    const winner = loser === 'blue' ? 'red' : 'blue';
    const winnerCandidates = soldierPowers(sim.units, winner);
    wipeTeam(sim.units, loser);
    const { lost, killed } = killRandomUntilPowerLost(winnerCandidates, winnerLoss);

    return {
      resolved: true,
      loserTeam: loser,
      winnerTeam: winner,
      estimatedTicks,
      byPowerComparison: noTrend,
      winnerPowerLost: lost,
      winnerSoldiersKilled: killed
    };
  }
};
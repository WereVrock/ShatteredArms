import { BattleSimulation } from '../sim/BattleSimulation.js';
import { BattleAI } from '../ai/BattleAI.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';
import { DeploymentPhase } from '../deployment/DeploymentPhase.js';
import { buildCampaignScenario } from './CampaignBattleBuilder.js';
import { CampaignConfig } from './CampaignConfig.js';
import { AITierPreference } from '../config/AITierPreference.js';
import { BattleStalemate } from './BattleStalemate.js';
import { isEitherSideBroken } from './RoutedSideCheck.js';
import { yieldToEventLoop } from './BackgroundRun.js';

// Runs ONE campaign battle with no rendering and no input. Both teams are
// AI-driven: red uses the campaign difficulty's tier (exactly as in a real
// campaign), blue uses `playerTierName`.
//
// Ends when:
//   - sim.isBattleOver() (a side has no non-shattered soldier), or
//   - one side has had only routing / shattered soldiers for
//     BROKEN_HOLD_TICKS in a row (see RoutedSideCheck), or
//   - the tick cap is reached: BattleStalemate then picks a winner from
//     each side's power-loss rate (or from remaining power when neither
//     side lost any) and applies the estimated losses.
//
// Yields through a MessageChannel about every 50 ms (see BackgroundRun.js)
// so the host page stays responsive and the run keeps its speed in a
// background tab. The abort signal is checked at each yield.
//
// onProgress(ticks, power) fires at the start and at every yield, where
// power is { blue, red }.
//
// Returns { simulation, ticks, timedOut, stalemate, aborted }.
//   timedOut  - the tick cap was reached
//   stalemate - the BattleStalemate result when it was applied, else null
//               (stalemate.winnerTeam names the winner of a capped battle)

const YIELD_INTERVAL_MS = 50;
const DEFAULT_MAX_TICKS = 9000;
// Consecutive ticks a side must be entirely routing / shattered before the
// battle is called. Absorbs a one-tick wobble when a soldier rallies.
const BROKEN_HOLD_TICKS = 15;

export async function runAutoBattle(state, options = {}) {
  const playerTierName = options.playerTierName;
  const maxTicks = options.maxTicks ?? DEFAULT_MAX_TICKS;
  const abortSignal = options.abortSignal || { aborted: false };
  const onProgress = options.onProgress || null;

  const prevLogEnabled = AIDebugLog.enabled;
  AIDebugLog.enabled = false;

  try {
    const scenario = buildCampaignScenario(state);
    const units = scenario.build();
    const sim = new BattleSimulation(units, { playerTeamId: scenario.playerTeamId });

    const tiers = { blue: playerTierName };
    const diffCfg = state.difficulty
      ? CampaignConfig.difficulties[state.difficulty]
      : null;
    if (diffCfg && diffCfg.aiTierName) {
      tiers.red = diffCfg.aiTierName;
      AITierPreference.set(diffCfg.aiTierName);
    }

    sim.battleAI = new BattleAI(sim.units, ['blue', 'red'], {
      valiantDefenceTeamIds: ['blue', 'red'],
      tierNameByTeamId: tiers
    });

    // A human player always advances; red (the campaign AI) holds or
    // attacks by its own assessment. If blue also computed 'defence'
    // from its strength ratio, both armies would wait for each other
    // until the tick cap. TeamAI only computes a stance while _stance
    // is null, so presetting it here is honoured for the whole battle.
    const blueAI = sim.battleAI.teamAIs.find(ai => ai.teamId === 'blue');
    if (blueAI) blueAI._stance = 'offence';

    // No human team: the deployment director places both armies.
    const deployment = new DeploymentPhase(sim, { playerTeamIds: [] });
    sim.deploymentPhase = deployment;
    deployment.startBattle();

    // Power baseline for the stalemate estimate, taken after deployment.
    const startPower = BattleStalemate.snapshotPower(sim.units);
    if (onProgress) onProgress(0, startPower);

    let ticks = 0;
    let over = false;
    let brokenTicks = 0;
    let lastYield = performance.now();

    for (; ticks < maxTicks; ticks++) {
      const now = performance.now();
      if (now - lastYield > YIELD_INTERVAL_MS) {
        lastYield = now;
        await yieldToEventLoop();
        if (onProgress) onProgress(ticks, BattleStalemate.snapshotPower(sim.units));
        if (abortSignal.aborted) {
          return { simulation: sim, ticks, timedOut: false, stalemate: null, aborted: true };
        }
      }

      sim.tick();
      // Events accumulate forever if nobody drains them.
      sim.combatResolutionSystem.drainEvents();
      sim.projectileSystem.drainEvents();

      if (sim.isBattleOver()) {
        over = true;
        break;
      }

      if (isEitherSideBroken(sim.units)) {
        brokenTicks++;
        if (brokenTicks >= BROKEN_HOLD_TICKS) {
          over = true;
          break;
        }
      } else {
        brokenTicks = 0;
      }
    }

    const reachedCap = !over;
    let stalemate = null;
    if (reachedCap) {
      const result = BattleStalemate.resolve(sim, startPower, ticks);
      if (result.resolved) {
        stalemate = result;
        over = true;
      }
    }

    if (over) sim.forceExtractRunners();
    return { simulation: sim, ticks, timedOut: reachedCap, stalemate, aborted: false };
  } finally {
    AIDebugLog.enabled = prevLogEnabled;
  }
}
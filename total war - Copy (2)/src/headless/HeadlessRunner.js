// Runs a scenario headlessly: builds units, ticks the simulation, tallies
// every melee / ranged event, prints snapshots and a per-run health summary,
// returns a result. No rendering, no input, no DOM access.
//
// ASYNC: the tick loop yields to the event loop roughly every 50ms of wall
// time. This lets the host page (headlessMain) process UI events -- most
// importantly the Terminate button and the periodic log-refresh timer --
// while a scenario is running. Without the yields, a blocking run would
// freeze the page for the entire scenario duration.
//
// All log output (both the runner's own summary and everything AIDebugLog
// emits) is routed through BatchLogger. Nothing is printed to the console
// until the scenario completes; at that point BatchLogger.flush() emits one
// batched console.log. This is a large wall-clock win in DevTools, where
// per-line console.log round-trips dominate runtime.
//
// Event draining is important: CombatResolutionSystem and RangedCombatSystem
// accumulate events indefinitely if nobody drains them. We drain once per
// tick -- same as the main render loop -- and TALLY each event before
// discarding, so the health summary at the end reflects the whole run.

import { BattleSimulation } from '../sim/BattleSimulation.js';
import { BattleAI } from '../ai/BattleAI.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';
import { BatchLogger } from '../logging/BatchLogger.js';

const DEFAULT_MAX_TICKS = 1200;
const DEFAULT_SNAPSHOT_EVERY = 60;

// Wall-clock milliseconds between yields to the event loop. Smaller = more
// responsive UI + terminate button, at a small per-yield cost. 50ms is a
// good default -- terminate feels immediate, and the yield overhead is
// negligible even for short scenarios.
const YIELD_INTERVAL_MS = 50;

export async function runScenario(scenario, options = {}) {
  const verbose = !!options.verbose;
  const maxTicks = options.maxTicks ?? scenario.maxTicks ?? DEFAULT_MAX_TICKS;
  const snapshotEvery = options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
  // Mutable signal object owned by the caller (headlessMain). When
  // signal.aborted flips true, the tick loop breaks at the next yield.
  const abortSignal = options.abortSignal || { aborted: false };

  const prevLogEnabled = AIDebugLog.enabled;
  AIDebugLog.enabled = verbose;

  try {
    const units = scenario.build();
    const sim = new BattleSimulation(units);
    const aiTeams = scenario.aiTeams ?? ['red'];
    if (aiTeams.length > 0) {
      sim.battleAI = new BattleAI(sim.units, aiTeams, {
        valiantDefenceTeamIds: scenario.valiantDefenceTeamIds
      });
    }

    // Scripted orders: scenario-issued move orders applied at specific
    // ticks, bypassing AI. Shape:
    //   scriptedOrders: [
    //     { unitId, atTick, x, z, facing }
    //   ]
    //
    // Orders are applied ONCE at the specified tick, before sim.tick()
    // for that tick. A scripted unit's team should NOT be listed in
    // scenario.aiTeams -- the AI runs inside sim.tick() and would
    // re-issue its own orders, overriding the script. Teams not listed
    // in aiTeams receive no orders from AI and simply execute whatever
    // the script gave them (or hold their formation slot if no order
    // was ever issued).
    //
    // Bucket by tick so the loop can check for due orders in O(1).
    const scriptedOrders = scenario.scriptedOrders || [];
    const scriptsByTick = new Map();
    for (const order of scriptedOrders) {
      const list = scriptsByTick.get(order.atTick);
      if (list) list.push(order);
      else scriptsByTick.set(order.atTick, [order]);
    }

    const stats = _emptyStats();

    // Report initial progress so the host UI can show "tick 0 / M" before
    // the first yield fires.
    if (typeof options.onProgress === 'function') {
      options.onProgress({ ticks: 0, maxTicks, remainingTicks: maxTicks });
    }

    BatchLogger.push(null, `=== ${scenario.name} ===`);
    BatchLogger.push(null, `  ${scenario.description}`);
    BatchLogger.push(null, `  setup: ${_describeSetup(sim.units)}`);
    BatchLogger.push(null, `  start: ${_formatSnapshot(_snapshot(sim))}`);

    let ticks = 0;
    let winner = null;
    let lastSnapshotAt = 0;
    let terminated = false;
    let lastYield = performance.now();

    for (; ticks < maxTicks; ticks++) {
      // Yield to the event loop periodically. This is what makes the run
      // non-blocking from the host page's perspective: the Terminate
      // button and the log-refresh interval timer both get a chance to
      // fire during these gaps.
      const now = performance.now();
      if (now - lastYield > YIELD_INTERVAL_MS) {
        lastYield = now;
        await new Promise(resolve => setTimeout(resolve, 0));
        if (typeof options.onProgress === 'function') {
          options.onProgress({
            ticks,
            maxTicks,
            remainingTicks: Math.max(0, maxTicks - ticks)
          });
        }
        if (abortSignal.aborted) {
          terminated = true;
          break;
        }
      }

      // Apply any scripted orders scheduled for this tick, before the
      // simulation runs. See scriptedOrders handling above.
      const dueOrders = scriptsByTick.get(ticks);
      if (dueOrders) {
        for (const order of dueOrders) {
          const u = sim.unitsById.get(order.unitId);
          if (u && !u.isDefeated()) {
            u.issueMoveOrder(order.x, order.z, order.facing);
          }
        }
      }

      sim.tick();

      const meleeEvts = sim.combatResolutionSystem.drainEvents();
      // Arrow events now come from ProjectileSystem — RangedCombatSystem
      // spawns arrows into it and no longer owns damage resolution or
      // event emission. See ProjectileSystem.js.
      const rangedEvts = sim.projectileSystem.drainEvents();
      for (const e of meleeEvts) _countMeleeEvent(e, stats);
      for (const e of rangedEvts) _countRangedEvent(e, stats);

      // Sample routing state once per tick. Cheap -- a walk of units and
      // soldiers -- and it is the only way to see routing from the headless
      // output, since routing does not emit a combat event.
      let routersNow = 0;
      for (const u of sim.units) {
        for (const s of u.soldiers) {
          if (!s.isAlive()) continue;
          if (s.state === 'routing') routersNow++;
          // Skip undead -- they are force-pinned to maxMorale every tick
          // and would mask real drains if they ever existed in a scenario.
          if (!s.isUndead && s.morale < stats.morale.minMorale) {
            stats.morale.minMorale = s.morale;
          }
        }
      }
      stats.morale.routerTicks += routersNow;
      if (routersNow > stats.morale.peakRouters) {
        stats.morale.peakRouters = routersNow;
      }

      if (ticks > 0 && (ticks - lastSnapshotAt) >= snapshotEvery) {
        lastSnapshotAt = ticks;
        BatchLogger.push(null, `  t${ticks}: ${_formatSnapshot(_snapshot(sim))}`);
      }

      if (sim.isBattleOver()) {
        // Any routing or shattered soldiers still on the field are treated
        // as having escaped -- this makes the extraction record complete
        // before the campaign layer could read it. In headless runs there
        // is no player to prompt about pursuit, so extraction is automatic.
        sim.forceExtractRunners();
        winner = _determineWinner(sim);
        break;
      }
    }

    if (ticks !== lastSnapshotAt) {
      BatchLogger.push(null, `  t${ticks}: ${_formatSnapshot(_snapshot(sim))}`);
    }

    const remainingTicks = Math.max(0, maxTicks - ticks);

    if (terminated) {
      BatchLogger.push(null, `  --- USER TERMINATED at tick ${ticks} of ${maxTicks} (${remainingTicks} ticks remaining) ---`);
      BatchLogger.push(null, `  result: TERMINATED (no winner)`);
    } else {
      const seconds = (ticks / CombatConfig.tickRateHz).toFixed(1);
      BatchLogger.push(null, `  elapsed: ${ticks} ticks (${seconds}s)`);
      BatchLogger.push(null, `  result: ${winner ? winner.toUpperCase() + ' WIN' : 'TIMEOUT (no winner)'}`);
      BatchLogger.push(null, `  health: ${_formatHealth(stats)}`);
    }
    BatchLogger.push(null, '');

    return {
      ticks,
      maxTicks,
      remainingTicks,
      winner,
      stats,
      terminated,
      startSnapshot: _snapshot(sim),
      endSnapshot: _snapshot(sim)
    };
  } finally {
    AIDebugLog.enabled = prevLogEnabled;
    // Emit the whole run's output as one console.log. History is untouched
    // (BatchLogger.flush only clears the pending buffer), so the on-page
    // log panel still has everything if it wants to re-read.
    BatchLogger.flush();
  }
}

// --- Event tallies --------------------------------------------------------

function _emptyStats() {
  return {
    melee: { attack: 0, hit: 0, miss: 0, block: 0, shieldBreak: 0, stagger: 0, knockdown: 0, death: 0, brace: 0, braceCounter: 0 },
    ranged: { fire: 0, hit: 0, block: 0, shieldBreak: 0, death: 0, arrowLanded: 0 },
    // Morale sampling. routerTicks is the sum across the whole run of
    // "how many soldiers were in routing state right now" -- a single
    // soldier routing for 30 ticks contributes 30. peakRouters is the
    // maximum simultaneous count ever observed. peakRouters === 0 means
    // routing never fired at all in this run.
    morale: { routerTicks: 0, peakRouters: 0, minMorale: Infinity }
  };
}

function _countMeleeEvent(e, stats) {
  const m = stats.melee;
  switch (e.type) {
    case 'attack': m.attack++; break;
    case 'hit': m.hit++; break;
    case 'miss': m.miss++; break;
    case 'block': m.block++; break;
    case 'shieldBreak': m.shieldBreak++; break;
    case 'stagger': m.stagger++; break;
    case 'knockdown': m.knockdown++; break;
    case 'death': m.death++; break;
    case 'brace': m.brace++; break;
    case 'braceCounter': m.braceCounter++; break;
    default: break;
  }
}

function _countRangedEvent(e, stats) {
  const r = stats.ranged;
  switch (e.type) {
    case 'fire': r.fire++; break;
    case 'hit': r.hit++; break;
    case 'block': r.block++; break;
    case 'shieldBreak': r.shieldBreak++; break;
    case 'death': r.death++; break;
    case 'arrowLanded': r.arrowLanded++; break;
    default: break;
  }
}

// Compact one-line health summary. Reads left-to-right:
//   melee:  attacks, hits / misses, blocks, shield breaks, staggers,
//           knockdowns, deaths, braces, brace counters
//   ranged: fires, hits, blocks, shield breaks, deaths
// A sudden drop in any count relative to a prior run of the same scenario
// is the signal that something upstream broke.
function _formatHealth(stats) {
  const m = stats.melee;
  const r = stats.ranged;
  const mo = stats.morale;
  const minM = mo.minMorale === Infinity ? 'n/a' : mo.minMorale.toFixed(1);
  return `melee[atk=${m.attack} hit=${m.hit} miss=${m.miss} blk=${m.block} shBrk=${m.shieldBreak} stgr=${m.stagger} kd=${m.knockdown} death=${m.death} brc=${m.brace}/${m.braceCounter}] ` +
         `ranged[fire=${r.fire} hit=${r.hit} blk=${r.block} shBrk=${r.shieldBreak} death=${r.death} landed=${r.arrowLanded}] ` +
         `morale[routTicks=${mo.routerTicks} peak=${mo.peakRouters} min=${minM}]`;
}

// --- Snapshots ------------------------------------------------------------

// Per-unit alive counts. Kept small -- this is a quick health read, not a
// full sim dump. Structure: { [unitId]: { team, alive, total, hpFrac } }.
function _snapshot(sim) {
  const out = {};
  for (const u of sim.units) {
    const alive = u.getAliveSoldiers();
    let hpSum = 0;
    for (const s of alive) hpSum += s.hp / s.maxHp;
    out[u.id] = {
      team: u.teamId,
      alive: alive.length,
      total: u.soldiers.length,
      hpFrac: alive.length > 0 ? hpSum / alive.length : 0
    };
  }
  return out;
}

// Compact display: "blue-spear-1=15/15 red-cav-1=12/15"
function _formatSnapshot(snap) {
  const parts = [];
  for (const [id, info] of Object.entries(snap)) {
    parts.push(`${id}=${info.alive}/${info.total}`);
  }
  return parts.join(' ');
}

// "blue: spearman x2, archer x1 | red: cavalry x1"
function _describeSetup(units) {
  const byTeam = {};
  for (const u of units) {
    if (!byTeam[u.teamId]) byTeam[u.teamId] = {};
    const type = u.soldiers[0]?.unitTypeDef.id || '?';
    byTeam[u.teamId][type] = (byTeam[u.teamId][type] || 0) + 1;
  }
  return Object.entries(byTeam).map(([team, types]) => {
    const parts = Object.entries(types).map(([type, count]) => `${type} x${count}`);
    return `${team}: ${parts.join(', ')}`;
  }).join(' | ');
}

// Returns the surviving team id, or null if a draw (both wiped same tick)
// or a timeout that isBattleOver didn't catch.
function _determineWinner(sim) {
  const teamIds = new Set(sim.units.map(u => u.teamId));
  const survivors = [];
  for (const teamId of teamIds) {
    const hasSurvivor = sim.units.some(
      u => u.teamId === teamId && !u.isDefeated()
    );
    if (hasSurvivor) survivors.push(teamId);
  }
  if (survivors.length === 1) return survivors[0];
  return null;
}
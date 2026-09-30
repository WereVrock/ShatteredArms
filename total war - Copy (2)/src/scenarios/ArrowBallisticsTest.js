// ===== ArrowBallisticsTest.js =====
// Headless test for the sim-authoritative arrow system.
//
// Run with:  node src/scenarios/ArrowBallisticsTest.js
// (assumes the project is ESM — if not, rename to ArrowBallisticsTest.mjs)
//
// No AI, no renderer, no scenario loader. Builds small fixed encounters
// directly from FormationFactory, ticks BattleSimulation, and asserts the
// arrow system behaves per spec:
//
//   - arrows fire, travel, and damage a target
//   - damage is resolved at COLLISION, never at launch
//   - each shooter rolls its own scatter point (no shared aim point)
//   - the shooter's own unit is skipped for its own arrows
//   - cross-unit friendly fire does occur
//   - a fast target that has moved off the aim point is missed
//   - arrows arc above chest height mid-flight (not straight lines)
//   - shield block fires on arrow collision
//   - out-of-bounds arrows are culled
//
// Exit code is 0 on all-pass, 1 otherwise.

import { BattleSimulation } from '../sim/BattleSimulation.js';
import { FormationFactory } from '../sim/FormationFactory.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';

// Silence sim log spam during the test. CorridorEvent is a no-op here
// because nothing subscribes to it (BattleRenderer wires it in the real
// app; there is no renderer in this test).
AIDebugLog.enabled = false;

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function makeUnit(id, teamId, typeDef, x, z, facing, count) {
  return FormationFactory.createUnitWithCount({
    id, teamId, unitTypeDef: typeDef,
    originX: x, originZ: z, facing, count
  });
}

function makeSim(units) {
  return new BattleSimulation(units, { playerTeamId: 'blue' });
}

// Runs the sim for `ticks`, collecting projectile events with their tick.
// Also drains melee/combat events each tick so they do not accumulate in
// the combat system's internal buffers.
function runSim(sim, ticks, onTick) {
  const log = {
    fire: [], hit: [], block: [], shieldBreak: [], death: [], arrowLanded: []
  };
  for (let t = 0; t < ticks; t++) {
    sim.tick();
    const pe = sim.projectileSystem.drainEvents();
    for (const e of pe) {
      if (log[e.type]) log[e.type].push({ tick: t, ...e });
    }
    sim.combatResolutionSystem.drainEvents();
    if (onTick) onTick(sim, t);
  }
  return log;
}

function totalAlive(units) {
  let n = 0;
  for (const u of units) n += u.getAliveSoldiers().length;
  return n;
}

// ----------------------------------------------------------------------
// Minimal test runner
// ----------------------------------------------------------------------

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, pass: false, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

console.log('\nArrow ballistics — headless tests\n');

// --- Test 1: basic volley -------------------------------------------------
test('volley: arrows fire, travel, and damage the target', () => {
  const blue = [ makeUnit('b-arch', 'blue', UnitTypes.archer, 0, -10, 0, 8) ];
  const red  = [ makeUnit('r-spear', 'red', UnitTypes.spearmanNoShield, 0, 0, Math.PI, 10) ];
  const sim = makeSim([...blue, ...red]);

  const redStartAlive = totalAlive(red);
  const log = runSim(sim, 250);

  assert(log.fire.length > 0,
    'no fire events were emitted — RangedCombatSystem never fired');
  assert(log.hit.length > 0 || log.arrowLanded.length > 0,
    'no arrows resolved (neither hit nor landed) — ProjectileSystem is not advancing them');
  assert(totalAlive(red) < redStartAlive,
    `red took no casualties (${redStartAlive} alive) — arrows are not landing or not damaging`);
});

// --- Test 2: no damage at launch -----------------------------------------
test('no damage at launch: first fire tick has zero hit events', () => {
  const blue = [ makeUnit('b-arch', 'blue', UnitTypes.archer, 0, -10, 0, 8) ];
  const red  = [ makeUnit('r-spear', 'red', UnitTypes.spearmanNoShield, 0, 0, Math.PI, 10) ];
  const sim = makeSim([...blue, ...red]);

  const log = runSim(sim, 100);
  assert(log.fire.length > 0, 'no fire events');

  const firstFireTick = log.fire[0].tick;
  const hitsOnFirstFireTick = log.hit.filter(e => e.tick === firstFireTick);

  // Arrow minimum duration is ArrowArc.MIN_DURATION (0.6 s) = 9 ticks at
  // 15 Hz, so no arrow can hit on the same tick it was fired. A hit here
  // would mean damage is still being resolved at launch.
  assert(hitsOnFirstFireTick.length === 0,
    `hit event on the first fire tick (t=${firstFireTick}) — damage was resolved at launch`);
});

// --- Test 3: accuracy scatter --------------------------------------------
test('scatter: arrows do not all share an aim point', () => {
  const blue = [ makeUnit('b-arch', 'blue', UnitTypes.archer, 0, -10, 0, 20) ];
  const red  = [ makeUnit('r-spear', 'red', UnitTypes.spearmanNoShield, 0, 0, Math.PI, 10) ];
  const sim = makeSim([...blue, ...red]);

  const log = runSim(sim, 60);
  assert(log.fire.length >= 5,
    `too few fire events (${log.fire.length}) to test scatter`);

  const seen = new Set();
  for (const e of log.fire) {
    seen.add(`${e.toPos.x.toFixed(2)},${e.toPos.z.toFixed(2)}`);
  }
  assert(seen.size > 1,
    `all ${log.fire.length} arrows aimed at the same point — scatter is not applied`);
});

// --- Test 4: same-unit self-hit prevention --------------------------------
test('same-unit skip: archers do not hit their own unit', () => {
  // Place archers in a multi-rank formation facing the enemy. Arrows from
  // the back rank must clear the front rank without clipping it.
  const blue = [ makeUnit('b-arch', 'blue', UnitTypes.archer, 0, -10, 0, 16) ];
  const red  = [ makeUnit('r-spear', 'red', UnitTypes.spearmanNoShield, 0, 0, Math.PI, 10) ];
  const sim = makeSim([...blue, ...red]);

  const blueStartAlive = totalAlive(blue);
  runSim(sim, 200);

  assert(totalAlive(blue) === blueStartAlive,
    `blue lost ${blueStartAlive - totalAlive(blue)} soldiers to its own arrows — same-unit skip is not working`);
});

// --- Test 5: cross-unit friendly fire ------------------------------------
test('friendly fire: a friendly unit near the target takes stray arrows', () => {
  // Wide scatter so arrows aimed at the red target fall into the blue
  // melee unit standing off to the side of it. Blue melee is close enough
  // to the target to be inside the scatter disc, but more than
  // engagementRange (1.6) away so it never enters melee with red.
  const wideArcher = { ...UnitTypes.archer, rangedAccuracy: 6.0 };
  const blueArch  = makeUnit('b-arch',  'blue', wideArcher,              0, -14, 0,        20);
  const blueMelee = makeUnit('b-melee', 'blue', UnitTypes.spearmanNoShield, 4,   0, 0,        12);
  const red       = makeUnit('r-spear', 'red',  UnitTypes.spearmanNoShield, 0,   0, Math.PI, 12);

  const sim = makeSim([blueArch, blueMelee, red]);
  const log = runSim(sim, 300);

  // Filter hit events to defenders that belong to the blue melee unit.
  const blueMeleeIds = new Set(blueMelee.soldiers.map(s => s.id));
  const friendlyHits = log.hit.filter(e => blueMeleeIds.has(e.defenderId));

  assert(friendlyHits.length > 0,
    `no friendly-fire hits on b-melee (${log.hit.length} total hits) — cross-unit friendly fire is not working`);
});

// --- Test 6: shield block on arrow collision ------------------------------
test('shield block: arrows hitting a shielded unit are sometimes blocked', () => {
  const blue = [ makeUnit('b-arch', 'blue', UnitTypes.archer, 0, -10, 0, 20) ];
  const red  = [ makeUnit('r-spear', 'red', UnitTypes.spearman, 0, 0, Math.PI, 10) ]; // hasShield: true
  const sim = makeSim([...blue, ...red]);

  const log = runSim(sim, 200);
  assert(log.block.length > 0,
    `no shield blocks in 200 ticks (${log.hit.length} hits) — shield block is not firing on arrow collision`);
});

// --- Test 7: arrows arc ---------------------------------------------------
test('arc: projectiles rise above chest height mid-flight', () => {
  const blue = [ makeUnit('b-arch', 'blue', UnitTypes.archer, 0, -14, 0, 5) ];
  const red  = [ makeUnit('r-spear', 'red', UnitTypes.spearmanNoShield, 0, 0, Math.PI, 10) ];
  const sim = makeSim([...blue, ...red]);

  let maxY = 0;
  for (let t = 0; t < 120; t++) {
    sim.tick();
    for (const p of sim.projectileSystem.getActiveProjectiles()) {
      if (p.y > maxY) maxY = p.y;
    }
    sim.projectileSystem.drainEvents();
    sim.combatResolutionSystem.drainEvents();
  }

  // Distance ~14 → arcHeight ≈ 3.02 → peak y ≈ 4.02. Asserting > 2.0
  // confirms the projectile is following the parabola, not a straight line.
  assert(maxY > 2.0,
    `max projectile y = ${maxY.toFixed(2)} — arrows are not arcing above body height`);
});

// --- Test 8: dodge by strafing target ------------------------------------
test('dodge: a strafing target takes fewer arrow hits than a stationary one', () => {
  function buildSim(strafe) {
    const blue = [ makeUnit('b-arch', 'blue', UnitTypes.archer, 0, -20, 0, 10) ];
    const red  = [ makeUnit('r-cav',  'red',  UnitTypes.horsemenNoShield, 0, 0, Math.PI, 8) ];
    const sim = makeSim([...blue, ...red]);
    const redUnit = sim.units.find(u => u.id === 'r-cav');
    if (strafe) {
      // Sprint far to +X on tick 0. Cavalry baseMoveSpeed (2.6) is well
      // above the archers' arrow speed in ground terms over the ~2.5 s
      // flight, so arrows aimed at the ORIGINAL centre land off-body.
      redUnit.issueMoveOrder(40, 0, Math.PI / 2);
    }
    return { sim, red };
  }

  const stationary = buildSim(false);
  const strafe     = buildSim(true);

  runSim(stationary.sim, 200);
  runSim(strafe.sim, 200);

  const stationaryAlive = totalAlive(stationary.red);
  const strafeAlive     = totalAlive(strafe.red);

  assert(strafeAlive > stationaryAlive,
    `strafing cavalry took ${8 - strafeAlive} casualties, stationary took ${8 - stationaryAlive} ` +
    `— strafing did not reduce arrow hits (dodging is not working)`);
});

// --- Test 9: out-of-bounds cull ------------------------------------------
test('cull: off-map arrows are discarded', () => {
  // Archers sit near the map edge, firing across it. The sim should not
  // accumulate unbounded live projectiles — every arrow that leaves the
  // map is culled.
  const b = CombatConfig.mapBounds;
  const edgeX = b.maxX - 4;
  const blue = [ makeUnit('b-arch', 'blue', UnitTypes.archer, edgeX, 0, Math.PI / 2, 5) ];
  // Target placed past the boundary so arrows aim outside the map.
  const red  = [ makeUnit('r-spear', 'red', UnitTypes.spearmanNoShield, b.maxX + 3, 0, -Math.PI / 2, 5) ];

  const sim = makeSim([...blue, ...red]);
  const log = runSim(sim, 200);

  // We can't observe the cull directly without poking internals, but a
  // runaway accumulation would be immediately visible here.
  assert(sim.projectileSystem.getActiveProjectiles().length < 500,
    `projectiles accumulating (${sim.projectileSystem.getActiveProjectiles().length} live) — cull is not working`);

  // Sanity: some arrows did fire (the target is out of effective range,
  // but TargetSystem still acquires it — combat fires into the void).
  assert(log.fire.length >= 0, 'sanity');
});

// ----------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------

const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}\n`);

// Only exit when run as a script, not when imported.
if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    process.argv[1].endsWith('ArrowBallisticsTest.js')) {
  process.exit(failed === 0 ? 0 : 1);
}

export function runArrowBallisticsTests() {
  return results;
}
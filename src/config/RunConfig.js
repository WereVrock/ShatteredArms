// Running (second gait). Data only.
//
// Every soldier WALKS at the same speed: the shielded spearman's effective
// speed (1.2 * 0.95 * 0.8 = 0.912 design units/s). RUNNING is each type's
// existing effective speed times a class multiplier, so type differences
// show up when running, not when walking.
//
// Speeds here are DESIGN space (see SpeedScale.js).
export const RunConfig = {
  // Initial runEnabled for every unit. The AI overrides it each decision
  // cycle for its own units; for the player it is the starting button state.
  defaultEnabled: false,

  // Design-space walk speed for every type. null = derive from the shielded
  // spearman (UnitTypes.spearman, CombatConfig.shield, CombatConfig.spearHandling).
  walkSpeed: null,

  // Run speed = existing effective speed * this. Infantry get a real bonus.
  // Mounted types are 1.0: their existing speed already is the gallop, so
  // walking is the slow gait for them. A type may override with runSpeedMult.
  //
  // Bumped from 1.5 to 2.0: at 1.5 the run bonus was visually imperceptible
  // on rough ground (a slope speed factor of 0.6 wiped out the whole gain),
  // which read as "the run button does nothing". 2.0 survives most terrain
  // penalties with a visible speed edge, and pairs with the new run-specific
  // leg amplitude in SoldierModelComposer so the animation cycle also reads
  // as running rather than as walking faster.
  infantryRunMult: 2.0,
  mountedRunMult: 1.0,

  // Multiplier on the per-tick walking fatigue drain while running
  // (on top of the race fatigueDrainMultiplier and terrain / climb factors).
  // The walk drain itself is halved in MovementSystem._drainWalkFatigue,
  // so the effective walk:run ratio is 1:3 infantry (was 1:5) and 1:2
  // mounted. A longer run duration is intentional — 5x was short enough
  // that a unit spent most of the march exhausted and visually frozen.
  drainMultInfantry: 3.0,
  drainMultMounted: 2.0,

  // Unit-wide stamina gate, on the unit's AVERAGE fatigue (0..100).
  // At or below stopFatigue the unit stops running and cannot run again
  // until it recovers to resumeFatigue.
  stopFatigue: 12,
  resumeFatigue: 35,

  // A unit with at least this fraction of living soldiers in melee stops running.
  maxEngagedFraction: 0.25,

  // DEPRECATED — no longer read. RunSystem now keeps every walking soldier
  // of a running unit at running speed all the way to its target; the old
  // approach-slowdown gate was removed so "run" means run, not run-then-walk.
  // Kept as a data field so a future approach-slowdown tuning can reuse the
  // name; nothing reads it today.
  directMarchStopDist: 6,

  // Ticks after running ends during which spears must stay raised before the
  // normal lower check may run (30 ticks = 2 s at 15 Hz). Read via
  // Gait.spearsHeldUp / soldier.gaitHoldTicks by the spear handling code.
  spearLowerDelayTicks: 30,

  // Skeleton-bodied MOUNTED units may still run (mirrors the existing
  // skeletal-horse exemption in CombatConfig.skeleton). Foot skeletons never run.
  undeadMountedCanRun: true
};
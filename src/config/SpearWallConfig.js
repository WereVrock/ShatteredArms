// Terrain-driven spear wall disruption, spear raising, front-rank bracing and
// second-rank support strikes. Data only.
//
// Historical basis (commonly cited accounts, summarised):
//   - Polybius 18.28-32 (phalanx vs legion): the phalanx is only
//     effective on level, unobstructed ground. Ditches, clefts, stumps,
//     watercourses and any other obstacle break its continuous front, and
//     the more flexible enemy then exploits the gaps.
//   - Pydna, 168 BC (Plutarch, Aemilius Paullus): the advancing Macedonian
//     line broke up on uneven ground; gaps opened and the legionaries
//     entered them.
//   - Flodden, 1513: Scottish pike blocks came down a slope onto sodden
//     ground and lost their alignment before contact.
//
// Model: every spearman has an INTEGRITY 0..1 (1 = intact wall) built from
// the ground type, slope steepness and obstacles within spear reach, then
// blended with the unit average (a wall is a collective property). It
// drops fast and recovers slowly: breaking a line takes a moment,
// re-dressing the ranks takes much longer.

import { TerrainType, ObstacleKind } from './TerrainConfig.js';

export const SpearWallConfig = {
  // A spearman re-measures his own ground every Nth tick (staggered by id).
  recheckTicks: 3,

  // Share of a soldier's integrity that comes from his own ground. The
  // rest comes from the average of his unit's spearmen.
  ownWeight: 0.6,

  // World units. Obstacles whose surface is closer than this to the
  // soldier disrupt his shaft and his place in the line.
  obstacleReach: 1.6,
  // Penalty at zero distance, falling off linearly to 0 at obstacleReach.
  obstaclePenalty: {
    [ObstacleKind.TREE]: 0.22,
    [ObstacleKind.ROCK]: 0.35,
    [ObstacleKind.WALL]: 0.50
  },
  // Total obstacle penalty never exceeds this.
  obstacleCap: 0.8,

  // Integrity LOST standing on each ground type. Missing = 0 (grass, road).
  groundDisruption: {
    [TerrainType.SAND]: 0.15,
    [TerrainType.MUD]: 0.60,
    [TerrainType.SHALLOW_WATER]: 0.70,
    [TerrainType.FOREST_FLOOR]: 0.35,
    [TerrainType.ROCKY]: 0.40,
    [TerrainType.DEEP_WATER]: 1.00
  },

  // Terrain gradient (rise/run, any direction). Below start: no effect.
  // At full: integrity is multiplied by (1 - weight).
  slope: { start: 0.10, full: 0.35, weight: 0.70 },

  // Seconds to fall from 1 to 0 / climb from 0 to 1.
  breakSeconds: 0.5,
  recoverSeconds: 6.0,

  // Hysteresis for the boolean "wall broken" flag read by combat.
  brokenBelow: 0.45,
  restoredAbove: 0.62,

  // Combat strength curve (see SpearWall.strength). Integrity at or above
  // fullStrengthAt gives the wall its full combat effect; at brokenBelow
  // it gives none. Slightly disrupted ground therefore costs little.
  fullStrengthAt: 0.85,
  // Minimum strength for the AI to count a spearman as able to brace.
  braceMinStrength: 0.5,

  // Move speed multiplier at integrity 0 (linear up to 1.0 at integrity 1).
  // The march anchor follows the slowest soldier, so the whole block
  // advances at the pace of its worst-off file.
  moveSpeedMultAtZero: 0.8,

  // Formation slot buckling: below startIntegrity each soldier's slot is
  // pushed off the grid in a fixed per-soldier direction, up to maxUnits
  // lateral (depthScale of that on the depth axis) at integrity 0.
  disorder: { startIntegrity: 0.9, maxUnits: 0.42, depthScale: 0.6 },

  // A spearman keeps his spear UP while his OWN footing is bad: his own
  // integrity gives a strength (same curve as above) below this value.
  // (Friendly soldiers touching the shaft also force it up, see
  // FacingSystem.) A raised spear cannot fight.
  raiseBelowStrength: 0.5,
  // spearRaiseAmount at or above this counts as "raised".
  raisedAmount: 0.5,

  // Damage multiplier for a raised spearman's attacks. He still fights —
  // jabbing, swinging the shaft as a staff, hitting with the butt — but
  // not as part of the wall. Wall bonuses (brace, second-rank support,
  // frontal anti-sword) all require the spear to be DOWN and already
  // fail elsewhere; this multiplier is only the penalty on his own
  // damage. 0.65: about two-thirds effectiveness, reflecting a 3 m pole
  // swung rather than planted. Tune between 0.55 and 0.75 after playtest.
  raisedDamageMult: 0.65,

  // Stationary-plant override. A FRONTLINE spearman (rank <=
  // stationaryPlantMaxRank) who has stood still for stationaryPlantTicks
  // consecutive sim ticks OUT OF COMBAT has found footing to plant his
  // shaft even on otherwise bad terrain (mud, slope, forest floor). The
  // terrain-based raise is overridden. A friendly touching the shaft
  // still forces the spear up regardless — you cannot plant into a
  // man's back.
  //
  // MELEE (engaged, staggered) is NOT stationary. The counter resets
  // every tick the soldier is in combat, so a man fighting in a bog
  // never "finds footing" without first breaking off and standing
  // still. This is deliberate: a soldier actively swinging is not
  // planting, and the terrain penalty should not vanish mid-fight.
  //
  // 30 ticks = 2 s at 15 Hz.
  stationaryPlantTicks: 30,
  // Only rank 0 (frontline) can benefit. Back ranks stay as their terrain
  // dictates — they are depth, not contact, and the wall is the front.
  stationaryPlantMaxRank: 0,

  // Local wall topology. A soldier is "in a wall" (earning the frontal
  // anti-sword penalty for his attacker) only when ALL of:
  //   - his own spear is unraised;
  //   - a LEFT neighbour exists and is unraised;
  //   - a RIGHT neighbour exists and is unraised;
  //   - a BEHIND neighbour exists and is unraised.
  //
  // "Exists" means: same unit, alive, spear weapon type, within `radius`
  // world units, outside the front cone (which points at the enemy).
  // Missing ANY of the three, or any of the three raised -> no wall.
  //
  // This is deliberately strict. A soldier at the END of a line has no
  // lateral neighbour on the outside, so he is NOT in a wall. A soldier
  // with no man directly behind him is NOT in a wall. The wall is a
  // block: 2 ranks deep, at least 3 files wide at the point where a
  // given soldier stands. Anything less is not a wall.
  //
  // `frontArcRad` is the half-width of the front cone excluded from
  // neighbour consideration: dotF > cos(frontArcRad). Behind is
  // dotF < -cos(frontArcRad); the rest is lateral.
  // radius = 2.5 rather than 2.0 so that two adjacent soldiers who buckle
  // in opposite directions (up to 0.42 each from disorderOffset) do not
  // push each other past the neighbour-detection radius. Worst-case
  // distance is spacing + 0.84; at spacing 1.2 that's 2.04, comfortably
  // inside 2.5. At spacing 1.6 it's 2.44, still inside. Raise to 3.0 if
  // your spearmen use wider-than-usual formation spacing.
  localWall: { radius: 2.5, frontArcRad: Math.PI / 4 },

  // Charge brace: only the first `ranks` ranks within `neighbourhood` world
  // units of the struck soldier count. The share of their spears that are
  // unraised must reach minUnraisedFraction; counter damage scales with it.
  brace: { ranks: 2, neighbourhood: 3.0, minUnraisedFraction: 0.5 },

  // Second-rank support: when an enemy attacks a soldier, each eligible
  // spearman of rank `rank` rolls `chance` to strike back at the attacker
  // (the roll spends his attack cooldown). Eligible = unraised spear, off
  // cooldown, the attacked friend within reachToFriendly (just the one or
  // two men in front), the attacker within reachToEnemy and within arcDeg
  // of his facing.
  supportStrike: { rank: 1, chance: 0.3, reachToFriendly: 0.9, reachToEnemy: 2.5, arcDeg: 60 }
};
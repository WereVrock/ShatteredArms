// ===== PlayableScenarios.js =====
import { FormationFactory } from '../sim/FormationFactory.js';
import { UnitTypes } from '../config/UnitTypes.js';

// Playable scenarios for the main game. Same build() -> Unit[] shape as the
// headless scenarios (src/headless/scenarios.js), with two additions the
// main game needs and the headless runner does not:
//
//   playerTeamId — which team the human controls.
//   aiTeamIds    — teams handed to BattleAI; everything not in either list
//                  is left uncontrolled.
//
// Camera hints are optional; main.js falls back to a sane default when a
// scenario omits them.
//
// Scenarios are pure data + a build function. Adding a new one is a new
// entry here plus a new file entry in main.js's import — no game-code
// changes anywhere else.

// Facing convention (matches main.js and headless/scenarios.js): atan2(dx, dz).
//   0        → +Z (south)
//    Math.PI  → -Z (north)
const FACE_SOUTH = 0;
const FACE_NORTH = Math.PI;

function unit(id, teamId, typeKey, x, z, facing, opts = {}) {
  return FormationFactory.createGridUnit({
    id,
    teamId,
    unitTypeDef: UnitTypes[typeKey],
    originX: x,
    originZ: z,
    facing,
    rows: opts.rows ?? 3,
    cols: opts.cols ?? 5,
    spacing: opts.spacing ?? 0.7,
    isUndead: !!opts.isUndead
  });
}

// Convenience: standard archer footprint (2 rows of 6) so every scenario
// that fields archers uses the same shape and unit-creation config.
function archer(id, teamId, x, z, facing, opts = {}) {
  return unit(id, teamId, 'archer', x, z, facing, {
    rows: 2, cols: 6, spacing: 0.7, ...opts
  });
}

// Convenience: standard cavalry footprint (wider spacing for mounts).
function cavalry(id, teamId, typeKey, x, z, facing, opts = {}) {
  return unit(id, teamId, typeKey, x, z, facing, { spacing: 0.8, ...opts });
}

// --- Mixed Battle ----------------------------------------------------------
// The original main.js default roster, ported unchanged. Six-unit front line,
// two archer units in the back, two cavalry on the wings, mirrored per team.

function buildMixedBattle() {
  const units = [];
  const BLUE_BASE_Z = -16;
  const RED_BASE_Z = 16;

  // Left-to-right front-line composition, matching the pre-menu main.js.
  const FRONT_LINE_DEFS = [
    { key: 'spear-1',         type: 'spearman',          isUndead: true  },
    { key: 'spearNoShield-1', type: 'spearmanNoShield',  isUndead: false },
    { key: 'sword-1',         type: 'swordsman',         isUndead: false },
    { key: 'swordNoShield-1', type: 'swordsmanNoShield', isUndead: false },
    { key: 'spear-2',         type: 'spearman',          isUndead: false },
    { key: 'spear-3',         type: 'spearman',          isUndead: false }
  ];
  const FRONT_LINE_X = [-9, -5.4, -1.8, 1.8, 5.4, 9];

  const ARCHER_DEFS = [
    { key: 'archer-1', isUndead: true,  x: -3.5 },
    { key: 'archer-2', isUndead: false, x:  3.5 }
  ];
  const CAVALRY_DEFS = [
    { key: 'cavalry-1',         type: 'horsemen',         x: -4 },
    { key: 'cavalryNoShield-1', type: 'horsemenNoShield', x:  4 }
  ];

  function buildSide(teamId, baseZ, facing) {
    const dir = facing === 0 ? 1 : -1;
    const ARCHER_DEPTH = 3;
    const CAVALRY_DEPTH = 3;

    for (let i = 0; i < FRONT_LINE_DEFS.length; i++) {
      const def = FRONT_LINE_DEFS[i];
      units.push(unit(
        `${teamId}-${def.key}`, teamId, def.type,
        FRONT_LINE_X[i], baseZ, facing,
        { rows: 3, cols: 5, spacing: 0.7, isUndead: def.isUndead }
      ));
    }

    for (const def of ARCHER_DEFS) {
      // 2 rows x 6 cols = 12, matching UnitTypes.archer.preferredRows so
      // playable and campaign-built archers have the same footprint.
      units.push(archer(
        `${teamId}-${def.key}`, teamId,
        def.x, baseZ + dir * ARCHER_DEPTH, facing,
        { isUndead: def.isUndead }
      ));
    }

    for (const def of CAVALRY_DEFS) {
      units.push(cavalry(
        `${teamId}-${def.key}`, teamId, def.type,
        def.x, baseZ - dir * CAVALRY_DEPTH, facing
      ));
    }
  }

  buildSide('blue', BLUE_BASE_Z, FACE_SOUTH);
  buildSide('red', RED_BASE_Z, FACE_NORTH);
  return units;
}

// --- Sword Vs Spear --------------------------------------------------------
// Three-unit line per side: blue has a shielded sword, a shielded spear, and
// an unshielded sword; red has a shielded skeleton spear, a mid skeleton
// spear, and an unshielded skeleton spear. Both spear additions use the same
// 'spearman' unit type — the only difference is isUndead, set at the unit
// level — so the living spear on the player's own side can be compared
// directly against its undead counterpart.

function buildSwordVsSpear() {
  return [
    unit('blue-sword-1',           'blue', 'swordsman',          -3.5, -10, FACE_SOUTH),
    unit('blue-spear-1',           'blue', 'spearman',             0,  -10, FACE_SOUTH),
    unit('blue-sword-noshield-1',  'blue', 'swordsmanNoShield',   3.5, -10, FACE_SOUTH),

    unit('red-skeleton-shield-1',   'red', 'spearman',           -3.5,  10, FACE_NORTH, { isUndead: true }),
    unit('red-skeleton-spear-mid-1','red', 'spearman',             0,  10, FACE_NORTH, { isUndead: true }),
    unit('red-skeleton-noshield-1', 'red', 'spearmanNoShield',     3.5, 10, FACE_NORTH, { isUndead: true })
  ];
}

// --- Skeleton Tide ---------------------------------------------------------
// A small living force against a much larger skeleton horde. Skeletons do
// not rout and are weak to swords on the flank (SkeletonDamageModifiers +
// flanking sword instant-kill). The player must pick engagements and use
// the swords to break through, since the skeletons will never break on
// their own.

function buildSkeletonTide() {
  return [
    // Blue — small living core with a goblin shieldless swordsman on the
    // left flank. Outnumbered heavily; the goblin is cheap, fast, and
    // expendable, and carries the goblin flank bonus (dirty fighting) that
    // the human swordsmen do not.
    unit('blue-sword-1', 'blue', 'swordsman',  -4, -10, FACE_SOUTH),
    unit('blue-sword-2', 'blue', 'swordsman',   4, -10, FACE_SOUTH),
    unit('blue-spear-1', 'blue', 'spearman',    0, -10, FACE_SOUTH),
    unit('blue-goblin-sword-ns-1', 'blue', 'goblinSwordsmanNoShield', -8, -10, FACE_SOUTH),
    archer('blue-archer-1', 'blue', 0, -14, FACE_SOUTH),

    // Red — skeleton horde: two ranks of spears, plus a screen.
    unit('red-skel-1', 'red', 'spearman',         -9.0,  8, FACE_NORTH, { isUndead: true }),
    unit('red-skel-2', 'red', 'spearman',         -4.5,  8, FACE_NORTH, { isUndead: true }),
    unit('red-skel-3', 'red', 'spearman',          0.0,  8, FACE_NORTH, { isUndead: true }),
    unit('red-skel-4', 'red', 'spearman',          4.5,  8, FACE_NORTH, { isUndead: true }),
    unit('red-skel-5', 'red', 'spearman',          9.0,  8, FACE_NORTH, { isUndead: true }),
    unit('red-skel-ns-1', 'red', 'spearmanNoShield', -6, 12, FACE_NORTH, { isUndead: true }),
    unit('red-skel-ns-2', 'red', 'spearmanNoShield',  0, 12, FACE_NORTH, { isUndead: true }),
    unit('red-skel-ns-3', 'red', 'spearmanNoShield',  6, 12, FACE_NORTH, { isUndead: true })
  ];
}

// --- Combined Arms ---------------------------------------------------------
// The classic three-arm force on both sides: a sword-spear-sword front line,
// two archer units behind, and cavalry on both wings. The only scenario in
// the list where a player can practice the full hammer-and-anvil loop
// against a mirrored opponent — pin with the line, soften with archers,
// swing the cavalry into the flank.

function buildCombinedArms() {
  return [
    // Blue.
    unit('blue-sword-1', 'blue', 'swordsman', -6, -10, FACE_SOUTH),
    unit('blue-spear-1', 'blue', 'spearman',   0, -10, FACE_SOUTH),
    unit('blue-sword-2', 'blue', 'swordsman',  6, -10, FACE_SOUTH),
    archer('blue-arch-1', 'blue', -4, -14, FACE_SOUTH),
    archer('blue-arch-2', 'blue',  4, -14, FACE_SOUTH),
    cavalry('blue-cav-1', 'blue', 'horsemen', -13, -6, FACE_SOUTH),
    cavalry('blue-cav-2', 'blue', 'horsemen',  13, -6, FACE_SOUTH),

    // Red.
    unit('red-sword-1', 'red', 'swordsman', -6, 10, FACE_NORTH),
    unit('red-spear-1', 'red', 'spearman',   0, 10, FACE_NORTH),
    unit('red-sword-2', 'red', 'swordsman',  6, 10, FACE_NORTH),
    archer('red-arch-1', 'red', -4, 14, FACE_NORTH),
    archer('red-arch-2', 'red',  4, 14, FACE_NORTH),
    cavalry('red-cav-1', 'red', 'horsemen', -13, 6, FACE_NORTH),
    cavalry('red-cav-2', 'red', 'horsemen',  13, 6, FACE_NORTH)
  ];
}

// --- Living Muster ---------------------------------------------------------
// One of every non-skeleton unit type per side, in a single engagement.
// Twelve units per team, covering every living weapon/armour/race
// combination the game can currently field:
//
//   Human melee:    spearman, spearmanNoShield, swordsman, swordsmanNoShield
//   Goblin melee:   goblinSpearman, goblinSpearmanNoShield,
//                   goblinSwordsman, goblinSwordsmanNoShield
//   Human ranged:   archer
//   Goblin ranged:  goblinArcher
//   Human cavalry:  horsemen, horsemenNoShield
//
// Front line runs all eight melee types side by side — human on the left
// half, goblin on the right half, shielded and unshielded variants placed
// adjacent so the shield-block tradeoff reads across the line. Archers sit
// behind the line, cavalry on the wings. Skeletons are deliberately absent:
// this is the "every living body on the field at once" showcase, and the
// undead are their own scenario.

function buildLivingMuster() {
  const units = [];

  const FRONT_LINE = [
    { key: 'spear',        type: 'spearman' },
    { key: 'spear-ns',     type: 'spearmanNoShield' },
    { key: 'sword',        type: 'swordsman' },
    { key: 'sword-ns',     type: 'swordsmanNoShield' },
    { key: 'gob-spear',    type: 'goblinSpearman' },
    { key: 'gob-spear-ns', type: 'goblinSpearmanNoShield' },
    { key: 'gob-sword',    type: 'goblinSwordsman' },
    { key: 'gob-sword-ns', type: 'goblinSwordsmanNoShield' }
  ];
  // Even 4-unit step. Goblin units are roughly twice a human unit's
  // frontage (unitSizeMultiplier 2.0, applied by FormationFactory), so the
  // human half of the line gets a little air and the goblin half just
  // enough room to not overlap its neighbours.
  const FRONT_X = [-14, -10, -6, -2, 2, 6, 10, 14];

  function buildSide(teamId, baseZ, facing) {
    // +Z is toward the enemy for a south-facing team and away from the
    // enemy for a north-facing one. "Behind" flips sign accordingly.
    const behindSign = facing === FACE_SOUTH ? -1 : 1;

    for (let i = 0; i < FRONT_LINE.length; i++) {
      const def = FRONT_LINE[i];
      units.push(unit(
        `${teamId}-${def.key}`, teamId, def.type,
        FRONT_X[i], baseZ, facing
      ));
    }

    // Archers behind the line, one human and one goblin.
    units.push(archer(
      `${teamId}-archer`, teamId, -5, baseZ + behindSign * 4, facing
    ));
    units.push(unit(
      `${teamId}-gob-archer`, teamId, 'goblinArcher',
      5, baseZ + behindSign * 4, facing,
      { rows: 2, cols: 6, spacing: 0.7 }
    ));

    // Cavalry on the wings, level with the line.
    units.push(cavalry(
      `${teamId}-cav`, teamId, 'horsemen', -19, baseZ, facing
    ));
    units.push(cavalry(
      `${teamId}-cav-ns`, teamId, 'horsemenNoShield', 19, baseZ, facing
    ));
  }

  buildSide('blue', -10, FACE_SOUTH);
  buildSide('red', 10, FACE_NORTH);
  return units;
}

// --- Cavalry Raid ----------------------------------------------------------
// Pure cavalry on both sides. No infantry screen, no archers. Charges,
// knockbacks, and throws dominate the entire fight — units that are still
// standing in formation when the enemy makes contact get run over, and the
// brace mechanic has no place here because nobody is on foot to brace.
// Fast and chaotic; good for seeing the throw physics in action.

function buildCavalryRaid() {
  return [
    cavalry('blue-cav-1', 'blue', 'horsemen', -9, -8, FACE_SOUTH),
    cavalry('blue-cav-2', 'blue', 'horsemen',  0, -8, FACE_SOUTH),
    cavalry('blue-cav-3', 'blue', 'horsemen',  9, -8, FACE_SOUTH),

    cavalry('red-cav-1', 'red', 'horsemen', -9, 8, FACE_NORTH),
    cavalry('red-cav-2', 'red', 'horsemen',  0, 8, FACE_NORTH),
    cavalry('red-cav-3', 'red', 'horsemen',  9, 8, FACE_NORTH)
  ];
}

export const PlayableScenarios = [
  {
    id: 'mixed-battle',
    name: 'Mixed Battle',
    description: 'Six-unit front line, archers, and cavalry on both sides. The full-roster engagement.',
    playerTeamId: 'blue',
    aiTeamIds: ['red'],
    cameraTarget: { x: 0, z: -6 },
    cameraDistance: 38,
    cameraPitch: 0.95,
    build: buildMixedBattle
  },
  {
    id: 'sword-vs-spear',
    name: 'Sword Vs Spear',
    description: 'Three-unit line per side — swords and spears against skeleton spears, with the living spear on the player side comparable directly to its undead counterpart.',
    playerTeamId: 'blue',
    aiTeamIds: ['red'],
    cameraTarget: { x: 0, z: 0 },
    cameraDistance: 30,
    cameraPitch: 0.9,
    build: buildSwordVsSpear
  },
  {
    id: 'skeleton-tide',
    name: 'Skeleton Tide',
    description: 'A small living force against a much larger skeleton horde. Undead never rout — use swords on the flank to break the line apart.',
    playerTeamId: 'blue',
    aiTeamIds: ['red'],
    cameraTarget: { x: 0, z: 0 },
    cameraDistance: 40,
    cameraPitch: 0.95,
    build: buildSkeletonTide
  },
  {
    id: 'combined-arms',
    name: 'Combined Arms',
    description: 'Sword-spear-sword line, archers behind, cavalry on both wings — mirrored on both sides. Practice the full hammer-and-anvil loop.',
    playerTeamId: 'blue',
    aiTeamIds: ['red'],
    cameraTarget: { x: 0, z: -4 },
    cameraDistance: 44,
    cameraPitch: 0.95,
    build: buildCombinedArms
  },
  {
    id: 'living-muster',
    name: 'Living Muster',
    description: 'One of every non-skeleton unit per side — all eight melee types (shielded and unshielded, human and goblin), both archer variants, and both cavalry variants. Twelve units per side.',
    playerTeamId: 'blue',
    aiTeamIds: ['red'],
    cameraTarget: { x: 0, z: 0 },
    cameraDistance: 60,
    cameraPitch: 0.95,
    build: buildLivingMuster
  },
  {
    id: 'cavalry-raid',
    name: 'Cavalry Raid',
    description: 'All cavalry on both sides. Charges, knockbacks, and throws dominate — no infantry to brace, nothing to hold a line. Fast and chaotic.',
    playerTeamId: 'blue',
    aiTeamIds: ['red'],
    cameraTarget: { x: 0, z: 0 },
    cameraDistance: 36,
    cameraPitch: 0.95,
    build: buildCavalryRaid
  }
];
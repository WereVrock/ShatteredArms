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
//   Math.PI  → -Z (north)
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
      units.push(unit(
        `${teamId}-${def.key}`, teamId, 'archer',
        def.x, baseZ + dir * ARCHER_DEPTH, facing,
        { rows: 2, cols: 6, spacing: 0.7, isUndead: def.isUndead }
      ));
    }

    for (const def of CAVALRY_DEFS) {
      units.push(unit(
        `${teamId}-${def.key}`, teamId, def.type,
        def.x, baseZ - dir * CAVALRY_DEPTH, facing,
        { rows: 3, cols: 5, spacing: 0.8 }
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
  }
];
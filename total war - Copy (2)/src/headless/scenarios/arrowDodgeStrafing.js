// Treatment for the dodge test. Target sprints east; hit rate should drop.
import { unit, FACE_SOUTH, FACE_NORTH, FACE_EAST } from './helpers.js';

export default {
  id: 'arrow-dodge-strafing',
  name: 'Arrow dodge — strafing target',
  description:
    'DODGE TEST. Same layout as "arrow-dodge-stationary", but at tick 0 the ' +
    'red cavalry receives a scripted move order to (10, 0) — sprinting east at ' +
    '~1.3 units/sec (march anchor speed). Over a ~2.5 s arrow flight the target ' +
    'moves ~3.25 units, more than the archer scatter (1.8) + hit radius (0.5). ' +
    'Read the health line: ranged.hit and ranged.death should be MARKEDLY lower ' +
    'than the stationary control. If they are similar, arrows are resolving ' +
    'damage at launch (where the target was) rather than at collision (where ' +
    'the target is).',
  maxTicks: 500,
  aiTeams: [],
  scriptedOrders: [
    { unitId: 'red-cav-1', atTick: 0, x: 10, z: 0, facing: FACE_EAST }
  ],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -20, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('red-cav-1', 'red', 'cavalryNoShield', 0, 0, FACE_NORTH, { rows: 3, cols: 3 })
    ];
  }
};
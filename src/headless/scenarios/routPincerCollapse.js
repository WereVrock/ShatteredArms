// Morale end-to-end: a lone unit surrounded on three sides.
import { unit, FACE_SOUTH, FACE_NORTH, FACE_EAST, FACE_WEST } from './helpers.js';

export default {
  id: 'rout-pincer-collapse',
  name: 'Rout: small unit pincered by a massed line',
  description:
    'A deliberately lopsided fight whose only purpose is to exercise the morale ' +
    'system end-to-end. A single blue spear unit (15 soldiers) is surrounded on ' +
    'three sides by three full red spear units (45 soldiers) converging from front, ' +
    'left, and right. Blue is never given an order and never fights back effectively ' +
    '— it exists to take casualties and stand in a locally outnumbered, permanently ' +
    'surrounded position. What to look for: the morale[peak=N] field at the end of ' +
    'the health line. peak=0 means no soldier ever entered routing — the morale ' +
    'drains are not overcoming regen and routing is dead. peak > 0 means soldiers ' +
    'broke and fled; if they then die in melee anyway that is expected for a unit ' +
    'this outnumbered and does not indicate a bug. Compare across runs: the value ' +
    'is non-deterministic because combat rolls are random. What matters is that it ' +
    'is reliably above zero.',
  maxTicks: 1500,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', 0, 0, FACE_SOUTH),
      unit('red-spear-front', 'red', 'spearman',   0, 10, FACE_NORTH),
      unit('red-spear-left',  'red', 'spearman', -10,  0, FACE_EAST),
      unit('red-spear-right', 'red', 'spearman',  10,  0, FACE_WEST)
    ];
  }
};
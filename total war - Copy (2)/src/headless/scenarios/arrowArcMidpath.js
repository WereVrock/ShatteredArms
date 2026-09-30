// Arrows must arc over a mid-path friendly. If they fly flat, this fails.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'arrow-arc-midpath',
  name: 'Arrow: arc clears a mid-path friendly',
  description:
    'ARC. 20 blue archers at (0,-20) fire at a red spear target at (0,0). A ' +
    'blue melee unit sits directly on the flight path at (0,-10), the arc\'s ' +
    'apex. Arrows are at y≈5 there, well above body band [0.1, 1.7]. Read the ' +
    'end snapshot: blue-melee-1 should be at full strength. If it took ' +
    'casualties, arrows are flying flat (no arc) and passing through body ' +
    'height mid-flight.',
  maxTicks: 500,
  aiTeams: [],
  build() {
    return [
      unit('blue-archer-1', 'blue', 'archer', 0, -20, FACE_SOUTH, { rows: 2, cols: 10 }),
      unit('blue-melee-1', 'blue', 'spearmanNoShield', 0, -10, FACE_SOUTH, { rows: 3, cols: 4 }),
      unit('red-spear-1', 'red', 'spearmanNoShield', 0, 0, FACE_NORTH, { rows: 3, cols: 4 })
    ];
  }
};
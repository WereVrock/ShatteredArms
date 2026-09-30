// Full-roster sanity check. Every archetype per side. Run after every AI change.
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'sanity',
  name: 'SANITY: full roster',
  description: 'Every archetype per side. Spear, shieldless spear, sword, skeleton spear, archer, cavalry. Run after every AI change.',
  maxTicks: 2000,
  aiTeams: ['red'],
  build() {
    return [
      unit('blue-spear-1', 'blue', 'spearman', -6, -12, FACE_SOUTH),
      unit('blue-spear-ns-1', 'blue', 'spearmanNoShield', -2, -12, FACE_SOUTH),
      unit('blue-sword-1', 'blue', 'swordsman', 2, -12, FACE_SOUTH),
      unit('blue-skeleton-1', 'blue', 'spearman', 6, -12, FACE_SOUTH, { isUndead: true }),
      unit('blue-archer-1', 'blue', 'archer', 0, -15, FACE_SOUTH),
      unit('blue-cav-1', 'blue', 'cavalry', 0, -18, FACE_SOUTH),

      unit('red-spear-1', 'red', 'spearman', -6, 12, FACE_NORTH),
      unit('red-spear-ns-1', 'red', 'spearmanNoShield', -2, 12, FACE_NORTH),
      unit('red-sword-1', 'red', 'swordsman', 2, 12, FACE_NORTH),
      unit('red-skeleton-1', 'red', 'spearman', 6, 12, FACE_NORTH, { isUndead: true }),
      unit('red-archer-1', 'red', 'archer', 0, 15, FACE_NORTH),
      unit('red-cav-1', 'red', 'cavalry', 0, 18, FACE_NORTH)
    ];
  }
};
// Two-sided AI pincer vs undead. Skeleton spears must physically rotate to answer a flank.
import { unit, FACE_SOUTH, FACE_NORTH, FACE_WEST } from './helpers.js';

export default {
  id: 'sword-flank-vs-skeleton-spears',
  name: 'Swordsmen pincer vs skeleton spears',
  description:
    'Two-sided AI pincer test. Two skeleton spear units (undead, no rout) face NORTH ' +
    'toward a frontal swordsman unit, which pins their formationFacing south. A second ' +
    'swordsman unit approaches from the east. Because skeletons cannot rout, red must ' +
    'physically rotate to answer the flank — and spearTurnRateMult (0.7x) slows that ' +
    'rotation, while the raise/rotate/lower cycle can freeze it for an additional 10 ' +
    'ticks when a friendly lies in the swept arc. The spearwall-broken arc (60° off the ' +
    'unit formationFacing) means any attacker past 60° gets the flank damage multiplier ' +
    'regardless of which way individual soldiers are looking. Watch melee stgr and death ' +
    'counts against the shieldless-vs-shielded baseline.',
  maxTicks: 900,
  aiTeams: ['red', 'blue'],
  build() {
    return [
      unit('red-skeleton-1', 'red', 'spearman', -3, 6, FACE_NORTH, { isUndead: true }),
      unit('red-skeleton-2', 'red', 'spearman',  3, 6, FACE_NORTH, { isUndead: true }),

      unit('blue-sword-front', 'blue', 'swordsman',  0, -8, FACE_SOUTH),
      unit('blue-sword-flank', 'blue', 'swordsman', 18,  8, FACE_WEST)
    ];
  }
};
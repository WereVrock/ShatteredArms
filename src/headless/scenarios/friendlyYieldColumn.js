// Two friendly blue spear units in column. Does blue-B flow around blue-A?
import { unit, FACE_SOUTH, FACE_NORTH } from './helpers.js';

export default {
  id: 'friendly-yield-column',
  name: 'Friendly column flow-through',
  description:
    'Two friendly blue spear units in column, one behind the other, advancing on a ' +
    'single red spear unit. Both blue and red are AI-controlled. When blue-B catches ' +
    'up to blue-A (which has stopped to fight red), does blue-B step sideways to flow ' +
    'around blue-A rather than piling into its rear rank? Watch the blue-B soldier ' +
    'trajectories from around tick 100 onwards.',
  maxTicks: 900,
  aiTeams: ['red', 'blue'],
  build() {
    return [
      unit('blue-A', 'blue', 'spearman', 0, 0, FACE_SOUTH),
      unit('blue-B', 'blue', 'spearman', 0, -3, FACE_SOUTH),
      unit('red-A',  'red',  'spearman', 0, 12, FACE_NORTH)
    ];
  }
};
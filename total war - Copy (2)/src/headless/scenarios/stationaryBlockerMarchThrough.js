// No AI, no combat. Mover walks straight through an idle friendly formation.
import { unit, FACE_NORTH } from './helpers.js';

export default {
  id: 'stationary-blocker-march-through',
  name: 'Stationary blocker: march through',
  description:
    'One idle blue spear unit holds position at (0, 0). A second blue spear unit is ' +
    'issued a single scripted move order at tick 0 to march from (0, -10) to (0, 10) — ' +
    'straight through the idle unit\'s formation. No AI, no enemies, no combat. The ' +
    'only mechanic under test is whether the mover flows around the stationary ' +
    'formation or stalls against its rear rank. Working yield: mover\'s front rank ' +
    'splits left/right around the idle formation and re-forms on the north side by ' +
    'end of run. Broken yield: mover\'s front rank presses into the idle formation\'s ' +
    'rear and stalls there for the full run.',
  maxTicks: 600,
  aiTeams: [],
  scriptedOrders: [
    { unitId: 'blue-mover', atTick: 0, x: 0, z: 10, facing: FACE_NORTH }
  ],
  build() {
    return [
      unit('blue-idle',  'blue', 'spearman', 0,   0, FACE_NORTH),
      unit('blue-mover', 'blue', 'spearman', 0, -10, FACE_NORTH)
    ];
  }
};
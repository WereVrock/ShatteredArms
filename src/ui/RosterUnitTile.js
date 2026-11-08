// One unit tile in a Custom Battle team strip: icon, name, power badge and
// the size stepper, plus a remove button. Pure UI: the caller supplies the
// already-computed power and the callbacks, and this builds the DOM.
//
// Layout is a compact two-line horizontal tile so a roster wraps into few
// rows. The soldier count is shown ONCE, inside the stepper; the power
// badge deliberately omits it.

import { UnitTypes } from '../config/UnitTypes.js';
import { unitIconSvg } from './UnitIcon.js';
import { insertPowerStatsAbove } from './PowerBadge.js';
import { createSizeStepper } from './UnitSizeStepper.js';
import { sizeStateOf } from '../scenarios/RosterScaling.js';

function div(className) {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

// entry:     roster entry { typeId, isUndead, aliveCount, ... }
// power:     power score of the entry at its current count
// onStep:    (delta) => void, delta is -1 or +1
// onRemove:  () => void
// onInspect: (anchorEl) => void, optional; wired to right-click
// Returns null when the entry's type does not resolve.
export function buildRosterUnitTile({ entry, power, onStep, onRemove, onInspect }) {
  const typeDef = UnitTypes[entry.typeId];
  if (!typeDef) return null;

  const tile = div('custom-team-unit');

  const icon = div('custom-team-unit-icon');
  icon.innerHTML = unitIconSvg(typeDef, entry.isUndead);
  tile.appendChild(icon);

  const info = div('custom-team-unit-info');

  const nameEl = div('custom-team-unit-name');
  const baseName = typeDef.displayName;
  nameEl.textContent = entry.isUndead ? `Skeleton ${baseName}` : baseName;
  nameEl.title = nameEl.textContent;
  info.appendChild(nameEl);

  // Controls row: [power badge] [- count +]. The badge helper inserts its
  // row immediately before the element it is given, so the stepper is
  // appended first and the badge lands to its left.
  const controls = div('custom-team-unit-controls');
  const stepper = createSizeStepper({
    count: entry.aliveCount,
    state: sizeStateOf(entry),
    onStep
  });
  controls.appendChild(stepper);

  const stats = insertPowerStatsAbove(stepper, { power });
  if (stats) stats.style.margin = '0';

  info.appendChild(controls);
  tile.appendChild(info);

  if (onInspect) {
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      onInspect(tile);
    });
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'custom-team-unit-remove';
  removeBtn.textContent = '\u00d7';
  removeBtn.title = 'Remove';
  removeBtn.addEventListener('click', () => onRemove());
  tile.appendChild(removeBtn);

  return tile;
}
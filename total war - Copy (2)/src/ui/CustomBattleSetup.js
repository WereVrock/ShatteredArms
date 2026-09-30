// ===== CustomBattleSetup.js =====
// Setup screen for a custom battle. Two roster columns (blue = player,
// red = AI) plus a palette of every unit type in the family registry.
// Each palette card has two add buttons (+Blue / +Red); roster rows have
// a remove button. A skeleton-mode toggle applies to all subsequent
// additions. A Reset button clears both rosters back to blank.
//
// Pure UI: builds view-model state (two rosters) and calls onStart with
// both lists when Start Battle is pressed. Nothing here touches the sim,
// the scenario builder, or persistence directly — main.js owns all of
// that wiring, including what "reset" means for the saved setup.

import { UnitTypes } from '../config/UnitTypes.js';
import { UnitFamilies } from '../campaign/UnitFamilies.js';
import { CampaignConfig } from '../campaign/CampaignConfig.js';
import { unitIconSvg } from './UnitIcon.js';

export class CustomBattleSetup {
  constructor(rootElement, { onStart, onBack, onReset }) {
    this.root = rootElement;
    this.onStart = onStart;
    this.onBack = onBack;
    // Optional. Called when the player clicks Reset to Blank. main.js
    // wires this to ActiveCustomBattle.clearLastSetup() so a reset is
    // sticky across reopens — see this file's reset handler for the
    // UI half of that contract.
    this.onReset = onReset || null;

    this.blueRoster = [];
    this.redRoster = [];
    this.skeletonMode = false;
  }

  // `initialState` is optional. When supplied and well-formed, its two
  // rosters seed the screen instead of an empty state — this is how the
  // "edit last setup" flow works: main.js passes ActiveCustomBattle
  // .getLastSetup() and the player lands on their previous configuration.
  // Entries are shallow-copied so edits here never mutate the caller's
  // objects (which may still be referenced by the persisted payload).
  //
  // The skeleton toggle always resets to false regardless of the initial
  // state — it's a mode switch for FUTURE additions, not a property of the
  // existing roster, and any unit already added carries its own isUndead
  // flag independently.
  show(initialState = null) {
    if (initialState
        && Array.isArray(initialState.blueRoster)
        && Array.isArray(initialState.redRoster)) {
      this.blueRoster = initialState.blueRoster.map(e => ({ ...e }));
      this.redRoster = initialState.redRoster.map(e => ({ ...e }));
    } else {
      this.blueRoster = [];
      this.redRoster = [];
    }
    this.skeletonMode = false;
    this._render();
  }

  hide() {
    this.root.classList.add('hidden');
  }

  // --- rendering -----------------------------------------------------------

  _render() {
    // Preserve scroll position across re-renders triggered by add/remove,
    // so a long roster doesn't jump the user back to the top on each click.
    const prevPanel = this.root.querySelector('.custom-battle-panel');
    const prevScroll = prevPanel ? prevPanel.scrollTop : 0;

    this.root.innerHTML = '';
    this.root.classList.remove('hidden');

    const panel = document.createElement('div');
    panel.className = 'menu-panel custom-battle-panel';

    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = 'Custom Battle';
    panel.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'menu-subtitle';
    sub.textContent = 'Choose units for both sides, then start the battle.';
    panel.appendChild(sub);

    const rostersRow = document.createElement('div');
    rostersRow.className = 'custom-rosters-row';
    rostersRow.appendChild(this._buildRosterPanel('Blue (You)', this.blueRoster, 'blue'));
    rostersRow.appendChild(this._buildRosterPanel('Red (AI)', this.redRoster, 'red'));
    panel.appendChild(rostersRow);

    const paletteTitle = document.createElement('div');
    paletteTitle.className = 'custom-palette-title';
    paletteTitle.textContent = 'Add units';
    panel.appendChild(paletteTitle);

    const palette = document.createElement('div');
    palette.className = 'custom-palette';
    for (const typeId of UnitFamilies.allTypeIds()) {
      palette.appendChild(this._buildPaletteCard(typeId));
    }
    panel.appendChild(palette);

    panel.appendChild(this._buildSkeletonRow());
    panel.appendChild(this._buildActionsRow());

    this.root.appendChild(panel);

    if (prevScroll > 0) panel.scrollTop = prevScroll;
  }

  _buildRosterPanel(label, roster, teamId) {
    const panel = document.createElement('div');
    panel.className = `custom-roster custom-roster-${teamId}`;

    const header = document.createElement('div');
    header.className = 'custom-roster-header';
    header.textContent = `${label} — ${roster.length} unit(s)`;
    panel.appendChild(header);

    const list = document.createElement('div');
    list.className = 'custom-roster-list';

    if (roster.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'custom-roster-empty';
      empty.textContent = 'No units yet.';
      list.appendChild(empty);
    } else {
      for (const entry of roster) {
        list.appendChild(this._buildRosterRow(entry, roster));
      }
    }

    panel.appendChild(list);
    return panel;
  }

  _buildRosterRow(entry, roster) {
    const row = document.createElement('div');
    row.className = 'custom-roster-row';

    const typeDef = UnitTypes[entry.typeId];

    const icon = document.createElement('span');
    icon.className = 'custom-roster-icon';
    icon.innerHTML = unitIconSvg(typeDef, entry.isUndead);
    row.appendChild(icon);

    const nameEl = document.createElement('span');
    nameEl.className = 'custom-roster-name';
    const baseName = typeDef.displayName;
    const displayName = entry.isUndead ? `Skeleton ${baseName}` : baseName;
    nameEl.textContent = `${displayName} ×${entry.aliveCount}`;
    row.appendChild(nameEl);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'custom-roster-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      const i = roster.indexOf(entry);
      if (i >= 0) roster.splice(i, 1);
      this._render();
    });
    row.appendChild(removeBtn);

    return row;
  }

  _buildPaletteCard(typeId) {
    const typeDef = UnitTypes[typeId];

    const card = document.createElement('div');
    card.className = 'custom-palette-card';

    const icon = document.createElement('div');
    icon.className = 'custom-palette-icon';
    icon.innerHTML = unitIconSvg(typeDef, this.skeletonMode);
    card.appendChild(icon);

    const name = document.createElement('div');
    name.className = 'custom-palette-name';
    name.textContent = typeDef.displayName;
    card.appendChild(name);

    const btnRow = document.createElement('div');
    btnRow.className = 'custom-palette-buttons';

    const addBlue = document.createElement('button');
    addBlue.type = 'button';
    addBlue.className = 'custom-add-btn custom-add-blue';
    addBlue.textContent = '+ Blue';
    addBlue.addEventListener('click', () => this._addUnit('blue', typeId));
    btnRow.appendChild(addBlue);

    const addRed = document.createElement('button');
    addRed.type = 'button';
    addRed.className = 'custom-add-btn custom-add-red';
    addRed.textContent = '+ Red';
    addRed.addEventListener('click', () => this._addUnit('red', typeId));
    btnRow.appendChild(addRed);

    card.appendChild(btnRow);
    return card;
  }

  _buildSkeletonRow() {
    const row = document.createElement('label');
    row.className = 'custom-skeleton-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.skeletonMode;
    cb.addEventListener('change', () => {
      this.skeletonMode = cb.checked;
      this._render();
    });
    row.appendChild(cb);

    const label = document.createElement('span');
    label.textContent = 'Skeleton units (undead — no rout, skeleton weapon mods)';
    row.appendChild(label);

    return row;
  }

  _buildActionsRow() {
    const actions = document.createElement('div');
    actions.className = 'custom-actions';

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'menu-card menu-confirm custom-start';
    startBtn.textContent = 'Start Battle';
    startBtn.disabled = this.blueRoster.length === 0 || this.redRoster.length === 0;
    startBtn.addEventListener('click', () => {
      if (startBtn.disabled) return;
      this.onStart(this.blueRoster.slice(), this.redRoster.slice());
    });
    actions.appendChild(startBtn);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'menu-card custom-reset';
    resetBtn.textContent = 'Reset to Blank';
    resetBtn.title = 'Clear both rosters. Also forgets the saved setup.';
    // Disabled when there's nothing to reset — avoids a no-op click and
    // gives a visual cue that the button has state.
    resetBtn.disabled = this.blueRoster.length === 0 && this.redRoster.length === 0;
    resetBtn.addEventListener('click', () => {
      if (resetBtn.disabled) return;
      this._handleReset();
    });
    actions.appendChild(resetBtn);

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'menu-card menu-back custom-back';
    backBtn.textContent = '← Back';
    backBtn.addEventListener('click', () => this.onBack());
    actions.appendChild(backBtn);

    return actions;
  }

  // --- state ---------------------------------------------------------------

  _addUnit(side, typeId) {
    const size = CampaignConfig.defaultSizes[typeId] || 15;
    const entry = {
      id: `custom-${side}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      typeId,
      isUndead: this.skeletonMode,
      aliveCount: size,
      maxCount: size
    };
    if (side === 'blue') this.blueRoster.push(entry);
    else this.redRoster.push(entry);
    this._render();
  }

  // Reset wipes the in-memory rosters AND asks the caller to clear the
  // persisted last-setup slot. Both halves are required for the button to
  // mean what it says: without the callback, closing the setup screen and
  // reopening it would restore the pre-reset state from storage, which
  // reads as the reset having silently failed.
  //
  // The ACTIVE slot (the currently-running battle) is deliberately not
  // touched — by the time this screen is open there is no active battle,
  // and if there somehow were, blowing it away from a UI button would be
  // the wrong place to do it.
  _handleReset() {
    this.blueRoster = [];
    this.redRoster = [];
    this.skeletonMode = false;
    if (this.onReset) this.onReset();
    this._render();
  }
}
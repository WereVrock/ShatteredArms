// ===== CustomBattleSetup.js =====
// ===== CustomBattleSetup.js =====
// Setup screen for a custom battle. Two teams, stacked top and bottom, each
// laid out as a HORIZONTAL strip of unit tiles. A shared palette sits
// between the two strips and adds to whichever team you press (+Blue /
// +Red). A skeleton-mode toggle applies to all subsequent additions.
//
// Player/AI role: each team's header carries a role button. Clicking it
// makes that team the player and the other team AI. Clicking the button on
// the team that is ALREADY the player flips it to AI, which — with the
// other team already AI — leaves BOTH teams AI (spectator mode). So:
//   - exactly one player team: standard
//   - both AI:                 spectator
// There is no state where both are player (the sim has a single
// playerTeamId by construction).
//
// Mirror button: each team's header also carries a "Mirror" button that
// replaces this team's roster with a fresh copy of the OTHER team's
// roster. Ids are regenerated so the two rosters never share unit ids —
// the scenario builder keys units by entry.id, and duplicate ids would
// make two distinct units indistinguishable. The button is disabled when
// the other team is empty (nothing to mirror).
//
// Pure UI: builds two rosters + a role selection, and calls onStart with
// all three. Nothing here touches the sim, the scenario builder, or
// persistence directly — main.js owns that wiring.

import { UnitTypes } from '../config/UnitTypes.js';
import { UnitFamilies } from '../campaign/UnitFamilies.js';
import { CampaignConfig } from '../campaign/CampaignConfig.js';
import { raceSupportsUndead } from '../config/RaceConfig.js';
import { unitIconSvg } from './UnitIcon.js';
import { insertPowerStatsAbove } from './PowerBadge.js';
import { buildPreviewUnit } from '../campaign/UnitPreview.js';
import { AITierConfig } from '../config/AITierConfig.js';
import { AITierPreference } from '../config/AITierPreference.js';
import { AITierPicker } from './AITierPicker.js';

export class CustomBattleSetup {
  constructor(rootElement, { onStart, onBack, onReset, unitInfoPanel }) {
    this.root = rootElement;
    this.onStart = onStart;
    this.onBack = onBack;
    // Optional. Called when the player clicks Reset to Blank. main.js
    // wires this to ActiveCustomBattle.clearLastSetup() so a reset is
    // sticky across reopens.
    this.onReset = onReset || null;
    // Optional. When supplied, right-clicking any unit card (palette or
    // roster) opens this panel with a preview unit built from that card's
    // data — see UnitPreview.buildPreviewUnit. Null-safe: without the
    // panel, cards simply ignore right-click.
    this.unitInfoPanel = unitInfoPanel || null;

    this.blueRoster = [];
    this.redRoster = [];
    this.skeletonMode = false;
    // 'blue' | 'red' | null. null = both teams AI (spectator).
    this.playerTeamId = 'blue';

    // Per-team AI difficulty. Only meaningful for teams currently set to
    // AI; kept for the player team too so flipping AI -> Player -> AI
    // preserves the last choice. Seeded from the global AITierPreference
    // on construction / every reset; a persisted lastSetup can override
    // both entries when the screen is reopened via the menu.
    const defaultTier = AITierPreference.get();
    this.aiTierByTeamId = { blue: defaultTier, red: defaultTier };

    // Every AITierPicker currently mounted by this screen. _render()
    // rebuilds them from scratch, so each one must be disposed first —
    // in global mode each construction registers a subscription.
    // An array because both team headers can carry one picker (the
    // player team carries none).
    this._tierPickers = [];
  }

  // `initialState` is optional. When supplied and well-formed, its two
  // rosters and player-team selection seed the screen instead of a blank
  // state — this is how the "edit last setup" flow works: main.js passes
  // ActiveCustomBattle.getLastSetup() and the player lands on their
  // previous configuration. Entries are shallow-copied so edits here never
  // mutate the caller's objects (which may still be referenced by the
  // persisted payload).
  //
  // The skeleton toggle always resets to false regardless of the initial
  // state — it's a mode switch for FUTURE additions, not a property of the
  // existing roster. Any unit already added carries its own isUndead flag
  // independently.
  //
  // playerTeamId is read defensively: older saves predate this field and
  // fall back to 'blue'; a save written as both-AI carries null explicitly
  // and is preserved.
  show(initialState = null) {
    // Per-team default, recomputed on every show() so a change to the
    // global preference between sessions is honoured for a fresh setup.
    const defaultTier = AITierPreference.get();

    if (initialState
        && Array.isArray(initialState.blueRoster)
        && Array.isArray(initialState.redRoster)) {
      this.blueRoster = initialState.blueRoster.map(e => ({ ...e }));
      this.redRoster = initialState.redRoster.map(e => ({ ...e }));
      this.playerTeamId = initialState.playerTeamId === null
        ? null
        : (initialState.playerTeamId === 'red' ? 'red' : 'blue');

      // Persisted tier map. Read defensively — older lastSetup payloads
      // predate this field, and an unrecognised tier id (stale save from
      // a future build) is ignored rather than stored. Missing values
      // fall back to the current global preference.
      const persisted = initialState.aiTierByTeamId;
      const blueTier = (persisted && typeof persisted.blue === 'string'
        && AITierConfig[persisted.blue]) ? persisted.blue : defaultTier;
      const redTier  = (persisted && typeof persisted.red  === 'string'
        && AITierConfig[persisted.red])  ? persisted.red  : defaultTier;
      this.aiTierByTeamId = { blue: blueTier, red: redTier };
    } else {
      this.blueRoster = [];
      this.redRoster = [];
      this.playerTeamId = 'blue';
      this.aiTierByTeamId = { blue: defaultTier, red: defaultTier };
    }
    this.skeletonMode = false;
    this._render();
  }

  hide() {
    this.root.classList.add('hidden');
  }

  // --- rendering -----------------------------------------------------------

  _render() {
    // Dispose every previously-built picker before rebuilding the DOM.
    // _render() runs on every add/remove/role-toggle; each global-mode
    // picker registers an AITierPreference subscription at construction,
    // so an undisposed list is a real leak. The list is rebuilt below as
    // team strips render their own per-team pickers.
    for (const p of this._tierPickers) p.dispose();
    this._tierPickers = [];

    // Preserve scroll position across re-renders triggered by add/remove,
    // so a long panel doesn't jump the user back to the top on each click.
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
    sub.textContent = 'Choose units for both sides, pick which one you command, then start the battle.';
    panel.appendChild(sub);

    // Per-team AI difficulty now lives inside each AI team's header strip
    // (see _buildTeamStrip). No global picker is rendered here — a
    // top-level control next to the per-team ones would be confusing
    // about which value wins.

    // Red on top, blue on bottom — mirrors the battlefield, where red
    // starts at positive Z (away from the camera) and blue at negative Z
    // (nearest the camera's default orientation). The setup screen reads
    // the same way the fight will when it opens.
    panel.appendChild(this._buildTeamStrip('red', this.redRoster, 'Red'));
    panel.appendChild(this._buildPalette());
    panel.appendChild(this._buildSkeletonRow());
    panel.appendChild(this._buildTeamStrip('blue', this.blueRoster, 'Blue'));

    if (this.playerTeamId === null) {
      panel.appendChild(this._buildSpectatorHint());
    }

    panel.appendChild(this._buildActionsRow());

    this.root.appendChild(panel);

    if (prevScroll > 0) panel.scrollTop = prevScroll;
  }

  // One team: header (role button + label + mirror button) above a
  // horizontal strip of unit tiles. The strip scrolls horizontally if the
  // roster overflows the panel width — no wrapping, so the two teams stay
  // visually distinct rows rather than bleeding into each other.
  _buildTeamStrip(teamId, roster, label) {
    const strip = document.createElement('div');
    strip.className = `custom-team-strip custom-team-${teamId}`;
    const isPlayer = this.playerTeamId === teamId;
    if (isPlayer) strip.classList.add('player');

    const header = document.createElement('div');
    header.className = 'custom-team-header';

    const roleBtn = document.createElement('button');
    roleBtn.type = 'button';
    roleBtn.className = `custom-role-btn ${isPlayer ? 'player' : 'ai'}`;
    roleBtn.textContent = isPlayer ? '⚔ Player' : 'AI';
    roleBtn.title = isPlayer
      ? 'This team is the player. Click to switch it to AI.'
      : 'Click to make this team the player.';
    roleBtn.addEventListener('click', () => this._toggleRole(teamId));
    header.appendChild(roleBtn);

    // Team aggregates. Total soldier count = sum of every entry's
    // aliveCount; total power = sum of every entry's full-strength
    // preview power. Both are computed on the same scale the per-card
    // badges use, so the header and the tile badges agree.
    //
    // Both are recomputed on every render (this function runs from
    // _render), so removing a tile updates the header immediately.
    let totalSoldiers = 0;
    let totalPower = 0;
    for (const e of roster) {
      totalSoldiers += e.aliveCount || 0;
      const typeDef = UnitTypes[e.typeId];
      if (typeDef) {
        totalPower += this._powerOf(typeDef, e.isUndead, e.aliveCount);
      }
    }

    const labelEl = document.createElement('div');
    labelEl.className = 'custom-team-label';
    labelEl.textContent =
      `${label} — ${roster.length} unit(s) `
      + `· ${totalSoldiers} soldiers `
      + `· power ${Math.round(totalPower)}`;
    header.appendChild(labelEl);

    // Mirror button: replace THIS team's roster with a copy of the other
    // team's. See _mirrorOpponent for id regeneration and why it matters.
    // Disabled when the other team is empty — mirroring nothing would
    // silently wipe this team's units, which is not what the label says.
    header.appendChild(this._buildMirrorButton(teamId));

    // Per-team AI difficulty picker. Rendered only for AI-controlled
    // teams — the player team has no difficulty to speak of. Compact
    // variant so it sits inline in the header without changing the
    // header's height.
    //
    // Controlled-mode picker: it neither reads nor writes the shared
    // AITierPreference, so each team's selection is independent. The
    // onChange callback writes straight back into aiTierByTeamId — no
    // _render() call, so roster / scroll state is preserved on toggle.
    if (!isPlayer) {
      const picker = new AITierPicker({
        value: this.aiTierByTeamId[teamId] || AITierPreference.get(),
        compact: true,
        onChange: (tierId) => { this.aiTierByTeamId[teamId] = tierId; }
      });
      this._tierPickers.push(picker);
      header.appendChild(picker.el);
    }

    strip.appendChild(header);

    const units = document.createElement('div');
    units.className = 'custom-team-units';

    if (roster.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'custom-team-empty';
      empty.textContent = 'No units yet.';
      units.appendChild(empty);
    } else {
      for (const entry of roster) {
        units.appendChild(this._buildUnitTile(entry, roster, teamId));
      }
    }

    strip.appendChild(units);
    return strip;
  }

  // Builds the per-team Mirror button. Kept as its own method so the
  // header code above stays a readable list of controls — the button
  // carries several pieces of state (disabled, hover, click target) that
  // would otherwise drown the header.
  _buildMirrorButton(teamId) {
    const otherTeamId = teamId === 'blue' ? 'red' : 'blue';
    const otherRoster = otherTeamId === 'blue' ? this.blueRoster : this.redRoster;
    const canMirror = otherRoster.length > 0;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `custom-mirror-btn custom-mirror-${teamId}`;
    btn.textContent = '⇄ Mirror';
    btn.title = canMirror
      ? `Replace this team's units with a copy of the ${otherTeamId} team's units.`
      : `The ${otherTeamId} team has no units to mirror.`;
    btn.disabled = !canMirror;
    btn.style.cssText = [
      'padding:3px 10px',
      'font-family:inherit',
      'font-size:11px',
      'letter-spacing:0.6px',
      'border-radius:4px',
      'border:1px solid #3a4a5e',
      'background:#1e2430',
      'color:#aab',
      'cursor:' + (canMirror ? 'pointer' : 'not-allowed'),
      'opacity:' + (canMirror ? '1' : '0.4')
    ].join(';');
    if (canMirror) {
      btn.addEventListener('mouseenter', () => { btn.style.background = '#28303e'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = '#1e2430'; });
      btn.addEventListener('click', () => this._mirrorOpponent(otherTeamId, teamId));
    }
    return btn;
  }

  _buildUnitTile(entry, roster, teamId) {
    const tile = document.createElement('div');
    tile.className = 'custom-team-unit';

    const typeDef = UnitTypes[entry.typeId];

    const icon = document.createElement('div');
    icon.className = 'custom-team-unit-icon';
    icon.innerHTML = unitIconSvg(typeDef, entry.isUndead);
    tile.appendChild(icon);

    const nameEl = document.createElement('div');
    nameEl.className = 'custom-team-unit-name';
    const baseName = typeDef.displayName;
    nameEl.textContent = entry.isUndead ? `Skeleton ${baseName}` : baseName;
    nameEl.title = nameEl.textContent;
    tile.appendChild(nameEl);

    const countEl = document.createElement('div');
    countEl.className = 'custom-team-unit-count';
    countEl.textContent = `×${entry.aliveCount}`;
    tile.appendChild(countEl);

    // Stat row (power + soldier count) at the entry's CURRENT alive
    // count, placed in normal flow above the icon so it does not cover
    // the portrait. On Custom Battle every entry is full-strength by
    // construction (nothing has fought), but reading aliveCount keeps
    // the number correct if a future deployed-strength editor lands.
    insertPowerStatsAbove(icon, {
      power: this._powerOf(typeDef, entry.isUndead, entry.aliveCount),
      soldiers: entry.aliveCount
    });

    // Right-click opens the info panel with a preview built from this
    // entry. Guarded on unitInfoPanel being supplied (see constructor);
    // without it, right-click falls through to the browser default.
    if (this.unitInfoPanel) {
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._openPreview(
          entry.typeId,
          entry.isUndead,
          entry.aliveCount,
          entry.maxCount,
          teamId,
          tile
        );
      });
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'custom-team-unit-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      const i = roster.indexOf(entry);
      if (i >= 0) roster.splice(i, 1);
      this._render();
    });
    tile.appendChild(removeBtn);

    return tile;
  }

  _buildPalette() {
    const wrap = document.createElement('div');

    const paletteTitle = document.createElement('div');
    paletteTitle.className = 'custom-palette-title';
    paletteTitle.textContent = 'Add units';
    wrap.appendChild(paletteTitle);

    const palette = document.createElement('div');
    palette.className = 'custom-palette';
    for (const typeId of UnitFamilies.customBattlePaletteTypeIds()) {
      palette.appendChild(this._buildPaletteCard(typeId));
    }
    wrap.appendChild(palette);

    return wrap;
  }

  _buildPaletteCard(typeId) {
    const typeDef = UnitTypes[typeId];
    // Resolve the skeleton flag ONCE so the icon, the power badge, and
    // the right-click preview all agree — the palette card is a static
    // preview of what "+Blue"/"+Red" would add RIGHT NOW, and the current
    // skeleton toggle is part of that.
    const isUndead = this._undeadFor(typeDef);
    const size = CampaignConfig.defaultSizes[typeId] || 15;

    const card = document.createElement('div');
    card.className = 'custom-palette-card';

    const icon = document.createElement('div');
    icon.className = 'custom-palette-icon';
    icon.innerHTML = unitIconSvg(typeDef, isUndead);
    card.appendChild(icon);

    const name = document.createElement('div');
    name.className = 'custom-palette-name';
    name.textContent = typeDef.displayName;
    card.appendChild(name);

    // Power + soldier count, placed in normal flow above the icon so they
    // do not cover the portrait. Same scale as a live unit's in-battle
    // power score, so two palette options can be ranked at a glance, and
    // `size` is the count the +Blue / +Red buttons would add — matching
    // CampaignConfig.defaultSizes so the preview matches what lands in the
    // roster.
    insertPowerStatsAbove(icon, {
      power: this._powerOf(typeDef, isUndead, size),
      soldiers: size
    });

    // Right-click opens the info panel with a preview of this type. Team
    // defaults to the player's team so the panel's colour stripe matches
    // the army this palette card would normally feed; a spectator-mode
    // setup (both teams AI) falls back to 'blue' — the panel shows a team
    // label either way, and the preview is about the unit, not the side.
    if (this.unitInfoPanel) {
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._openPreview(
          typeId,
          isUndead,
          size,
          size,
          this.playerTeamId || 'blue',
          card
        );
      });
    }

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

  _buildSpectatorHint() {
    const hint = document.createElement('div');
    hint.className = 'custom-spectator-hint';
    hint.textContent = 'Spectator mode — both teams will be controlled by AI.';
    return hint;
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
      // Third arg: 'blue' | 'red' | null. null means both teams AI.
      // Fourth arg: per-team AI difficulty, passed as a shallow copy so
      // downstream code cannot mutate this screen's state.
      this.onStart(
        this.blueRoster.slice(),
        this.redRoster.slice(),
        this.playerTeamId,
        { ...this.aiTierByTeamId }
      );
    });
    actions.appendChild(startBtn);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'menu-card custom-reset';
    resetBtn.textContent = 'Reset to Blank';
    resetBtn.title = 'Clear both rosters. Also forgets the saved setup.';
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

  // --- card info panel -----------------------------------------------------

  // Shared power read for every per-card badge and the team-strip
  // aggregate. Routes through buildPreviewUnit -> UnitPower.compute,
  // the same path computeUnitPrice and the AI's Unit.getPower use, so
  // the setup screen, the campaign shop, and the in-battle score all
  // report the same number for the same type / undead / count.
  _powerOf(typeDef, isUndead, aliveCount) {
    const preview = buildPreviewUnit({
      id: 'power-preview',
      typeDef,
      isUndead,
      aliveCount,
      maxCount: aliveCount,
      teamId: 'blue'
    });
    return preview.getPower().total;
  }

  // Shared right-click handler for palette cards and roster tiles. Builds
  // a full-strength preview of the unit the card describes and opens the
  // shared UnitInfoPanel on it. No-op if the panel was not supplied or the
  // type id does not resolve.
  _openPreview(typeId, isUndead, aliveCount, maxCount, teamId, anchorEl) {
    if (!this.unitInfoPanel) return;
    const typeDef = UnitTypes[typeId];
    if (!typeDef) return;

    const preview = buildPreviewUnit({
      id: `preview-${typeId}`,
      typeDef,
      isUndead,
      aliveCount,
      maxCount,
      teamId
    });
    this.unitInfoPanel.open(preview, anchorEl);
  }

  // --- state ---------------------------------------------------------------

  // Applies the skeleton toggle to a specific unit type, honouring the
  // race's supportsUndead flag. A goblin added while skeleton mode is on
  // deploys as a living goblin — the palette card preview and the roster
  // entry both route through here, so the icon the player sees before
  // clicking and the unit that ends up in the roster can never disagree.
  //
  // Skeleton mode itself is left untouched: it stays on so the next
  // human-type click still produces an undead unit. Only the affected
  // entry ignores it.
  _undeadFor(typeDef) {
    return this.skeletonMode && raceSupportsUndead(typeDef);
  }

  _addUnit(side, typeId) {
    const size = CampaignConfig.defaultSizes[typeId] || 15;
    const entry = {
      id: `custom-${side}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      typeId,
      isUndead: this._undeadFor(UnitTypes[typeId]),
      aliveCount: size,
      maxCount: size
    };
    if (side === 'blue') this.blueRoster.push(entry);
    else this.redRoster.push(entry);
    this._render();
  }

  // Replaces the target team's roster with a fresh copy of the source
  // team's. Ids are regenerated per entry so the two rosters never share
  // a unit id — CustomBattleBuilder keys units by entry.id, and a shared
  // id would make two distinct units indistinguishable downstream (they
  // would resolve to the same Unit in any id-keyed map).
  //
  // The `custom-${toTeamId}-...` prefix keeps the regenerated ids
  // disjoint from the source's `custom-${fromTeamId}-...` ids even if
  // the loop runs inside a single millisecond, and the random suffix
  // guarantees uniqueness within the new roster.
  //
  // No-op when the source is empty: the header's mirror button is
  // disabled in that case, but a direct call from somewhere else should
  // not silently wipe the target.
  _mirrorOpponent(fromTeamId, toTeamId) {
    const source = fromTeamId === 'blue' ? this.blueRoster : this.redRoster;
    if (source.length === 0) return;

    const mirrored = source.map(e => ({
      ...e,
      id: `custom-${toTeamId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    }));

    if (toTeamId === 'blue') this.blueRoster = mirrored;
    else this.redRoster = mirrored;

    this._render();
  }

  // Role model, in one place:
  //   - clicking a non-player team's button promotes it to player (the
  //     previous player, if any, silently becomes AI);
  //   - clicking the current player team's button demotes it to AI, which
  //     leaves BOTH teams AI because the other team was already AI.
  // There is no "both player" state to guard against — the model never
  // produces it.
  _toggleRole(teamId) {
    this.playerTeamId = (this.playerTeamId === teamId) ? null : teamId;
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
// Reset wipes the in-memory rosters but deliberately preserves the
  // player/AI role selection. Role is independent of roster contents:
  // a spectator (both-AI) setup that gets its rosters cleared must NOT
  // silently become player-vs-AI on the next open.
  //
  // The callback is handed the POST-reset state so the caller can
  // PERSIST it (overwriting the previous last-setup payload) instead of
  // merely clearing the slot. Clearing outright was the source of a
  // reopen-after-reset bug: reopening with no persisted setup landed on
  // show(null), whose else-branch hardcodes playerTeamId = 'blue' and
  // silently promoted a spectator setup back to player-vs-AI.
  // Writing back the empty-rosters-with-current-role payload keeps the
  // "reset is sticky" contract AND survives a close-and-reopen.
  //
  // aiTierByTeamId IS re-seeded from the current global preference:
  // tiers are a property of a fresh roster, not of the role pick.
  _handleReset() {
    this.blueRoster = [];
    this.redRoster = [];
    this.skeletonMode = false;
    const defaultTier = AITierPreference.get();
    this.aiTierByTeamId = { blue: defaultTier, red: defaultTier };
    if (this.onReset) {
      this.onReset(
        this.blueRoster.slice(),
        this.redRoster.slice(),
        this.playerTeamId,
        { ...this.aiTierByTeamId }
      );
    }
    this._render();
  }
}
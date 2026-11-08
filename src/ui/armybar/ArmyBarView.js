// Pure UI: reads Unit / Soldier state and renders one card per player-team
// unit at the bottom of the screen. No combat logic, no sim mutation. The
// only outbound call is selectionController.selectUnit() on a card click.
//
// Card layout:
//   ┌─────────────┐
//   │⚑ 4       ⚔ │  top-left:  routing count (hidden when zero)
//   │             │  top-right: activity icon
//   │   [icon]    │  composite SVG unit icon (see UnitIcon.js)
//   │   12 / 20   │  alive / total
//   └─────────────┘
//
// Cards are keyed by unitId and reused across ticks. `update()` runs every
// render frame, so the DOM is only ever mutated in place — nothing is torn
// down and rebuilt per frame. The SVG icon is set once at card creation: a
// unit's unitTypeDef and undead flag never change during a battle, so the
// image is stable.
//
// Enemy-team units are filtered out entirely: this bar is the player's army
// panel, not a scoreboard. To show both sides later, drop the teamId check
// in update() (the .team-red CSS rules are already there for it).

import { unitIconSvg } from '../UnitIcon.js';
import { ArmyBarOrder } from './ArmyBarOrder.js';
import { ArmyBarDrag } from './ArmyBarDrag.js';
import { ArmyControlGroups } from './ArmyControlGroups.js';
import { ArmyBarHotkeys } from './ArmyBarHotkeys.js';
import { ArmySquads } from './ArmySquads.js';
import { ArmyBarReorderer } from './ArmyBarReorderer.js';
import { ArmyBarToolbar } from './ArmyBarToolbar.js';
import { ArmySquadOverlay } from './ArmySquadOverlay.js';
import { ArmyBarZoom } from './ArmyBarZoom.js';
import { ensureArmyBarExtrasStyles } from './ArmyBarExtrasStyles.js';
import { attachRankBadge } from '../UnitRank.js';
import { SettingsStore } from '../settings/SettingsStore.js';
import { getMedievalTooltip } from '../MedievalTheme.js';
import {
  computeArmyBarLayout,
  ARMY_BAR_SIDE_MARGIN,
  ARMY_BAR_MAX_HEIGHT_FRACTION
} from './ArmyBarLayout.js';

// rootElement -> the ArmyBarView currently driving it. #armyBar is reused
// across battles (a campaign runs several per page load), so a new view
// disposes the previous one for the same root.
const viewByRoot = new WeakMap();

// Icon shown in the top-right corner. One glyph per unit, chosen by
// _activityFor() with a strict priority order (fighting > shooting >
// impetuous charge > focus-attack > rally > march > idle).
const ACTIVITY_ICON = {
  engaged:   '⚔',
  ranged:    '➶',
  impetuous: '⚡',
  attacking: '⌖',
  rallying:  '⇢',
  marching:  '➤',
  idle:      '',
  dead:      '☠'
};

// Tooltip label, kept in the same order as ACTIVITY_ICON so a new state
// added in one place doesn't quietly go missing from the other.
const ACTIVITY_LABEL = {
  engaged:   'Engaged',
  ranged:    'Ranged fire',
  impetuous: 'Impetuous charge',
  attacking: 'Attacking focused unit',
  rallying:  'Rallying to ally',
  marching:  'Marching to order',
  idle:      'Idle',
  dead:      'Destroyed'
};

// Injected once per page. Kept in this file rather than style.css so the
// component stays self-contained (matches CommandBarView, UnitInfoPanel,
// ChangelogPanel). Only the bar colours and geometry live here — the
// surrounding card chrome continues to come from style.css.
const BAR_STYLE_ID = 'army-bar-view-bar-styles';
const BAR_STYLE_TEXT = `
  .army-card-image {
    /* Positioning context for the overlay bars. The image element
       already occupies the card's central icon area; making it relative
       lets .army-card-bars anchor to its bottom edge without affecting
       any sibling layout. */
    position: relative;
  }
  .army-card-bars {
    position: absolute;
    left: 4px;
    right: 4px;
    bottom: 2px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    pointer-events: none;
  }
  .army-card-bar {
    height: 3px;
    background: rgba(0, 0, 0, 0.55);
    border-radius: 2px;
    overflow: hidden;
    box-shadow: inset 0 0 1px rgba(0, 0, 0, 0.8);
  }
  .army-card-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.15s linear;
  }
  /* Morale fill — green at high morale, amber mid, red low. The bands
     are applied via a modifier class on the fill element, matching the
     three-band approach UnitInfoPanel uses for its HP bar. */
  .army-card-bar.morale  .army-card-bar-fill                  { background: #4a9a4a; }
  .army-card-bar.morale  .army-card-bar-fill.band-hurt        { background: #b09040; }
  .army-card-bar.morale  .army-card-bar-fill.band-critical    { background: #a04040; }
  /* Fatigue fill — tan/gold, no banding. Fatigue is a resource that
     only goes down; a single colour reads as "how much is left". */
  .army-card-bar.fatigue .army-card-bar-fill                  { background: #b09050; }
  /* Champion HP fill — deep red, matching the world-overlay champion
     bar. Deliberately distinct from the morale bands (green/amber/red)
     so a player scanning the card reads it as a separate resource, not
     as a third morale state. */
  .army-card-bar.championHp .army-card-bar-fill               { background: #c23a3a; }
`;

function ensureBarStyles() {
  if (document.getElementById(BAR_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = BAR_STYLE_ID;
  el.textContent = BAR_STYLE_TEXT;
  document.head.appendChild(el);
}

export class ArmyBarView {
  // `onUnitFocus` is optional. When supplied, double-clicking a card calls
  // it with the Unit — main.js wires this to sceneSetup so the camera
  // recenters on the unit. Kept as a callback rather than passing
  // sceneSetup in directly: this class is pure UI and must not know about
  // the 3D scene, per the project's UI-logic separation rule.
  constructor(rootElement, selectionController, playerTeamId, onUnitFocus = null) {
    ensureBarStyles();
    ensureArmyBarExtrasStyles();

    // Tear the previous view down first so its document-level listeners
    // and body-level toolbar / squad frames do not pile up.
    const previousView = viewByRoot.get(rootElement);
    if (previousView) previousView.dispose();
    viewByRoot.set(rootElement, this);

    // Wipe any cards left by a previous battle. #armyBar is a fixed
    // DOM node shared across every battle, so when a new battle starts
    // on the same page as an old one (no reload boundary — e.g.
    // first battle -> back -> new campaign -> first battle), the old
    // cards would otherwise sit under the new ones. Doing this in the
    // constructor (not update()) means not a single stale frame is
    // rendered.
    rootElement.innerHTML = '';

    this.root = rootElement;
    this.selectionController = selectionController;
    this.playerTeamId = playerTeamId;
    this.onUnitFocus = onUnitFocus;

    // Optional. Right-clicking a card invokes this with (unit, cardElement),
    // so the caller can open a details panel anchored to that card. Null
    // means right-clicking does nothing beyond suppressing the browser's
    // context menu — the bar still works when constructed without it.
    this.onUnitInfo = null;

    // Player-defined card order, control groups, drag-to-reorder and the
    // digit-key hotkeys. All state lives in these helper classes; this view
    // only asks them questions and forwards DOM events.
    this.order = new ArmyBarOrder();
    this.groups = new ArmyControlGroups();
    this.squads = new ArmySquads();
    this.reorderer = new ArmyBarReorderer(this.order, this.squads);
    this.drag = new ArmyBarDrag(
      rootElement,
      (drop) => this._handleDrop(drop),
      (kind, id, targetUnitId) => this._isValidDropTarget(kind, id, targetUnitId)
    );
    this.hotkeys = new ArmyBarHotkeys({
      owner: rootElement,
      groups: this.groups,
      selectionController,
      getUnits: () => Array.from(this.unitById.values())
        .filter((u) => u.teamId === this.playerTeamId),
      onUnitFocus: (u) => { if (this.onUnitFocus) this.onUnitFocus(u); }
    });
    this.hotkeys.attach();

    // Group / selection actions shared by the hotkeys, the toolbar and the
    // squad tabs.
    this.actions = this.hotkeys.actions;

    // Card size multiplier set by the toolbar's - and + buttons. Stored per
    // team so the red and blue bars of local multiplayer keep their own.
    this.zoom = new ArmyBarZoom('sa.armyBarZoom.' + playerTeamId);

    // Floating toolbar (sort, make squad, card size) and the squad frame
    // overlay. Both live on document.body, not inside the bar, so they
    // never take part in the card order or layout.
    this.toolbar = new ArmyBarToolbar(rootElement, {
      onSort: () => this._sortByType(),
      onCreateSquad: () => this._createSquadFromSelection(),
      onZoom: (direction) => this._changeZoom(direction)
    });
    this.overlay = new ArmySquadOverlay(rootElement, this.squads, {
      onSelect: (squadId, additive) => this._selectSquad(squadId, additive),
      onToggle: (squadId) => this.squads.toggleCollapsed(squadId),
      onToggleLock: (squadId) => this.squads.toggleLocked(squadId),
      onDisband: (squadId) => this.squads.disband(squadId),
      attachDrag: (chipEl, squadId) => this.drag.attachSquad(chipEl, squadId)
    });

    // Display bookkeeping. _displayIds is the order the player currently
    // sees, hidden (collapsed) cards included. The overlay and toolbar are
    // only recomputed when _overlayDirty is set, never per frame.
    this._displayIds = [];
    this._displaySig = '';
    this._overlayDirty = true;
    this._wasHidden = false;
    this._squadsVersion = -1;
    this._onScroll = () => { this._overlayDirty = true; };
    rootElement.addEventListener('scroll', this._onScroll, { passive: true });

    // unitId -> { el, flagEl, iconEl, imageEl, countEl }
    this.cardByUnitId = new Map();
    // unitId -> Unit, refreshed every update() so the click handler never
    // holds a stale reference to a unit object.
    this.unitById = new Map();

    // "count|width|height" of the last applied layout. Layout is only
    // recomputed when one of the three changes.
    this._layoutKey = '';
  }

update(units) {
    // Bar visibility is read once per update() call — not per card — so
    // a settings change takes effect on the next render frame without
    // requiring a subscription or dispose() plumbing. The `!== false`
    // guard treats an unregistered setting as "shown", so the feature is
    // visible immediately even before the settings panel is wired.
    const settings = SettingsStore.get();
    this._showMoraleBar = settings.showMoraleBar !== false;
    this._showFatigueBar = settings.showFatigueBar !== false;

    this.unitById.clear();
    for (const u of units) this.unitById.set(u.id, u);

    const playerUnits = units.filter((u) => u.teamId === this.playerTeamId);
    // Player order with every squad made contiguous.
    const arranged = this.order.arrange(
      playerUnits,
      (id) => this.squads.squadIdFor(id)
    );

    const orderedChildren = [];
    const seen = new Set();

    for (const unit of arranged) {
      seen.add(unit.id);

      let card = this.cardByUnitId.get(unit.id);
      if (!card) {
        card = this._createCard(unit);
        this.cardByUnitId.set(unit.id, card);
      }
      this._updateCard(card, unit);
      orderedChildren.push(card.el);
    }

    // Defensive: drop cards for units that are no longer in the array. In
    // the current scenarios the units array is fixed, so this normally
    // does nothing — but if unit removal is added later it must not leak.
    for (const [id, card] of this.cardByUnitId) {
      if (!seen.has(id)) {
        card.el.remove();
        this.cardByUnitId.delete(id);
      }
    }

    const displayIds = arranged.map((u) => u.id);
    const signature = displayIds.join('|');
    if (signature !== this._displaySig) {
      this._displaySig = signature;
      this._overlayDirty = true;
    }
    this._displayIds = displayIds;

    const visibleCount = this._applyCollapse(arranged);
    this._syncChildOrder(orderedChildren);
    this._applyLayout(visibleCount);
    this._refreshExtras();
  }

  // Fits every card into the bar by scaling them (see ArmyBarLayout.js).
  // Runs only when the unit count or the window size changed. The
  // scrollable flag is a last resort for armies too big even at the
  // minimum scale.
_applyLayout(count) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const key = count + '|' + w + '|' + h;
    if (key === this._layoutKey) return;
    this._layoutKey = key;

    // The layout is solved for an area 1/zoom as large, then every size it
    // returns is multiplied back by zoom. At zoom 1 this is the plain
    // fit-to-bar layout; above 1 the cards grow past the fit (the bar then
    // scrolls), below 1 they shrink.
    const z = this.zoom.value;
    const layout = computeArmyBarLayout({
      count,
      availableWidth: (w - ARMY_BAR_SIDE_MARGIN) / z,
      availableHeight: (h * ARMY_BAR_MAX_HEIGHT_FRACTION) / z
    });
    const style = this.root.style;
    style.setProperty('--army-scale', String(layout.scale * z));

    const overlap = layout.mode === 'overlap';
    this.root.classList.toggle('overlap', overlap);
    if (overlap) {
      style.setProperty('--army-cols', String(layout.perRow));
      style.setProperty('--army-step', (layout.step * z).toFixed(2) + 'px');
      style.setProperty('--army-card-w', (layout.cardW * z).toFixed(2) + 'px');
      style.setProperty('--army-card-h', (layout.cardH * z).toFixed(2) + 'px');
      style.setProperty('--army-overhang', (layout.overhang * z).toFixed(2) + 'px');
    }

    this.root.classList.toggle(
      'scrollable',
      this.root.scrollHeight > this.root.clientHeight + 1
    );

    // Card positions changed, so squad frames and the toolbar need to be
    // recomputed on the next _refreshExtras().
    this._overlayDirty = true;
  }

  // Cheap order check: if the DOM already matches, do nothing. If it
  // doesn't (first build, or a reorder), re-append in the desired order.
  // Appending existing nodes moves them without recreating them.
  _syncChildOrder(orderedChildren) {
    const current = Array.from(this.root.children);
    if (current.length === orderedChildren.length) {
      let same = true;
      for (let i = 0; i < orderedChildren.length; i++) {
        if (current[i] !== orderedChildren[i]) { same = false; break; }
      }
      if (same) return;
    }
    this.root.append(...orderedChildren);
  }

_createCard(unit) {
    const el = document.createElement('div');
    el.className = `army-card team-${unit.teamId}`;
    el.dataset.unitId = String(unit.id);

    const flagEl = document.createElement('span');
    flagEl.className = 'army-card-flag';

    const iconEl = document.createElement('span');
    iconEl.className = 'army-card-icon';

    const imageEl = document.createElement('div');
    imageEl.className = 'army-card-image';
    this._installIcon(imageEl, unit);

    // Morale + fatigue bars, overlaid on the bottom edge of the icon
    // area. Built once per card (never rebuilt) and only their fill
    // widths and visibility are touched per frame — the elements stay
    // in place so the browser does not reflow the card on every update.
    const barsEl = document.createElement('div');
    barsEl.className = 'army-card-bars';

    const moraleBarEl = document.createElement('div');
    moraleBarEl.className = 'army-card-bar morale';
    const moraleFillEl = document.createElement('div');
    moraleFillEl.className = 'army-card-bar-fill';
    moraleBarEl.appendChild(moraleFillEl);

    const fatigueBarEl = document.createElement('div');
    fatigueBarEl.className = 'army-card-bar fatigue';
    const fatigueFillEl = document.createElement('div');
    fatigueFillEl.className = 'army-card-bar-fill';
    fatigueBarEl.appendChild(fatigueFillEl);

    barsEl.appendChild(moraleBarEl);
    barsEl.appendChild(fatigueBarEl);

    // Champion HP bar. Built only when the unit carries a champion —
    // `unit.championSoldier` is set by the campaign battle builder on
    // the retinue unit and left null on every other unit. Non-champion
    // cards therefore do not carry these two elements at all, rather
    // than carrying them hidden.
    //
    // Hidden while the champion is dead — a defeated champion's card
    // shows only the standard pair, matching the world overlay.
    let championHpBarEl = null;
    let championHpFillEl = null;
    if (unit.championSoldier) {
      championHpBarEl = document.createElement('div');
      championHpBarEl.className = 'army-card-bar championHp';
      championHpFillEl = document.createElement('div');
      championHpFillEl.className = 'army-card-bar-fill';
      championHpBarEl.appendChild(championHpFillEl);
      barsEl.appendChild(championHpBarEl);
    }

    imageEl.appendChild(barsEl);

    // Control-group badge (e.g. "1" or "1 3"). Lives inside the image
    // area so it anchors to the icon; hidden until the unit is in a group.
    const groupEl = document.createElement('span');
    groupEl.className = 'army-card-group';
    groupEl.style.display = 'none';
    imageEl.appendChild(groupEl);

    const countEl = document.createElement('span');
    countEl.className = 'army-card-count';
    countEl.textContent = '0/0';

    el.appendChild(flagEl);
    el.appendChild(iconEl);
    el.appendChild(imageEl);
    el.appendChild(countEl);

    // Click → select. Shift-click → add to selection. Matches the canvas
    // selection rules exactly (see SelectionController._handleSingleClick).
    el.addEventListener('click', (e) => this._handleCardClick(unit.id, e));

    // Double-click → recenter the camera on this unit. Selection still
    // happens (dblclick fires after the second click), so double-clicking
    // both selects and focuses — which is what you want: the card you just
    // centred on is also the one your next order will apply to.
    //
    // onUnitFocus is optional so the view still works when constructed
    // without it (e.g. in tests or a future non-3D context).
    el.addEventListener('dblclick', (e) => this._handleCardDoubleClick(unit.id, e));

    // Right-click → open the unit-info panel. The card element is passed
    // through so the panel can anchor itself to this specific card and
    // keep re-reading its rect each frame (the bar may rewrap or reorder).
    // preventDefault suppresses the browser's native context menu — the
    // card is not a link or input, so there is nothing worth offering
    // there, and the menu would visually cover the panel it just opened.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const u = this.unitById.get(unit.id);
      if (!u) return;
      if (this.onUnitInfo) this.onUnitInfo(u, el);
    });

    // Hover tooltip. A custom medieval-styled tooltip (see
    // MedievalTheme.js) replaces the native `title` attribute, whose
    // appearance the browser controls and which cannot be styled. The
    // text itself is written into `dataset.tooltipName` by _writeCard, so
    // it tracks customName / isUndead changes without rebuilding the
    // listeners.
    el.addEventListener('mouseenter', () => {
      // Suppress while dragging: the drop-target highlight is the only
      // feedback that should appear during a drag.
      if (this.root.classList.contains('army-bar-drag-active')) return;
      const text = el.dataset.tooltipName;
      if (text) getMedievalTooltip().schedule(el, text);
    });
    el.addEventListener('mouseleave', () => {
      getMedievalTooltip().hide(el);
    });

    // Drag-to-reorder. Only starts after the pointer moves a few pixels,
    // so the click / dblclick / contextmenu handlers above are unaffected.
    this.drag.attach(el, unit.id);

    this.root.appendChild(el);

    return {
      el, flagEl, iconEl, imageEl, countEl, groupEl,
      barsEl, moraleBarEl, moraleFillEl, fatigueBarEl, fatigueFillEl,
      championHpBarEl, championHpFillEl
    };
  }

  // Sets the composite SVG icon once, at card creation. The SVG is a self-
  // contained markup string (see UnitIcon.js) so setting innerHTML is all
  // that's needed — no img, no data URL, no async load.
  //
  // Unit itself has no unitTypeDef — the type lives on each Soldier, and all
  // soldiers in a Unit share one definition (see FormationFactory). Read it
  // from the lead soldier.
  _installIcon(imageEl, unit) {
    const lead = unit.soldiers && unit.soldiers[0];
    if (!lead) return;
    imageEl.innerHTML = unitIconSvg(lead.unitTypeDef, unit.isUndead);
    // Rank badge for campaign-veteran units. Reads unit.unitLevel, which
    // is stamped on the unit at battle-build time by
    // CampaignBattleBuilder.annotateUnitProgression. No-op for level 1
    // and for units without a unitLevel field (standalone scenarios and
    // custom battles do not go through the campaign builder).
    attachRankBadge(imageEl, unit.unitLevel);
  }

  // Reads the unit's visible state and rewrites the card only when it
  // differs from the last write. Fractions are rounded to the 0.1% the
  // bar widths are written at.
  _updateCard(card, unit) {
    const key = this._cardKey(unit);
    if (key === card.lastKey) return;
    card.lastKey = key;
    this._writeCard(card, unit);
  }

_cardKey(unit) {
    const alive = unit.getAliveSoldiers();
    let routing = 0;
    let moraleSum = 0;
    let maxMoraleSum = 0;
    let fatigueSum = 0;
    for (const s of alive) {
      if (s.isRouting) routing++;
      moraleSum += s.morale;
      maxMoraleSum += (s.maxMorale ?? 100);
      fatigueSum += s.fatigue;
    }

    const moraleKey = maxMoraleSum > 0
      ? Math.round(Math.max(0, Math.min(1, moraleSum / maxMoraleSum)) * 1000)
      : 0;
    const fatigueKey = alive.length > 0
      ? Math.round(Math.max(0, Math.min(1, fatigueSum / alive.length / 100)) * 1000)
      : 0;

    const champ = unit.championSoldier;
    let champKey = -1;
    if (champ && champ.isAlive()) {
      champKey = champ.maxHp > 0
        ? Math.round(Math.max(0, Math.min(1, champ.hp / champ.maxHp)) * 1000)
        : 0;
    }

    return `${alive.length}|${unit.soldiers.length}|${routing}|` +
      `${this._activityFor(unit)}|${unit.selected ? 1 : 0}|` +
      `${moraleKey}|${fatigueKey}|${champKey}|` +
      `${this._showMoraleBar ? 1 : 0}${this._showFatigueBar ? 1 : 0}|` +
      `${this.groups.labelFor(unit.id)}`;
  }

_writeCard(card, unit) {
    const alive = unit.getAliveSoldiers().length;
    const total = unit.soldiers.length;
    const routingCount = this._routingCount(unit);
    const activity = this._activityFor(unit);
    const defeated = alive === 0;

    // Casualty flash. lastAlive is undefined on the first write, so a
    // freshly built card never flashes.
    if (card.lastAlive !== undefined && alive < card.lastAlive) {
      this._flashHit(card);
    }
    card.lastAlive = alive;

    card.el.classList.toggle('routing', routingCount > 0);
    card.el.classList.toggle('selected', !!unit.selected);
    card.el.classList.toggle('dead', defeated);

    card.flagEl.textContent = routingCount > 0 ? `⚑ ${routingCount}` : '';
    card.countEl.textContent = `${alive} / ${total}`;
    card.iconEl.textContent = ACTIVITY_ICON[activity] || '';
    card.iconEl.title = ACTIVITY_LABEL[activity] || '';

    const groupLabel = this.groups.labelFor(unit.id);
    card.groupEl.textContent = groupLabel;
    card.groupEl.style.display = groupLabel ? '' : 'none';

    // Unit has no unitTypeDef — its type comes from the soldiers. See
    // _installIcon for the same lookup. customName (set on champion
    // units at battle-build time) overrides the type's displayName.
    const lead = unit.soldiers && unit.soldiers[0];
    const baseName = unit.customName
      || (lead && lead.unitTypeDef && lead.unitTypeDef.displayName)
      || 'Unit';
    const typeName = unit.isUndead ? `Skeleton ${baseName}` : baseName;
    // Consumed by the mouseenter listener installed in _createCard.
    // The native `title` attribute is deliberately NOT set — the browser
    // would render its own unstylable tooltip alongside the custom one.
    // Storing on the dataset lets the text change (custom name, undead
    // flag) without reattaching listeners.
    card.el.dataset.tooltipName = typeName;

    this._updateBars(card, unit);
  }

// Restarts the red outline pulse. Removing the class and forcing a
  // reflow is the standard way to replay a CSS animation on the same
  // element; it only happens on frames where a unit actually lost soldiers.
  _flashHit(card) {
    card.el.classList.remove('army-card-hit');
    void card.el.offsetWidth;
    card.el.classList.add('army-card-hit');
  }

// Groups the player's cards by unit type. The new order is stored in
  // ArmyBarOrder; the next update() frame re-sorts the DOM from it.
  _sortByType() {
    const units = Array.from(this.unitById.values())
      .filter((u) => u.teamId === this.playerTeamId);
    this.order.sortByKey(units, (u) => this._typeKey(u));
  }

  // Sort key for a unit: its type's display name, skeletons grouped
  // together under "Skeleton ...". Same lookup as _installIcon.
  _typeKey(unit) {
    const lead = unit.soldiers && unit.soldiers[0];
    const name = (lead && lead.unitTypeDef && lead.unitTypeDef.displayName) || '';
    return (unit.isUndead ? 'Skeleton ' : '') + name;
  }

// Card click. The second click of a double-click is left to the dblclick
  // handler, so a double-click does not also run the squad / single toggle.
  // The selection rules themselves live in ArmyBarActions.clickCard.
  _handleCardClick(unitId, e) {
    if (e.detail >= 2) return;
    const u = this.unitById.get(unitId);
    if (!u) return;

    const squadId = this.squads.squadIdFor(unitId);
    if (squadId === undefined) {
      this.actions.clickCard(u, e.shiftKey, null, false);
      return;
    }
    this.actions.clickCard(
      u,
      e.shiftKey,
      this._squadUnits(squadId),
      this.squads.get(squadId).collapsed
    );
  }

  // Double-click recentres the camera on the unit. Shift+double-click
  // selects every unit of the same type instead.
  _handleCardDoubleClick(unitId, e) {
    const u = this.unitById.get(unitId);
    if (!u) return;
    if (e.shiftKey) {
      this.actions.selectSameType(u, (x) => this._typeKey(x));
      return;
    }
    if (this.onUnitFocus) this.onUnitFocus(u);
  }

  // Every Unit of the squad, hidden (collapsed) ones included.
  _squadUnits(squadId) {
    const units = [];
    for (const id of this._displayIds) {
      if (this.squads.squadIdFor(id) !== squadId) continue;
      const u = this.unitById.get(id);
      if (u) units.push(u);
    }
    return units;
  }

  // Which cards may be a drop target for what is being dragged. Called by
  // ArmyBarDrag while the pointer moves, so invalid targets never show the
  // drop indicator.
  _isValidDropTarget(kind, id, targetUnitId) {
    const targetSquad = this.squads.squadIdFor(targetUnitId);
    if (kind === 'squad') return targetSquad !== id;
    if (id === targetUnitId) return false;

    // A locked squad moves as a block, so its own cards are not targets.
    const ownSquad = this.squads.squadIdFor(id);
    if (ownSquad !== undefined && this.squads.isLocked(ownSquad)) {
      return targetSquad !== ownSquad;
    }
    return true;
  }

  // Toolbar - / + buttons. Clearing the layout key makes the next update()
  // recompute the layout with the new zoom.
  _changeZoom(direction) {
    if (!this.zoom.step(direction)) return;
    this._layoutKey = '';
    this._overlayDirty = true;
  }

// Routes a finished drag to the reorderer. _displayIds is what the
  // player sees right now, including cards hidden inside collapsed squads.
  _handleDrop(drop) {
    if (drop.kind === 'squad') {
      this.reorderer.dropSquad(drop.id, drop.targetId, drop.placeAfter, this._displayIds);
    } else {
      this.reorderer.dropCard(drop.id, drop.targetId, drop.placeAfter, this._displayIds);
    }
  }

  // Toolbar "make squad" button: the selected cards become one squad.
  _createSquadFromSelection() {
    const ids = this._displayIds.filter((id) => {
      const u = this.unitById.get(id);
      return u && u.selected;
    });
    if (ids.length === 0) return;
    // Make the stored order match the screen so the squad forms where its
    // first selected card already is.
    this.order.normalize(this._displayIds);
    this.squads.create(ids);
  }

  // Squad tab click: select every member, hidden ones included.
_selectSquad(squadId, additive) {
    this.actions.selectUnits(this._squadUnits(squadId), additive);
  }

  // A collapsed squad shows only its first card; the rest get display:none.
  // Returns the number of visible cards, which is what the layout needs.
  // Styles are written only when a card's hidden state actually changes.
  _applyCollapse(arranged) {
    let visible = 0;
    const collapsedSeen = new Set();
    for (const unit of arranged) {
      const card = this.cardByUnitId.get(unit.id);
      const squadId = this.squads.squadIdFor(unit.id);
      let hidden = false;
      if (squadId !== undefined && this.squads.get(squadId).collapsed) {
        if (collapsedSeen.has(squadId)) hidden = true;
        else collapsedSeen.add(squadId);
      }
      if (card.hidden !== hidden) {
        card.hidden = hidden;
        card.el.style.display = hidden ? 'none' : '';
        this._overlayDirty = true;
      }
      if (!hidden) visible++;
    }
    return visible;
  }

  // Refreshes the toolbar and squad frames, but only when something that
  // affects them changed (see _overlayDirty). Bar visibility is read from
  // the inline style main.js toggles in turn-based local multiplayer.
_refreshExtras() {
    const hidden = this.root.style.display === 'none';
    if (hidden !== this._wasHidden) {
      this._wasHidden = hidden;
      this._overlayDirty = true;
    }
    if (this.squads.version !== this._squadsVersion) {
      this._squadsVersion = this.squads.version;
      this._overlayDirty = true;
    }
    if (!this._overlayDirty) return;
    this._overlayDirty = false;

    if (hidden) {
      this.toolbar.hide();
      this.overlay.clear();
      return;
    }

    // Leave room above the bar for squad tabs only when squads exist.
    this.toolbar.position(this.squads.size > 0 ? 19 : 2);

    const cards = this._displayIds.map((id) => {
      const card = this.cardByUnitId.get(id);
      return { unitId: id, el: card.el, hidden: !!card.hidden };
    });
    this.overlay.render(cards);
  }

// Detaches the document-level hotkey listener. ArmyBarHotkeys also
  // replaces any previous instance on attach(), so forgetting to call this
  // between battles does not stack listeners.
dispose() {
    this.hotkeys.dispose();
    this.drag.dispose();
    this.toolbar.dispose();
    this.overlay.dispose();
    this.root.removeEventListener('scroll', this._onScroll);
    if (viewByRoot.get(this.root) === this) viewByRoot.delete(this.root);
  }

// Averages morale and fatigue across the unit's LIVING soldiers —
  // routing / shattered soldiers included, since a routing soldier
  // draining the unit's morale is exactly the state a player needs to
  // see. Dead soldiers are excluded: their morale is meaningless, and
  // including them would make a unit that has taken heavy casualties
  // read as "healthy morale" because the soldiers who broke are gone.
  //
  // Morale ceiling is per-soldier (race maxMoraleMultiplier — goblins
  // cap at 70, humans at 100), so the fraction is computed against the
  // average of the LIVING soldiers' own maxMorale, not the universal
  // 100. A goblin unit at 70/70 reads as 100%, matching the health of
  // the unit rather than penalising the race's lower ceiling.
  //
  // Fatigue has a universal 100 ceiling for all soldiers and races, so
  // it reads straight against the global max.
  _updateBars(card, unit) {
    const aliveSoldiers = unit.getAliveSoldiers();

    // Morale bar.
    if (this._showMoraleBar) {
      card.moraleBarEl.style.display = '';
      if (aliveSoldiers.length > 0) {
        let moraleSum = 0;
        let maxMoraleSum = 0;
        for (const s of aliveSoldiers) {
          moraleSum += s.morale;
          maxMoraleSum += (s.maxMorale ?? 100);
        }
        const frac = maxMoraleSum > 0
          ? Math.max(0, Math.min(1, moraleSum / maxMoraleSum))
          : 0;
        card.moraleFillEl.style.width = (frac * 100).toFixed(1) + '%';

        // Three-band colour, matching UnitInfoPanel's HP bar bands.
        // Toggling both classes with a boolean rather than className
        // assignment so a re-render does not clobber the base class.
        card.moraleFillEl.classList.toggle('band-hurt', frac <= 0.6 && frac > 0.3);
        card.moraleFillEl.classList.toggle('band-critical', frac <= 0.3);
      } else {
        card.moraleFillEl.style.width = '0%';
        card.moraleFillEl.classList.remove('band-hurt', 'band-critical');
      }
    } else {
      card.moraleBarEl.style.display = 'none';
    }

    // Fatigue bar.
    if (this._showFatigueBar) {
      card.fatigueBarEl.style.display = '';
      if (aliveSoldiers.length > 0) {
        let fatigueSum = 0;
        for (const s of aliveSoldiers) fatigueSum += s.fatigue;
        const frac = Math.max(0, Math.min(1, fatigueSum / aliveSoldiers.length / 100));
        card.fatigueFillEl.style.width = (frac * 100).toFixed(1) + '%';
      } else {
        card.fatigueFillEl.style.width = '0%';
      }
    } else {
      card.fatigueBarEl.style.display = 'none';
    }

    // Champion HP bar. Only the champion's card carries the elements
    // (see _createCard); a null pair means this is a normal unit and
    // there is nothing to update.
    //
    // The bar follows the same visibility gate as the standard pair —
    // if the player has turned off morale and fatigue, the champion bar
    // hides too. A lone red bar on an otherwise empty card would read
    // as a rendering bug.
    if (card.championHpBarEl && card.championHpFillEl) {
      const champ = unit.championSoldier;
      const barsAllowed = this._showMoraleBar || this._showFatigueBar;
      const show = barsAllowed && champ && champ.isAlive();
      card.championHpBarEl.style.display = show ? '' : 'none';
      if (show) {
        const frac = champ.maxHp > 0
          ? Math.max(0, Math.min(1, champ.hp / champ.maxHp))
          : 0;
        card.championHpFillEl.style.width = (frac * 100).toFixed(1) + '%';
      }
    }

    // Hide the whole bars container when neither bar is enabled — saves
    // a stacking layer and a layout row on every card when the player
    // has turned both off.
    card.barsEl.style.display =
      (this._showMoraleBar || this._showFatigueBar) ? '' : 'none';
  }

  // White-flag indicator. MoraleSystem is per-soldier, so the count is
  // per-soldier too — a unit that is half-collapsed still reads correctly
  // at a glance without the card needing a separate ratio bar.
  _routingCount(unit) {
    let n = 0;
    for (const s of unit.soldiers) {
      if (s.isAlive() && s.isRouting) n++;
    }
    return n;
  }

  // Picks the single most significant activity for the unit, highest
  // priority first. One glyph per card keeps the top-right corner readable
  // at a glance — multiple simultaneous activities would be noise.
  _activityFor(unit) {
    const soldiers = unit.getAliveSoldiers();
    if (soldiers.length === 0) return 'dead';

    let engaged = false;
    let ranged = false;
    let impetuous = false;
    let rallying = false;

    for (const s of soldiers) {
      if (s.state === 'engaged' || s.state === 'staggered') engaged = true;
      else if (s.state === 'ranged') ranged = true;
      if (s.state === 'impetuous' || s.isImpetuous) impetuous = true;
      if (s.rallyTargetId) rallying = true;
    }

    if (engaged) return 'engaged';
    if (ranged) return 'ranged';
    if (impetuous) return 'impetuous';
    if (unit.focusTargetUnitId) return 'attacking';
    if (rallying) return 'rallying';
    if (unit.hasActiveOrder) return 'marching';
    return 'idle';
  }
}
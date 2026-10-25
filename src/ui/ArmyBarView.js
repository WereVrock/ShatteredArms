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

import { unitIconSvg } from './UnitIcon.js';
import { attachRankBadge } from './UnitRank.js';
import { SettingsStore } from './settings/SettingsStore.js';

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

    this.root = rootElement;
    this.selectionController = selectionController;
    this.playerTeamId = playerTeamId;
    this.onUnitFocus = onUnitFocus;

    // Optional. Right-clicking a card invokes this with (unit, cardElement),
    // so the caller can open a details panel anchored to that card. Null
    // means right-clicking does nothing beyond suppressing the browser's
    // context menu — the bar still works when constructed without it.
    this.onUnitInfo = null;

    // unitId -> { el, flagEl, iconEl, imageEl, countEl }
    this.cardByUnitId = new Map();
    // unitId -> Unit, refreshed every update() so the click handler never
    // holds a stale reference to a unit object.
    this.unitById = new Map();
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

    const orderedChildren = [];
    const seen = new Set();

    for (const unit of units) {
      if (unit.teamId !== this.playerTeamId) continue;

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

    this._syncChildOrder(orderedChildren);
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

    const countEl = document.createElement('span');
    countEl.className = 'army-card-count';
    countEl.textContent = '0/0';

    el.appendChild(flagEl);
    el.appendChild(iconEl);
    el.appendChild(imageEl);
    el.appendChild(countEl);

    // Click → select. Shift-click → add to selection. Matches the canvas
    // selection rules exactly (see SelectionController._handleSingleClick).
    el.addEventListener('click', (e) => {
      const u = this.unitById.get(unit.id);
      if (!u) return;
      this.selectionController.selectUnit(u, e.shiftKey);
    });

    // Double-click → recenter the camera on this unit. Selection still
    // happens (dblclick fires after the second click), so double-clicking
    // both selects and focuses — which is what you want: the card you just
    // centred on is also the one your next order will apply to.
    //
    // onUnitFocus is optional so the view still works when constructed
    // without it (e.g. in tests or a future non-3D context).
    el.addEventListener('dblclick', () => {
      const u = this.unitById.get(unit.id);
      if (!u) return;
      if (this.onUnitFocus) this.onUnitFocus(u);
    });

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

    this.root.appendChild(el);

    return {
      el, flagEl, iconEl, imageEl, countEl,
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

  _updateCard(card, unit) {
    const alive = unit.getAliveSoldiers().length;
    const total = unit.soldiers.length;
    const routingCount = this._routingCount(unit);
    const activity = this._activityFor(unit);
    const defeated = alive === 0;

    card.el.classList.toggle('routing', routingCount > 0);
    card.el.classList.toggle('selected', !!unit.selected);
    card.el.classList.toggle('dead', defeated);

    card.flagEl.textContent = routingCount > 0 ? `⚑ ${routingCount}` : '';
    card.countEl.textContent = `${alive} / ${total}`;
    card.iconEl.textContent = ACTIVITY_ICON[activity] || '';
    card.iconEl.title = ACTIVITY_LABEL[activity] || '';

    // Unit has no unitTypeDef — its type comes from the soldiers. See
    // _installIcon for the same lookup. customName (set on champion
    // units at battle-build time) overrides the type's displayName.
    const lead = unit.soldiers && unit.soldiers[0];
    const baseName = unit.customName
      || (lead && lead.unitTypeDef && lead.unitTypeDef.displayName)
      || 'Unit';
    const typeName = unit.isUndead ? `Skeleton ${baseName}` : baseName;
    card.el.title = `${typeName} #${unit.id} (${unit.teamId}) — `
      + `${ACTIVITY_LABEL[activity] || activity}, ${alive}/${total}`
      + (routingCount > 0 ? ` — ${routingCount} routing` : '');

    this._updateBars(card, unit);
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
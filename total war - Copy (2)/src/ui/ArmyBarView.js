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

export class ArmyBarView {
  // `onUnitFocus` is optional. When supplied, double-clicking a card calls
  // it with the Unit — main.js wires this to sceneSetup so the camera
  // recenters on the unit. Kept as a callback rather than passing
  // sceneSetup in directly: this class is pure UI and must not know about
  // the 3D scene, per the project's UI-logic separation rule.
  constructor(rootElement, selectionController, playerTeamId, onUnitFocus = null) {
    this.root = rootElement;
    this.selectionController = selectionController;
    this.playerTeamId = playerTeamId;
    this.onUnitFocus = onUnitFocus;

    // unitId -> { el, flagEl, iconEl, imageEl, countEl }
    this.cardByUnitId = new Map();
    // unitId -> Unit, refreshed every update() so the click handler never
    // holds a stale reference to a unit object.
    this.unitById = new Map();
  }

  update(units) {
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

    this.root.appendChild(el);

    return { el, flagEl, iconEl, imageEl, countEl };
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
    // _installIcon for the same lookup.
    const lead = unit.soldiers && unit.soldiers[0];
    const baseName = (lead && lead.unitTypeDef && lead.unitTypeDef.displayName) || 'Unit';
    const typeName = unit.isUndead ? `Skeleton ${baseName}` : baseName;
    card.el.title = `${typeName} #${unit.id} (${unit.teamId}) — `
      + `${ACTIVITY_LABEL[activity] || activity}, ${alive}/${total}`
      + (routingCount > 0 ? ` — ${routingCount} routing` : '');
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
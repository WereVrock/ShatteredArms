// ===== UnitInfoPanel.js =====
// Player-facing details panel for one unit. Opened by right-clicking a card
// in the army bar (see ArmyBarView's onUnitInfo callback), closed by
// clicking outside, pressing Escape, or clicking the panel's own close
// button.
//
// Layout follows the Total War unit-card convention. Top to bottom:
//   - Header: portrait + name + team label.
//   - Vitals: strength (count + HP bar), morale bar, fatigue bar, shield
//     bar (when the unit carries shields).
//   - Battle record: kills this battle, with a muted friendly-fire suffix
//     when the unit has any.
//   - Combat: damage, attack speed, to-hit (melee) or spread (ranged),
//     and range.
//   - Notes: a short tactical summary read verbatim from the unit type's
//     `description` field.
//   - Traits: qualitative capabilities (undead, dirty fighting,
//     expendable) derived from the race record and the unit's isUndead
//     flag.
//
// Deliberately NOT a debug list. Internal ids, AI intent, focus-fire
// targets, formation coordinates, and tactical state tags do not appear
// here — they belong to the G+click debug flow, not the player UI.
//
// Name construction: [race or undead] + unit type's displayName. Race is
// read from unitTypeDef.race ('human' / 'goblin'); undead overrides the
// race label because an undead soldier's body is the defining trait, not
// its species. displayName fields in UnitTypes.js are expected to be
// race-agnostic (bare "Spearman", not "Human Spearman") so this prefix
// is the only place the race is spelled out.
//
// Combat stats are derived from CombatConfig + WeaponMatchup + the race
// record, so the panel always agrees with what the sim actually does. If
// a matchup number changes, the panel reflects it on the next render.
//
// Positioning: fixed to the LEFT side of the viewport, vertically
// centered, with a max-height so a tall panel scrolls rather than
// overflowing a short window. It does NOT anchor to the card that
// opened it — the army bar and the panel both live on-screen, and a
// fixed position keeps the panel from jumping around as the bar rewraps
// or the card is scrolled. The card reference is still accepted by
// open() for API compatibility but is not used for layout.
//
// Live-updating: while open, the panel re-renders every frame via an
// internal requestAnimationFrame loop that starts on open and stops on
// close. There is zero cost when the panel is not visible.
//
// Styling is injected once into document.head (see ensureStyles). Palette
// matches PauseMenuPanel / SettingsPanel / CommandBarView so all the in-
// game chrome reads as one family.
import { CombatConfig, WeaponMatchup } from '../config/CombatConfig.js';
import { raceOf, raceHasProperty } from '../config/RaceConfig.js';
import { Property } from '../config/Properties.js';
import { unitHasClass, UnitClass, getRangedRange, isCavalry } from '../config/UnitClasses.js';
import { unitIconSvg } from './UnitIcon.js';

// --- inline icons ----------------------------------------------------------
// Small glyph set, each an SVG string with currentColor so the container
// decides the colour. Kept as module constants rather than a helper per
// icon so the whole set reads as one table.

const ICON_STRENGTH = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <circle cx="12" cy="7" r="3.6"/>
  <path d="M5.5 22 C5.5 16.5 8.4 13.5 12 13.5 C15.6 13.5 18.5 16.5 18.5 22 Z"/>
</svg>`;

const ICON_MORALE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 21 C12 21 3 14.2 3 8.8 C3 6 5 4 7.6 4 C9.5 4 11.1 5.2 12 6.8 C12.9 5.2 14.5 4 16.4 4 C19 4 21 6 21 8.8 C21 14.2 12 21 12 21 Z"/>
</svg>`;

const ICON_FATIGUE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 2.5 C8 7.5 6 10.8 6 14 a6 6 0 0 0 12 0 C18 10.8 16 7.5 12 2.5 Z"/>
</svg>`;

const ICON_SHIELD = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 2 L21 5.5 V12 C21 17 17 20.5 12 22 C7 20.5 3 17 3 12 V5.5 Z"/>
</svg>`;

// Skull silhouette. Solid shape with no eye cutouts — reads cleanly at
// the stat-row icon size and avoids hardcoding a panel-background colour
// just to punch two holes in it.
const ICON_KILLS = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 2 C7.6 2 4 5.4 4 9.8 C4 12.2 5.1 14.3 6.9 15.6 L6.9 19.5 C6.9 20.6 7.8 21.5 8.9 21.5 L15.1 21.5 C16.2 21.5 17.1 20.6 17.1 19.5 L17.1 15.6 C18.9 14.3 20 12.2 20 9.8 C20 5.4 16.4 2 12 2 Z"/>
</svg>`;

const ICON_TRAIT = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 2 L22 12 L12 22 L2 12 Z"/>
</svg>`;

// Player-facing labels for the sim's weapon ids. The sim identifies
// weapons by a bare string (WeaponMatchup keys); this table is the only
// place that string is turned into a readable label, so a new weapon
// type added to CombatConfig only needs one entry here. Falls back to
// the raw id so a future weapon that hasn't been labelled yet still
// shows something rather than a blank row.
const WEAPON_NAMES = {
  sword: 'Sword',
  spear: 'Spear',
  bow:   'Bow',
  lance: 'Lance'
};

// Prose tooltips for the Combat section's Weapon row. The tooltip is a
// DISPLAY MIRROR of sim behaviour. The contract that says "if you change
// the sim, update the tooltip" lives at the sim sites themselves —
// search for "TOOLTIP MIRROR" in src/config/CombatConfig.js,
// src/sim/CombatResolutionSystem.js, and src/sim/ProjectileSystem.js.
// This block is only the inverse pointer.
const WEAPON_TOOLTIPS = {
  sword:
    'A fast weapon — short cooldown and a high attack-speed multiplier. '
    + 'Its defining matchup is the undead: a sword striking a skeleton '
    + 'from the flank kills it instantly, bypassing shield block '
    + 'entirely. Its weakness is a frontal attack on a spearman, where '
    + 'damage is cut to a third and the speed advantage is lost.',
  spear:
    'A slow, defensive weapon. A stationary spear facing a cavalry '
    + 'charge braces: the charge\'s bonus damage and throw are both '
    + 'cancelled, and the spear deals counter damage to the horseman. '
    + 'Spear damage is boosted against cavalry. The spear wall is a '
    + 'formation property — flank geometry is measured against the '
    + 'unit\'s facing, not the individual soldier\'s, so a spearman who '
    + 'pivots to face a flanker does not restore the wall.',
  bow:
    'A ranged weapon. Arrows are simulated as physical projectiles and '
    + 'hit whatever soldier they reach — there is no to-hit roll at '
    + 'impact, unlike melee. Arrows are easier to block than melee '
    + 'thrusts, so shielded defenders absorb a lot of archer fire; '
    + 'unshielded targets take the full brunt.',
  lance:
    'A cavalry charge weapon. Bonus damage scales with the '
    + 'attacker-to-defender mass ratio, and on a qualifying charge hit '
    + 'the defender is thrown and knocked down. Outside a charge a '
    + 'lance is just a slow melee weapon.'
};

// --- trait metadata --------------------------------------------------------
// Display strings for each Property id. Kept in the UI layer rather than
// on Property itself, because the sim never needs a human-readable
// description — only the panel does. A property declared in Properties.js
// with no entry here renders with its raw id as a label, so a new property
// is never silently invisible, just less polished until someone adds an
// entry.
//
// Descriptions are short player-facing summaries of the mechanical effect,
// not the full rules text. See the doc comment in Properties.js for the
// authoritative contract, and the consumer system for the actual numbers.

const PROPERTY_INFO = {
  [Property.UNDEAD]: {
    label: 'Undead',
    description: 'Does not rout.'
  },
  [Property.DIRTY_FIGHTING]: {
    label: 'Dirty Fighting',
    description: 'Extra damage from side and rear hits, less from the front.'
  },
  [Property.EXPENDABLE]: {
    label: 'Expendable',
    description: 'Its rout does not spread panic to nearby allies.'
  }
};

function propertyInfo(id) {
  return PROPERTY_INFO[id] || { label: id, description: '' };
}

// --- helpers ---------------------------------------------------------------

// Drop the decimal place on a whole number so "12" reads as "12" and
// "7.2" reads as "7.2". Avoids both "12.0" (which looks like a rounding
// artefact) and full precision (which shows noise like "11.999999").
function fmtStat(n) {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// --- styles ----------------------------------------------------------------

const STYLE_ID = 'unit-info-panel-styles';

const STYLE_TEXT = `
  .uip {
    position: fixed;
    left: 24px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 35;
    width: 480px;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    overflow-x: hidden;
    background: #1a1f28;
    border: 1px solid #3a4a5e;
    border-radius: 10px;
    box-shadow:
      0 16px 44px rgba(0,0,0,0.7),
      0 0 0 1px rgba(0,0,0,0.4),
      inset 0 1px 0 rgba(255,255,255,0.04);
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    color: #e0e8f0;
    font-size: 16px;
    line-height: 1.5;
    user-select: none;
  }

  /* Thin scrollbar so a scrolled panel does not look broken against the
     panel background. Firefox uses scrollbar-width, WebKit uses the
     ::-webkit-scrollbar pseudo-elements; both are applied so the panel
     reads consistently across browsers. */
  .uip {
    scrollbar-width: thin;
    scrollbar-color: #3a4a5e #1a1f28;
  }
  .uip::-webkit-scrollbar { width: 10px; }
  .uip::-webkit-scrollbar-track { background: #1a1f28; }
  .uip::-webkit-scrollbar-thumb {
    background: #3a4a5e;
    border-radius: 5px;
    border: 2px solid #1a1f28;
  }

  /* ---------- header ---------- */

  .uip-header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 16px 16px 22px;
    background:
      linear-gradient(180deg, #262e3b 0%, #1c222c 100%);
    border-bottom: 1px solid #2a3544;
    border-radius: 10px 10px 0 0;
  }

  /* Left-edge team stripe. 4px accent that reads as "whose card this is"
     without needing a colour wash across the whole header. */
  .uip-team-stripe {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    border-radius: 10px 0 0 0;
  }
  .uip-team-stripe.blue { background: linear-gradient(180deg, #4a80b8, #2a5580); }
  .uip-team-stripe.red  { background: linear-gradient(180deg, #b84a4a, #802a2a); }

  .uip-portrait {
    flex-shrink: 0;
    width: 72px;
    height: 72px;
    border-radius: 8px;
    background:
      radial-gradient(circle at 50% 35%, #2a3544 0%, #10151d 100%);
    border: 1px solid #3a4a5e;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 10px rgba(0,0,0,0.5);
  }
  .uip-portrait svg {
    width: 80%;
    height: 80%;
    display: block;
  }

  .uip-identity {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* Name wraps rather than truncating — a two-line name is better than
     "Human Veteran Spearman" chopped to "Human Veteran Spe…". The header
     uses align-items: center, so the portrait stays vertically centred
     on a wrapped name. */
  .uip-name {
    font-size: 22px;
    font-weight: 700;
    color: #eef2f8;
    letter-spacing: 0.3px;
    line-height: 1.2;
    word-break: break-word;
  }

  .uip-meta {
    font-size: 13px;
    color: #7a8a9e;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    margin-top: 5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .uip-meta .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin: 0 7px 1px 0;
    vertical-align: middle;
  }
  .uip-meta .dot.blue { background: #4a80b8; }
  .uip-meta .dot.red  { background: #b84a4a; }

  .uip-close {
    flex-shrink: 0;
    align-self: flex-start;
    background: transparent;
    border: none;
    color: #6a7a8e;
    font-size: 30px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    margin-top: -4px;
    font-family: inherit;
    transition: color 0.1s;
  }
  .uip-close:hover { color: #eef2f8; }

  /* ---------- body ---------- */

  .uip-body {
    padding: 18px 20px 20px;
  }

  /* Shared chrome for every titled section below the vitals block. Each
     section is separated from the one above by a thin rule, so the panel
     reads as a stack of related blocks rather than one undifferentiated
     wall of rows. The kills row is also a section — it just has no title. */
  .uip-section {
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px solid #2a3544;
  }
  .uip-section-title {
    font-size: 12px;
    color: #8a9ab0;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    margin-bottom: 12px;
  }

  /* ---------- strength block ---------- */

  .uip-strength {
    display: grid;
    grid-template-columns: 34px 1fr auto;
    grid-template-rows: auto auto;
    align-items: center;
    column-gap: 14px;
    row-gap: 8px;
    margin-bottom: 18px;
  }

  .uip-strength-icon {
    grid-row: 1 / 3;
    width: 34px;
    height: 34px;
    color: #9aacbf;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .uip-strength-icon svg { width: 100%; height: 100%; display: block; }

  .uip-strength-label {
    font-size: 12px;
    color: #7a8a9e;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    align-self: end;
  }

  .uip-strength-count {
    grid-row: 2 / 3;
    grid-column: 3 / 4;
    font-size: 28px;
    font-weight: 700;
    color: #eef2f8;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    align-self: end;
  }
  .uip-strength-count .total {
    color: #7a8a9e;
    font-weight: 500;
    font-size: 18px;
    margin-left: 4px;
  }

  /* HP bar spans the row below, full width of the grid. */
  .uip-strength-bar {
    grid-column: 1 / 4;
    grid-row: 3 / 4;
    height: 9px;
    background: #10151d;
    border-radius: 4px;
    overflow: hidden;
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);
  }

  .uip-strength-fill {
    height: 100%;
    border-radius: 4px;
    background: linear-gradient(90deg, #8a2a2a 0%, #d06a6a 100%);
    transition: width 0.15s linear, background 0.15s linear;
  }
  .uip-strength-fill.healthy { background: linear-gradient(90deg, #4a8a4a 0%, #8ad08a 100%); }
  .uip-strength-fill.hurt    { background: linear-gradient(90deg, #8a6a2a 0%, #d0b06a 100%); }

  /* ---------- stat rows (morale / fatigue / shield) ---------- */

  .uip-stat {
    display: grid;
    grid-template-columns: 24px 1fr auto;
    align-items: center;
    column-gap: 14px;
    row-gap: 6px;
    margin-bottom: 14px;
  }

  .uip-stat-icon {
    width: 24px;
    height: 24px;
    color: #8a9ab0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .uip-stat-icon svg { width: 100%; height: 100%; display: block; }

  .uip-stat-label {
    font-size: 12px;
    color: #8a9ab0;
    letter-spacing: 1.4px;
    text-transform: uppercase;
  }

  .uip-stat-value {
    font-size: 16px;
    color: #dde5ee;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .uip-stat-value .total {
    color: #7a8a9e;
    font-weight: 500;
  }

  .uip-stat-bar {
    grid-column: 2 / 4;
    grid-row: 2 / 3;
    height: 7px;
    background: #10151d;
    border-radius: 3px;
    overflow: hidden;
    box-shadow: inset 0 1px 1px rgba(0,0,0,0.5);
  }

  .uip-stat-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.15s linear;
  }
  .uip-stat-morale  .uip-stat-fill { background: linear-gradient(90deg, #4a9a4a 0%, #7ad07a 100%); }
  .uip-stat-fatigue .uip-stat-fill { background: linear-gradient(90deg, #9a7a3a 0%, #d0b06a 100%); }
  .uip-stat-shield  .uip-stat-fill { background: linear-gradient(90deg, #3a6a9a 0%, #6aa0d0 100%); }

  /* ---------- kills row ---------- */
  /* Icon + label + value, no bar. The value may carry a muted "friendly"
     suffix when the unit has any friendly-fire kills. */

  .uip-kills {
    display: grid;
    grid-template-columns: 24px 1fr auto;
    align-items: center;
    column-gap: 14px;
  }

  .uip-kills-icon {
    width: 24px;
    height: 24px;
    color: #9aacbf;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .uip-kills-icon svg { width: 100%; height: 100%; display: block; }

  .uip-kills-label {
    font-size: 12px;
    color: #8a9ab0;
    letter-spacing: 1.4px;
    text-transform: uppercase;
  }

  .uip-kills-value {
    font-size: 20px;
    color: #eef2f8;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .uip-kills-value .friendly {
    color: #9a6a3a;
    font-weight: 500;
    font-size: 14px;
    margin-left: 10px;
    letter-spacing: 0.3px;
  }

  /* ---------- combat stats ---------- */
  /* Two-column label/value rows. No icon, no bar — these are read as a
     small block of numbers, not as meters. */

  .uip-combat-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    column-gap: 14px;
    padding: 4px 0;
  }

  .uip-combat-label {
    font-size: 15px;
    color: #8a9ab0;
    letter-spacing: 0.6px;
  }

  .uip-combat-value {
    font-size: 16px;
    color: #dde5ee;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .uip-combat-value .unit {
    color: #7a8a9e;
    font-weight: 500;
    font-size: 12px;
    margin-left: 4px;
  }

  /* ---------- progression (level + XP bar) ---------- */
  /* Gold fill — deliberately distinct from every other bar in the panel
     (red HP, green morale, tan stamina, blue shield) so a player reads
     this as a progression track, not as a combat resource. Only shown
     for campaign units whose roster entry carries level/XP. */

  .uip-progression {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    column-gap: 14px;
    row-gap: 6px;
  }

  .uip-progression-label {
    font-size: 12px;
    color: #8a9ab0;
    letter-spacing: 1.4px;
    text-transform: uppercase;
  }

  .uip-progression-value {
    font-size: 16px;
    color: #dde5ee;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .uip-progression-value .level {
    color: #e0c060;
    font-weight: 700;
  }

  .uip-progression-bar {
    grid-column: 1 / 3;
    height: 7px;
    background: #10151d;
    border-radius: 3px;
    overflow: hidden;
    box-shadow: inset 0 1px 1px rgba(0,0,0,0.5);
  }

  .uip-progression-fill {
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, #9a7a1a 0%, #e0c060 100%);
    transition: width 0.15s linear;
  }

  /* ---------- notes (unit type description) ---------- */

  .uip-description {
    font-size: 15px;
    color: #aab8c8;
    line-height: 1.55;
  }

  /* ---------- traits ---------- */

  .uip-trait {
    display: grid;
    grid-template-columns: 18px 1fr;
    column-gap: 12px;
    row-gap: 4px;
    margin-bottom: 12px;
  }
  .uip-trait:last-of-type { margin-bottom: 0; }

  .uip-trait-icon {
    grid-row: 1 / 3;
    width: 18px;
    height: 18px;
    color: #7a8a9e;
    margin-top: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .uip-trait-icon svg { width: 100%; height: 100%; display: block; }

  .uip-trait-name {
    font-size: 16px;
    color: #dde5ee;
    font-weight: 600;
    line-height: 1.3;
  }

  .uip-trait-desc {
    font-size: 14px;
    color: #8a9ab0;
    line-height: 1.45;
  }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_TEXT;
  document.head.appendChild(el);
}

export class UnitInfoPanel {
  constructor() {
    ensureStyles();

    // The unit whose details are shown, or null when closed.
    this._unit = null;
    this._rafId = null;

    this.el = this._buildShell();
    this.el.style.display = 'none';
    document.body.appendChild(this.el);

    // Bound once so removeEventListener finds the same reference on close.
    // Click-away fires on any mouse button so right-clicking a different
    // card flows naturally: mousedown closes this panel, contextmenu opens
    // a fresh one on the new card within the same gesture.
    this._onDocMouseDown = (e) => {
      if (!this.el.contains(e.target)) this.close();
    };
    this._onKeyDown = (e) => {
      if (e.key === 'Escape') this.close();
    };
  }

  isOpen() {
    return this._unit !== null;
  }

  // Open (or re-open) the panel on `unit`. The `anchorEl` parameter is
  // accepted for API compatibility with the caller that passes the card
  // that was right-clicked, but it is NOT used for positioning — the
  // panel is fixed to the left of the viewport (see STYLE_TEXT), so the
  // card's screen position never affects layout.
  open(unit, anchorEl) {
    this._unit = unit;
    this.el.style.display = 'block';

    // Defer listener registration to the next tick so the opening
    // right-click cannot be caught as the click-away that closes it.
    // contextmenu fires after mousedown in every browser, but deferring
    // costs nothing and removes the ordering assumption entirely.
    setTimeout(() => {
      document.addEventListener('mousedown', this._onDocMouseDown);
      document.addEventListener('keydown', this._onKeyDown);
    }, 0);

    this._render();
    this._startRaf();
  }

  close() {
    if (!this._unit) return;
    this._unit = null;
    this.el.style.display = 'none';
    document.removeEventListener('mousedown', this._onDocMouseDown);
    document.removeEventListener('keydown', this._onKeyDown);
    this._stopRaf();
  }

  // --- shell ---------------------------------------------------------------

  // Builds the persistent outer chrome — team stripe, portrait, identity
  // block, close button, body container — ONCE. Each _render() rewrites
  // only the header text, the portrait's innerHTML, and the body's
  // innerHTML. The close button's listener lives on the node and is never
  // reattached, because the node is never replaced.
  _buildShell() {
    const el = document.createElement('div');
    el.className = 'uip';

    const header = document.createElement('div');
    header.className = 'uip-header';

    const stripe = document.createElement('div');
    stripe.className = 'uip-team-stripe';
    header.appendChild(stripe);

    const portrait = document.createElement('div');
    portrait.className = 'uip-portrait';
    header.appendChild(portrait);

    const identity = document.createElement('div');
    identity.className = 'uip-identity';
    const name = document.createElement('div');
    name.className = 'uip-name';
    const meta = document.createElement('div');
    meta.className = 'uip-meta';
    identity.appendChild(name);
    identity.appendChild(meta);
    header.appendChild(identity);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'uip-close';
    closeBtn.textContent = '\u00d7'; // multiplication sign, reads as an X
    closeBtn.title = 'Close (Esc)';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'uip-body';

    el.appendChild(header);
    el.appendChild(body);

    this._stripeEl = stripe;
    this._portraitEl = portrait;
    this._nameEl = name;
    this._metaEl = meta;
    this._bodyEl = body;

    return el;
  }

  // --- RAF -----------------------------------------------------------------

  _startRaf() {
    if (this._rafId !== null) return;
    const tick = () => {
      if (!this._unit) { this._rafId = null; return; }
      this._render();
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRaf() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  // --- render --------------------------------------------------------------

  _render() {
    const unit = this._unit;
    if (!unit) return;

    const soldiers = unit.soldiers || [];
    const alive = unit.getAliveSoldiers();
    const aliveCount = alive.length;
    const totalCount = soldiers.length;

    const lead = soldiers[0];
    const typeDef = (lead && lead.unitTypeDef) || null;

    // --- header ---
    this._stripeEl.className = `uip-team-stripe ${unit.teamId}`;
    this._nameEl.textContent = this._buildDisplayName(unit, typeDef);

    const teamLabel = unit.teamId === 'blue' ? 'Blue' : 'Red';
    this._metaEl.innerHTML =
      `<span class="dot ${unit.teamId}"></span>${teamLabel} army`;

    if (typeDef) {
      this._portraitEl.innerHTML = unitIconSvg(typeDef, unit.isUndead);
    } else {
      this._portraitEl.innerHTML = '';
    }

    // --- aggregates over living soldiers only ---
    // A depleted unit's stats reflect what is still fighting, not what
    // started — a battered 6/15 unit showing morale 40/100 is far less
    // informative than one showing 40/70 (its own living average ceiling).
    let hpSum = 0, hpMaxSum = 0;
    let moraleSum = 0, moraleMaxSum = 0;
    let fatigueSum = 0;
    let shieldSum = 0, shieldMaxSum = 0;
    let hasShieldAny = false;
    let killsSum = 0;
    let ffKillsSum = 0;

    for (const s of alive) {
      hpSum += s.hp;
      hpMaxSum += s.maxHp;
      moraleSum += s.morale;
      moraleMaxSum += s.maxMorale;
      fatigueSum += s.fatigue;
      if (s.hasShield) {
        hasShieldAny = true;
        shieldSum += s.shieldHp;
        shieldMaxSum += CombatConfig.shieldMaxHp;
      }
      // Per-soldier kill counters. `|| 0` fallbacks guard against a save
      // where the fields have not been backfilled — cheap safety, and the
      // row still reads cleanly as zero rather than NaN.
      killsSum += s.killsThisBattle || 0;
      ffKillsSum += s.friendlyFireKillsThisBattle || 0;
    }

    const avgHp        = aliveCount > 0 ? hpSum / aliveCount : 0;
    const avgHpMax     = aliveCount > 0 ? hpMaxSum / aliveCount : 1;
    const avgMorale    = aliveCount > 0 ? moraleSum / aliveCount : 0;
    const avgMoraleMax = aliveCount > 0 ? moraleMaxSum / aliveCount : 100;
    const avgFatigue   = aliveCount > 0 ? fatigueSum / aliveCount : 0;
    const avgShield    = aliveCount > 0 ? shieldSum / aliveCount : 0;
    const avgShieldMax = aliveCount > 0 ? shieldMaxSum / aliveCount : 1;

    const hpFrac = avgHpMax > 0 ? avgHp / avgHpMax : 0;
    const hpFillClass = hpFrac > 0.6 ? 'healthy' : (hpFrac > 0.3 ? 'hurt' : '');

    // --- body ---
    const bodyParts = [];

    // --- vitals ---
    bodyParts.push(
      `<div class="uip-strength">`
      + `<div class="uip-strength-icon">${ICON_STRENGTH}</div>`
      + `<div class="uip-strength-label">Strength</div>`
      + `<div class="uip-strength-count">${aliveCount}<span class="total"> / ${totalCount}</span></div>`
      + `<div class="uip-strength-bar">`
      +   `<div class="uip-strength-fill ${hpFillClass}" style="width:${(Math.max(0, Math.min(1, hpFrac)) * 100).toFixed(1)}%"></div>`
      + `</div>`
      + `</div>`
    );

    bodyParts.push(statRow('morale',  ICON_MORALE,  'Morale',  avgMorale,  avgMoraleMax));
    // UI NOTE: this stat is named "fatigue" throughout the sim and
    // config (Soldier.fatigue, CombatConfig.fatigue, RaceConfig
    // .fatigueDrainMultiplier, the showFatigueBar setting key, the
    // uip-stat-fatigue CSS class). Every PLAYER-FACING label calls it
    // "stamina" instead — the value is "stamina remaining" (100 =
    // fresh), and the negative framing of "fatigue" implies the
    // opposite. Renaming the sim field would be a wide, zero-behaviour
    // refactor; renaming only the label keeps the two vocabularies
    // separate on purpose. If a future label is added, use "stamina".
    bodyParts.push(statRow('fatigue', ICON_FATIGUE, 'Stamina', avgFatigue, 100));
    if (hasShieldAny) {
      bodyParts.push(statRow('shield', ICON_SHIELD, 'Shield', avgShield, avgShieldMax));
    }

    // --- battle record (kills this battle) ---
    const ffSuffix = ffKillsSum > 0
      ? `<span class="friendly">\u00b7 ${ffKillsSum} friendly</span>`
      : '';
    bodyParts.push(
      `<div class="uip-section">`
      + `<div class="uip-kills">`
      +   `<div class="uip-kills-icon">${ICON_KILLS}</div>`
      +   `<div class="uip-kills-label">Kills this battle</div>`
      +   `<div class="uip-kills-value">${killsSum}${ffSuffix}</div>`
      + `</div>`
      + `</div>`
    );

    // --- progression (campaign units only) ---
    const progressionSection = this._buildProgressionSection(unit);
    if (progressionSection) bodyParts.push(progressionSection);

    // --- combat stats ---
    bodyParts.push(this._buildCombatSection(typeDef, unit));

    // --- notes (unit type description) ---
    if (typeDef && typeDef.description) {
      bodyParts.push(
        `<div class="uip-section">`
        + `<div class="uip-section-title">Notes</div>`
        + `<div class="uip-description">${typeDef.description}</div>`
        + `</div>`
      );
    }

    // --- traits ---
    const traits = this._collectTraits(unit, typeDef);
    if (traits.length > 0) {
      const rows = traits.map(id => traitRow(id)).join('');
      bodyParts.push(
        `<div class="uip-section">`
        + `<div class="uip-section-title">Traits</div>`
        + rows
        + `</div>`
      );
    }

    this._bodyEl.innerHTML = bodyParts.join('');
  }

  // Builds the Combat section: damage, attack speed, to-hit or spread,
  // and range. Derived from WeaponMatchup + CombatConfig + the race
  // record so the panel always reflects what the sim actually does. If
  // any of those config numbers change, the panel reflects the new
  // values on the next render — no second source of truth to keep in
  // sync.
  //
  // Ranged units show "Spread" (rangedAccuracy, world units) instead of
  // "To Hit": an arrow's hit chance is decided by physical collision
  // against the target it reaches, not by a to-hit roll, so the melee
  // to-hit number does not apply. Spread is a scatter radius — lower is
  // tighter.
  _buildCombatSection(typeDef, unit) {
    if (!typeDef) return '';

    const matchup = WeaponMatchup[typeDef.weaponType];
    if (!matchup) return '';

    const isRanged = unitHasClass(typeDef, UnitClass.RANGED);
    const raceDamageMult = raceOf(typeDef).damageMultiplier;

    // Damage per landed hit. Race multiplier applied so a goblin's
    // reduced per-soldier output is visible without needing to know the
    // race number separately.
    const damage = matchup.damage * raceDamageMult;

    // Attack speed, expressed as seconds between attacks. Derived from
    // the same formula CombatResolutionSystem uses for melee cooldown,
    // and from rangedCooldownTicks for ranged units, so the panel reads
    // the sim's real rate rather than an approximate label.
    let attackSeconds;
    if (isRanged) {
      attackSeconds = CombatConfig.rangedCooldownTicks / CombatConfig.tickRateHz;
    } else {
      const speedMult = typeDef.attackSpeedMultiplier ?? 1;
      const cooldownTicks = Math.max(
        1,
        Math.round(CombatConfig.baseMeleeCooldownTicks / speedMult)
      );
      attackSeconds = cooldownTicks / CombatConfig.tickRateHz;
    }

    const moveSpeed = this._effectiveMoveSpeed(typeDef, !!(unit && unit.isUndead));

    const rows = [];
    const weaponKey = typeDef.weaponType;
    const weaponLabel = WEAPON_NAMES[weaponKey] || weaponKey || '\u2014';
    const weaponTooltip = WEAPON_TOOLTIPS[weaponKey] || '';
    rows.push(combatRow('Weapon', weaponLabel, weaponTooltip));
    rows.push(combatRow('Damage', fmtStat(damage)));
    rows.push(combatRow('Attack Speed', `${attackSeconds.toFixed(2)}<span class="unit">s</span>`));
    // Move speed shown in DESIGN space (before globalSpeedScale), so the
    // number is directly comparable across unit types. The live per-tick
    // value the sim uses is this × globalSpeedScale; showing the design
    // value keeps the panel readable and unit comparisons honest.
    rows.push(combatRow('Move Speed', `${fmtStat(moveSpeed)}<span class="unit">m/s</span>`));

    if (isRanged) {
      const spread = typeDef.rangedAccuracy ?? CombatConfig.arrow.defaultAccuracy;
      rows.push(combatRow('Spread', fmtStat(spread)));
      rows.push(combatRow('Range', `${getRangedRange(typeDef)}<span class="unit">m</span>`));
    } else {
      const toHit = CombatConfig.baseToHitChance * matchup.toHitMod;
      rows.push(combatRow('To Hit', `${Math.round(toHit * 100)}<span class="unit">%</span>`));
      rows.push(combatRow('Range', 'Melee'));
    }

    // Discipline tier. Read from the type's discipline field (defaulting
    // to 'normal') and resolved through CombatConfig.discipline so the
    // label is config-driven — see the displayName entries there. The
    // tier drives impetuous chance, formation shape floor, formation
    // jitter, and the scoring-side powerMultiplier, so it belongs in the
    // Combat section alongside the weapon stats rather than in Traits
    // (which is for boolean qualitative properties).
    const discKey = typeDef.discipline || 'normal';
    const discCfg = CombatConfig.discipline[discKey]
      || CombatConfig.discipline.normal;
    rows.push(combatRow('Discipline', discCfg.displayName || discKey));

    return `<div class="uip-section">`
      + `<div class="uip-section-title">Combat</div>`
      + rows.join('')
      + `</div>`;
  }

// Level + XP bar, rendered only for units the campaign battle builder
  // annotated with progression data (see CampaignBattleBuilder
  // .annotateUnitProgression). A standalone or custom battle unit does
  // not carry unitLevel, so this returns an empty string and no section
  // is emitted.
  //
  // The level shown is the UNIT's level (drives +10 max morale for melee
  // / 0.9^N accuracy for ranged), distinct from the champion's personal
  // level shown in ChampionPanelView.
  _buildProgressionSection(unit) {
    // Champion units display the champion's PERSONAL progression rather
    // than the unit-level track. The retinue still accrues unit XP (it
    // levels as a unit too), but the champion's own level and skill
    // points are the more useful read for a named character. The fields
    // are stamped on the unit at battle build time by
    // CampaignBattleBuilder.applyChampionToUnit.
    if (typeof unit.championLevel === 'number') {
      return this._buildChampionProgressionSection(unit);
    }
    if (typeof unit.unitLevel !== 'number') return '';

    const level = unit.unitLevel;
    const frac = typeof unit.unitXpFrac === 'number' ? unit.unitXpFrac : 0;
    const text = unit.unitXpText || '';

    return `<div class="uip-section">`
      + `<div class="uip-section-title">Veterancy</div>`
      + `<div class="uip-progression">`
      +   `<div class="uip-progression-label">Level</div>`
      +   `<div class="uip-progression-value"><span class="level">${level}</span></div>`
      +   `<div class="uip-progression-bar">`
      +     `<div class="uip-progression-fill" style="width:${(frac * 100).toFixed(1)}%"></div>`
      +   `</div>`
      +   `<div class="uip-progression-label">XP</div>`
      +   `<div class="uip-progression-value">${text}</div>`
      + `</div>`
      + `</div>`;
  }

  // Champion-side equivalent of the Veterancy section. Same visual shape
  // (level + progress bar + a right-hand label), but the numbers come
  // from the champion's personal XP/level rather than the unit's. The
  // right-hand label switches to "Skill points" when the champion has
  // unspent points, so an unspent-point situation is visible from the
  // unit info panel without opening the champion sheet.
  _buildChampionProgressionSection(unit) {
    const level = unit.championLevel;
    const frac = typeof unit.championXpFrac === 'number' ? unit.championXpFrac : 0;
    const text = unit.championXpText || '';
    const points = unit.championUnspentPoints || 0;
    const rightLabel = points > 0 ? 'Skill points' : 'XP';
    const rightValue = points > 0 ? String(points) : text;

    return `<div class="uip-section">`
      + `<div class="uip-section-title">Champion</div>`
      + `<div class="uip-progression">`
      +   `<div class="uip-progression-label">Level</div>`
      +   `<div class="uip-progression-value"><span class="level">${level}</span></div>`
      +   `<div class="uip-progression-bar">`
      +     `<div class="uip-progression-fill" style="width:${(frac * 100).toFixed(1)}%"></div>`
      +   `</div>`
      +   `<div class="uip-progression-label">${rightLabel}</div>`
      +   `<div class="uip-progression-value">${rightValue}</div>`
      + `</div>`
      + `</div>`;
  }

  // Effective design-space move speed for a unit type. Mirrors
  // Soldier.effectiveMoveSpeed exactly — shield penalty, spear penalty,
  // race multiplier, and (for undead foot) the skeleton shambling
  // penalty. Kept as a local helper rather than a shared export because
  // the panel is the only reader of "what would this unit's design
  // speed be if it were a live soldier" and pulling it into a config
  // module would push a data-shape concern into shared code.
  //
  // The panel does NOT read the individual soldier's effectiveMoveSpeed
  // directly: on a preview unit (card right-click) the soldiers are
  // synthetic and lack the getter. It mirrors the formula instead.
  //
  // `isUndead` is the UNIT's flag. Both live Units (Unit.isUndead) and
  // preview units (buildPreviewUnit sets `isUndead`) carry it, so the
  // same helper serves both code paths. Undead cavalry are exempt from
  // the shambling penalty — the same carve-out Soldier.effectiveMoveSpeed
  // makes.
  _effectiveMoveSpeed(typeDef, isUndead) {
    let speed = typeDef.hasShield
      ? typeDef.baseMoveSpeed * CombatConfig.shield.moveSpeedMult
      : typeDef.baseMoveSpeed;

    if (typeDef.weaponType === 'spear') {
      speed *= CombatConfig.spearHandling.moveSpeedMult;
    }

    const raceMult = raceOf(typeDef).moveSpeedMultiplier;
    if (raceMult !== 1.0) speed *= raceMult;

    // Skeleton shambling penalty — foot only; undead cavalry keep full
    // gallop. Same rule as Soldier.effectiveMoveSpeed.
    if (isUndead && !isCavalry(typeDef)) {
      speed *= CombatConfig.skeleton.moveSpeedMultiplier;
    }

    return speed;
  }

// Builds the panel's displayed name. Race is read from the type's race
  // field ('human' / 'goblin'); undead overrides the race label because
  // the skeleton body is the defining trait, not the species it was built
  // from. displayName in UnitTypes.js is expected to be race-agnostic
  // (bare "Spearman", not "Human Spearman") so this prefix is the only
  // place the race is spelled out.
// Builds the panel's displayed name. A unit with a customName (set on
  // champion retinues at battle-build time, and available for any future
  // renamed unit) wins outright — the name is used verbatim, with no
  // race/undead prefix. The stored name already reads as a proper noun
  // ("Goblin Warlord"), and prefixing it would double up ("Goblin Goblin
  // Warlord") or contradict it ("Undead Goblin Warlord").
  //
  // Without a customName, the name is built the original way: race is read
  // from the type's race field ('human' / 'goblin'), undead overrides the
  // race label because the skeleton body is the defining trait rather than
  // the species it was built from. displayName in UnitTypes.js is expected
  // to be race-agnostic (bare "Spearman", not "Human Spearman") so this
  // prefix is the only place the race is spelled out.
  _buildDisplayName(unit, typeDef) {
    if (unit.customName) return unit.customName;

    const baseName = (typeDef && typeDef.displayName) || 'Unit';
    let prefix;
    if (unit.isUndead) {
      prefix = 'Undead';
    } else if (typeDef && typeDef.race === 'goblin') {
      prefix = 'Goblin';
    } else {
      prefix = 'Human';
    }
    return `${prefix} ${baseName}`;
  }

  // Ordered list of Property ids to display. Race properties first (in
  // their declared order), then UNDEAD appended if the unit carries it —
  // undead is not a race property and is resolved from the unit's
  // isUndead flag instead, but it belongs in the same displayed list.
  _collectTraits(unit, typeDef) {
    const list = [];
    if (typeDef) {
      // Route each property through raceHasProperty rather than reading
      // raceOf(typeDef).properties directly, so a per-type exclusion
      // (see UnitTypes.goblinArcher.excludesProperties) is honoured.
      // A race declares its properties once; a specific unit type of
      // that race may opt out of a property that has no meaning for
      // it — the canonical case is a goblin archer, which inherits
      // DIRTY_FIGHTING from the goblin race entry but has no melee
      // flank to fight dirty from. Reading .properties directly would
      // re-expose the excluded flag here regardless of what the helper
      // returns.
      const raceProps = raceOf(typeDef).properties || [];
      for (const p of raceProps) {
        if (raceHasProperty(typeDef, p)) list.push(p);
      }
    }
    if (unit.isUndead) list.push(Property.UNDEAD);
    return list;
  }
}

// --- small markup helpers --------------------------------------------------
// Kept as module-level functions rather than methods so they read as pure
// string builders with no `this` to reason about.

function statRow(kind, iconSvg, label, value, valueMax) {
  const frac = valueMax > 0 ? value / valueMax : 0;
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return `<div class="uip-stat uip-stat-${kind}">`
    + `<div class="uip-stat-icon">${iconSvg}</div>`
    + `<div class="uip-stat-label">${label}</div>`
    + `<div class="uip-stat-value">${Math.round(value)}<span class="total"> / ${Math.round(valueMax)}</span></div>`
    + `<div class="uip-stat-bar">`
    +   `<div class="uip-stat-fill" style="width:${pct.toFixed(1)}%"></div>`
    + `</div>`
    + `</div>`;
}

// Attribute-safe escape for a tooltip string. Only `&` and `"` can break
// the attribute; `<` and `>` are escaped as well so the emitted markup is
// unambiguous regardless of what a future editor puts in the tooltip
// table.
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// A label/value row. `tooltip` is optional — when supplied it becomes the
// row's native `title` attribute, so hovering anywhere on the row shows
// the explanatory text. Rows without a tooltip (Damage, Attack Speed,
// Range, Discipline, …) are unchanged.
function combatRow(label, valueHtml, tooltip = '') {
  const titleAttr = tooltip
    ? ` title="${escapeAttr(tooltip)}"`
    : '';
  return `<div class="uip-combat-row"${titleAttr}>`
    + `<div class="uip-combat-label">${label}</div>`
    + `<div class="uip-combat-value">${valueHtml}</div>`
    + `</div>`;
}

function traitRow(propertyId) {
  const info = propertyInfo(propertyId);
  const descHtml = info.description
    ? `<div class="uip-trait-desc">${info.description}</div>`
    : '';
  return `<div class="uip-trait">`
    + `<div class="uip-trait-icon">${ICON_TRAIT}</div>`
    + `<div class="uip-trait-name">${info.label}</div>`
    + descHtml
    + `</div>`;
}
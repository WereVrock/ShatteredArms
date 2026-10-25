// ===== UnitRank.js =====
// Visual rank badge for campaign-veteran units.
//
// Rank is derived purely from unit level (see UnitXp.js). Level 1 units
// show NO badge — a fresh recruit should look the same as it always has,
// and hiding the badge at level 1 keeps the icon uncluttered for the
// common case.
//
// Levels 2+ get a small corner badge with the level number and a tier
// colour. Four tiers, so a glance at the army bar reads "who has seen
// combat" without needing to read the number:
//
//   Regular   (lv 2-3)   bronze
//   Veteran   (lv 4-5)   steel
//   Elite     (lv 6-7)   gold
//   Legendary (lv 8+)    violet
//
// Pure UI helper. No sim knowledge, no persistence. Callers pass an
// element that will act as the positioning context; the helper installs
// the badge as an absolutely-positioned child and returns it, or returns
// null when the level does not warrant a badge.
//
// This module does NOT decide who gets a level. That is stamped onto a
// live Unit as `unit.unitLevel` at battle-build time by
// CampaignBattleBuilder.annotateUnitProgression, and lives on a roster
// entry as `entry.level` for the campaign sidebar. Callers pass whichever
// value they have.

const TIERS = [
  // Level 1 deliberately absent — no badge at level 1.
  { min: 2, max: 3,        name: 'Regular',   bg: '#7a5020', border: '#d0a060' },
  { min: 4, max: 5,        name: 'Veteran',   bg: '#3e4c5e', border: '#a8bcd0' },
  { min: 6, max: 7,        name: 'Elite',     bg: '#6a4e10', border: '#e8c860' },
  { min: 8, max: Infinity, name: 'Legendary', bg: '#402060', border: '#b090e0' }
];

// Returns the tier descriptor for a level, or null when the level does
// not warrant a badge (< 2, non-finite, or missing).
export function rankTierForLevel(level) {
  const lvl = Math.floor(Number(level));
  if (!Number.isFinite(lvl) || lvl < 2) return null;
  for (const t of TIERS) {
    if (lvl >= t.min && lvl <= t.max) return t;
  }
  return TIERS[TIERS.length - 1];
}

// Human-readable label, used for the badge's tooltip. Returns '' for
// levels that produce no badge.
export function rankLabel(level) {
  const tier = rankTierForLevel(level);
  if (!tier) return '';
  const lvl = Math.floor(Number(level));
  return `${tier.name} — level ${lvl}`;
}

// Installs a rank badge on `imageEl`. No-op (returns null) when the level
// does not warrant one, or when `imageEl` is missing. `imageEl` is used
// as the positioning context — its inline style is set to position:
// relative only when nothing already positions it, so a caller whose CSS
// already declares a position is left untouched.
//
// The badge is pointer-events:none, so it never eats a click meant for
// the card that hosts it.
export function attachRankBadge(imageEl, level) {
  const tier = rankTierForLevel(level);
  if (!tier || !imageEl) return null;

  const pos = imageEl.style.position;
  if (!pos || pos === 'static') imageEl.style.position = 'relative';

  const lvl = Math.floor(Number(level));

  const badge = document.createElement('div');
  badge.className = 'unit-rank-badge';
  badge.textContent = String(lvl);
  badge.title = rankLabel(level);
  badge.style.cssText = [
    'position:absolute',
    'top:2px',
    'left:2px',
    'min-width:16px',
    'height:16px',
    'padding:0 4px',
    'box-sizing:border-box',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font:bold 10px monospace',
    'line-height:1',
    'letter-spacing:0.2px',
    'color:#f4ead2',
    'background:' + tier.bg,
    'border:1px solid ' + tier.border,
    'border-radius:3px',
    'box-shadow:0 1px 2px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.12)',
    'pointer-events:none',
    'user-select:none',
    'z-index:2'
  ].join(';');

  imageEl.appendChild(badge);
  return badge;
}
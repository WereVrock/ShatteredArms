// ===== PowerBadge.js =====
// Compact stat row showing a unit's power score and (optionally) its
// soldier count, placed in NORMAL FLOW directly above a card's portrait
// image so it never overlaps the icon.
//
// Usage:
//   insertPowerStatsAbove(imageEl, { power, soldiers })
//
// The row is inserted as a sibling immediately BEFORE `imageEl`, so the
// parent's layout order becomes: [badges] [image]. In a column-flex or
// block-flow card that puts the row visually above the portrait; the
// callers this module is written for all use column layouts.
//
// Either value may be omitted:
//   - Only `power` given  → one gold badge. Used on the custom-battle
//     palette cards, where the unit has not been added yet and therefore
//     has no concrete soldier count to show.
//   - Only `soldiers` given → one steel badge. Not used by any current
//     caller; supported so the helper is symmetric.
//   - Both given → two badges side by side. Used on campaign picker
//     cards and custom-battle roster tiles.
//   - Neither given → returns null and inserts nothing.
//
// The badges are display:inline-block with a small gap, and the row is
// display:flex / justify-content:center so the pair is centred above the
// image regardless of the card's own alignment rules. No position:absolute,
// no parent position:relative requirement, no z-order on top of the icon.
// pointer-events:none on the row so it cannot eat a click meant for the card.
//
// Returns the row element, or null when neither value is a usable number.
export function insertPowerStatsAbove(imageEl, { power, soldiers } = {}) {
  const hasPower = typeof power === 'number' && Number.isFinite(power);
  const hasSoldiers = typeof soldiers === 'number'
    && Number.isFinite(soldiers) && soldiers >= 0;

  if (!hasPower && !hasSoldiers) return null;
  if (!imageEl || !imageEl.parentNode) return null;

  const row = document.createElement('div');
  row.style.cssText = [
    'display:flex',
    'justify-content:center',
    'align-items:center',
    'gap:5px',
    'margin:4px 0 4px 0',
    'pointer-events:none',
    'user-select:none'
  ].join(';');

  if (hasPower) {
    row.appendChild(makeBadge(
      `\u2694 ${Math.round(power)}`,
      { color: '#e0c060', border: 'rgba(200,160,60,0.45)' },
      `Power: ${Math.round(power)}`
    ));
  }
  if (hasSoldiers) {
    row.appendChild(makeBadge(
      `\u00d7${soldiers}`,
      { color: '#c8d4e0', border: 'rgba(140,160,180,0.45)' },
      `Soldiers: ${soldiers}`
    ));
  }

  imageEl.parentNode.insertBefore(row, imageEl);
  return row;
}

// One badge. Kept private — callers use the row helper above so both
// badges always render in the same wrapper with the same spacing.
function makeBadge(text, { color, border }, title) {
  const badge = document.createElement('div');
  badge.style.cssText = [
    'display:inline-block',
    'padding:1px 7px',
    'background:rgba(0,0,0,0.55)',
    `color:${color}`,
    'font:bold 11px monospace',
    'letter-spacing:0.4px',
    'line-height:1.3',
    'border-radius:3px',
    `border:1px solid ${border}`,
    'text-align:center',
    'white-space:nowrap'
  ].join(';');
  badge.textContent = text;
  badge.title = title;
  return badge;
}
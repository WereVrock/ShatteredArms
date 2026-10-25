// Shared constants for the power-balance widget family (scale, swords,
// numbers readout). Kept in one tiny file so the three views agree on
// team colours, the brass palette and the widget width without importing
// each other.

export const WIDGET_WIDTH = 104;

// Blue always left, red always right -- fixed so the widget never mirrors
// mid-battle when power shifts.
export const LEFT_TEAM  = 'blue';
export const RIGHT_TEAM = 'red';

// Aged team colors: muted and slightly warm so they read as painted
// enamel on an old instrument rather than as flat modern UI swatches.
export const TEAM_COLOR = {
  blue: '#3a6488',
  red:  '#943a3a'
};

// Darker edge of the pan gradient -- the shadowed inner curve of a
// shallow dish, so the pan reads as a bowl rather than a flat tile.
export const TEAM_COLOR_DARK = {
  blue: '#1e3a52',
  red:  '#521e1e'
};

// Lighter tints for TEXT. The enamel colours above are too dark to read
// on the readout's dark background.
export const TEAM_TEXT_COLOR = {
  blue: '#8fb4da',
  red:  '#dc9090'
};

// Brass beam, bronze stand, and a warm gold highlight. Three tones plus a
// patina shade -- enough to sell aged metal at this size.
export const BRASS_LIGHT = '#d4a850';
export const BRASS_MID   = '#a07a30';
export const BRASS_DARK  = '#5e4418';
export const PATINA      = '#3e5a52';

// Plain string concatenation, no template literals anywhere in the CSS
// strings. Every value goes through String() so a numeric constant is
// always emitted as text.
export function px(n) {
  return String(n) + 'px';
}
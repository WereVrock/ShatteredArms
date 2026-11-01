// Pure layout math for the army bar. No DOM.
//
// Two modes:
//   normal  — cards wrapped in rows, scaled between 1 and
//             NORMAL_MIN_SCALE so everything fits the available area.
//   overlap — used when normal would need cards smaller than
//             NORMAL_MIN_SCALE. Cards overlap like a hand of cards: each
//             card's left strip stays visible (activity icon + vertical
//             soldier count) and the next card covers the rest. Rows are
//             added before cards are squeezed further.
//
// The bar's height cap must match the 30vh max-height on #armyBar in
// style.css (ARMY_BAR_MAX_HEIGHT_FRACTION).

export const ARMY_CARD_BASE_WIDTH = 60;
export const ARMY_CARD_BASE_HEIGHT = 80;
export const ARMY_CARD_OVERLAP_HEIGHT = 84;
export const ARMY_CARD_GAP = 6;
export const ARMY_BAR_SIDE_MARGIN = 24;
export const ARMY_BAR_MAX_HEIGHT_FRACTION = 0.3;

const NORMAL_MIN_SCALE = 0.8;
const OVERLAP_MIN_SCALE = 0.8;
// Narrowest visible strip of an overlapped card, in px. Fits the activity
// icon and the vertical soldier count.
const OVERLAP_MIN_STEP = 22;
const SCALE_STEP = 0.025;

function roundScale(s) {
  return Math.round(s * 1000) / 1000;
}

function tryNormal(count, availableWidth, availableHeight) {
  for (let s = 1; s >= NORMAL_MIN_SCALE - 1e-9; s -= SCALE_STEP) {
    const cardW = ARMY_CARD_BASE_WIDTH * s;
    const cardH = ARMY_CARD_BASE_HEIGHT * s;
    const perRow = Math.max(
      1,
      Math.floor((availableWidth + ARMY_CARD_GAP) / (cardW + ARMY_CARD_GAP))
    );
    const rows = Math.ceil(count / perRow);
    const height = rows * (cardH + ARMY_CARD_GAP) - ARMY_CARD_GAP;
    if (height <= availableHeight) {
      return { mode: 'normal', scale: roundScale(s), rows, perRow };
    }
  }
  return null;
}

function buildOverlap(scale, perRow, rows, step, cardW, cardH) {
  return {
    mode: 'overlap',
    scale: roundScale(scale),
    perRow,
    rows,
    step,
    cardW,
    cardH,
    // How far the last card of a row sticks out past the last column.
    overhang: Math.max(0, cardW - step)
  };
}

function overlapLayout(count, availableWidth, availableHeight) {
  for (let s = 1; s >= OVERLAP_MIN_SCALE - 1e-9; s -= SCALE_STEP) {
    const cardW = ARMY_CARD_BASE_WIDTH * s;
    const cardH = ARMY_CARD_OVERLAP_HEIGHT * s;
    const maxRows = Math.max(
      1,
      Math.floor((availableHeight + ARMY_CARD_GAP) / (cardH + ARMY_CARD_GAP))
    );
    for (let rows = 1; rows <= maxRows; rows++) {
      const perRow = Math.ceil(count / rows);
      const step = perRow > 1
        ? Math.min(cardW, (availableWidth - cardW) / (perRow - 1))
        : cardW;
      if (step >= OVERLAP_MIN_STEP) {
        return buildOverlap(s, perRow, rows, step, cardW, cardH);
      }
    }
  }

  // Too many units even for the tightest overlap: keep the minimum strip
  // and let the bar scroll vertically.
  const s = OVERLAP_MIN_SCALE;
  const cardW = ARMY_CARD_BASE_WIDTH * s;
  const cardH = ARMY_CARD_OVERLAP_HEIGHT * s;
  const step = OVERLAP_MIN_STEP;
  const perRow = Math.max(1, Math.floor((availableWidth - cardW) / step) + 1);
  const rows = Math.ceil(count / perRow);
  return buildOverlap(s, perRow, rows, step, cardW, cardH);
}

export function computeArmyBarLayout({ count, availableWidth, availableHeight }) {
  if (count <= 0) return { mode: 'normal', scale: 1, rows: 0, perRow: 0 };
  return tryNormal(count, availableWidth, availableHeight)
    || overlapLayout(count, availableWidth, availableHeight);
}
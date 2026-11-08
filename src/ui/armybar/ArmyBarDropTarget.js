// Pure geometry: finds the card a drag should drop next to. Instead of
// requiring the pointer to sit exactly on a card, it falls back to the
// nearest card, so gaps, row ends and the area around the bar all work.
//
// findDropTarget(root, draggedEl, x, y, accept) returns
//   { el, placeAfter }  or  null (nothing to drop on)
// accept(cardEl) says whether a card may be a target for this drag.
//
// In overlap mode cards are partly covered by the next one, so only the
// visible strip of each card counts when deciding before / after.

const NEAR_MARGIN_PX = 48;
const CARD_SELECTOR = '.army-card';

export function findDropTarget(root, draggedEl, x, y, accept) {
  const bar = root.getBoundingClientRect();
  if (x < bar.left - NEAR_MARGIN_PX || x > bar.right + NEAR_MARGIN_PX
      || y < bar.top - NEAR_MARGIN_PX || y > bar.bottom + NEAR_MARGIN_PX) {
    return null;
  }

  const cards = measureCards(root);
  if (cards.length === 0) return null;

  // Pointer over the dragged card's own slot: dropping there changes nothing.
  for (const c of cards) {
    if (c.el === draggedEl && contains(c, x, y)) return null;
  }

  // Exact hit on a card. The dragged card has pointer-events: none while
  // dragging, so this returns whatever card is underneath it.
  const under = document.elementFromPoint(x, y);
  const hitEl = under && under.closest ? under.closest(CARD_SELECTOR) : null;
  if (hitEl && hitEl !== draggedEl && root.contains(hitEl)) {
    const hit = cards.find((c) => c.el === hitEl);
    if (hit) return accept(hit.el) ? toTarget(hit, x) : null;
  }

  // Otherwise the nearest card that may be a target.
  let best = null;
  let bestDist = Infinity;
  for (const c of cards) {
    if (c.el === draggedEl || !accept(c.el)) continue;
    const d = distance(c, x, y);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best ? toTarget(best, x) : null;
}

// Rectangles of every displayed card, in DOM order. visRight is the right
// edge of the part of the card that is not covered by the next card of the
// same row.
function measureCards(root) {
  const list = [];
  for (const el of root.querySelectorAll(CARD_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    list.push({
      el,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      visRight: r.right
    });
  }
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i];
    const b = list[i + 1];
    const sameRow = Math.abs(b.top - a.top) < (a.bottom - a.top) * 0.5;
    if (sameRow && b.left > a.left) a.visRight = Math.min(a.right, b.left);
  }
  return list;
}

function contains(c, x, y) {
  return x >= c.left && x <= c.visRight && y >= c.top && y <= c.bottom;
}

function distance(c, x, y) {
  const dx = Math.max(c.left - x, 0, x - c.visRight);
  const dy = Math.max(c.top - y, 0, y - c.bottom);
  return Math.hypot(dx, dy);
}

function toTarget(c, x) {
  return { el: c.el, placeAfter: x > (c.left + c.visRight) / 2 };
}
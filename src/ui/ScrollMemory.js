// Remembers and restores the scroll position of several scrollable
// elements across a full DOM rebuild. Screens here re-render by wiping
// innerHTML on every click, which would otherwise throw every scrolling
// list back to the top each time a unit is added, resized or removed.
//
// `selectors` is a map of key -> CSS selector, resolved against `root`:
//   { panel: '.custom-battle-panel', red: '.custom-team-red .custom-team-units' }

// Call BEFORE the old DOM is cleared.
export function captureScroll(root, selectors) {
  const saved = {};
  for (const [key, selector] of Object.entries(selectors)) {
    const el = root.querySelector(selector);
    saved[key] = el ? el.scrollTop : 0;
  }
  return saved;
}

// Call AFTER the new DOM is attached, so the browser can lay it out and
// clamp the value to the new scroll range.
export function restoreScroll(root, selectors, saved) {
  for (const [key, selector] of Object.entries(selectors)) {
    const top = saved[key];
    if (!top) continue;
    const el = root.querySelector(selector);
    if (el) el.scrollTop = top;
  }
}
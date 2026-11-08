// ===== TitleTooltips.js =====
// Routes every tooltip source in the UI through the medieval plaque:
//   - native `title` attributes (anywhere in the document), and
//   - `data-tooltip-name` (army bar cards).
//
// One set of delegated document listeners, no per-element wiring, so
// elements created later are covered automatically.
//
//   pointerover  find the closest element with a tooltip source. For a
//                `title`, the text is moved to `data-mt-title` so the
//                browser's own tooltip cannot appear. Schedule the plaque.
//                Moving onto an element with no tooltip releases the
//                current one.
//   pointerout   leaving the element: restore `title`, hide the plaque.
//   pointerdown  hide the plaque for the rest of this hover.
//   scroll       release, since the anchor has moved.
//
// Touch input is ignored. While an army-bar drag is active no plaque is
// shown (the drop indicator is the only feedback during a drag).

const SELECTOR = '[title], [data-mt-title], [data-tooltip-name]';

let installed = false;
let getTooltip = null;
// { el } for the element whose tooltip is currently routed, or null.
let current = null;

function dragActive() {
  return !!document.querySelector('.army-bar-drag-active');
}

function textFor(el) {
  return el.dataset.mtTitle || el.dataset.tooltipName || '';
}

function acquire(el) {
  const native = el.getAttribute('title');
  if (native) {
    el.dataset.mtTitle = native;
    el.removeAttribute('title');
  }
  current = { el };
  if (dragActive()) return;
  const text = textFor(el);
  if (text) getTooltip().schedule(el, text);
}

function release() {
  if (!current) return;
  const el = current.el;
  current = null;
  getTooltip().hide(el);

  const saved = el.dataset.mtTitle;
  if (saved !== undefined) {
    delete el.dataset.mtTitle;
    if (!el.hasAttribute('title')) el.setAttribute('title', saved);
  }
}

function onOver(e) {
  if (e.pointerType === 'touch') return;
  const target = e.target;
  const el = target && target.closest ? target.closest(SELECTOR) : null;
  if (!el) {
    release();
    return;
  }
  if (current && current.el === el) return;
  release();
  acquire(el);
}

function onOut(e) {
  if (!current) return;
  const rel = e.relatedTarget;
  if (rel && current.el.contains(rel)) return;
  release();
}

function onDown() {
  if (!current) return;
  getTooltip().hide(current.el);
}

// getTooltipFn returns the shared MedievalTooltip. It is passed in (not
// imported) so this module has no dependency on MedievalTheme.js.
export function installTitleTooltips(getTooltipFn) {
  if (installed) return;
  installed = true;
  getTooltip = getTooltipFn;
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('scroll', release, true);
}
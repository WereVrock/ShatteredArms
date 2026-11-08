// DOM helper: a small floating button that sits just above the top-left
// corner of the army bar. It only reports clicks; what "sort" means is up to
// the view. position() is called by the view whenever the bar's layout is
// recomputed, so the button never reads layout on its own per frame.

const BUTTON_HEIGHT_PX = 20;
const GAP_PX = 2;

export class ArmyBarSortButton {
  constructor(rootElement, onClick) {
    this.root = rootElement;

    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'army-bar-sort-btn';
    this.el.textContent = '⇅';
    this.el.title = 'Sort by unit type';

    // Keep presses on the button away from any document-level canvas
    // handlers (selection box, camera drag).
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onClick) onClick();
    });

    document.body.appendChild(this.el);
    this.position();
  }

  // Places the button above the bar's top-left corner. Hidden while the bar
  // itself has no size (not displayed or empty).
  position() {
    const rect = this.root.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    this.el.style.left = Math.round(rect.left) + 'px';
    this.el.style.top = Math.round(rect.top - BUTTON_HEIGHT_PX - GAP_PX) + 'px';
  }

  dispose() {
    this.el.remove();
  }
}
// DOM helper: a small floating toolbar above the army bar's top-left corner
// (below it for bars anchored to the top of the screen). Holds the sort and
// make-squad buttons and the card size - / + buttons. It only forwards
// clicks; what they mean lives in the view.
//
// position() is called by the view when something changed, never per frame.

const BUTTON_HEIGHT_PX = 20;
const BELOW_GAP_PX = 2;

export class ArmyBarToolbar {
  constructor(rootElement, { onSort, onCreateSquad, onZoom }) {
    this.root = rootElement;

    this.el = document.createElement('div');
    this.el.className = 'army-bar-toolbar';
    // Hidden until the view positions it for the first time.
    this.el.style.display = 'none';

    // Keep presses on the toolbar away from any document-level canvas
    // handlers (selection box, camera drag).
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.el.appendChild(this._button('⇅', 'Sort by unit type', onSort));
    this.el.appendChild(this._button(
      '⊞',
      'Group the selected cards into a squad',
      onCreateSquad
    ));

    const sep = document.createElement('span');
    sep.className = 'army-bar-tool-sep';
    this.el.appendChild(sep);

    this.el.appendChild(this._button('−', 'Smaller cards', () => onZoom(-1)));
    this.el.appendChild(this._button('+', 'Larger cards', () => onZoom(1)));

    document.body.appendChild(this.el);
  }

  _button(text, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'army-bar-tool-btn';
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onClick) onClick();
    });
    return btn;
  }

  // `clearance` is the room left above the bar for squad tabs.
  position(clearance) {
    const rect = this.root.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.hide();
      return;
    }
    this.el.style.display = 'flex';
    const height = this.el.offsetHeight || BUTTON_HEIGHT_PX;
    let top = rect.top - height - clearance;
    // Bars anchored to the top of the screen have no room above them.
    if (top < 0) top = rect.bottom + BELOW_GAP_PX;
    this.el.style.left = Math.round(rect.left) + 'px';
    this.el.style.top = Math.round(top) + 'px';
  }

  hide() {
    this.el.style.display = 'none';
  }

  dispose() {
    this.el.remove();
  }
}
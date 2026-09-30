// Start Battle button, plus a one-line hint. Pure DOM — no sim or deployment
// logic. The only thing this class does is call the onStart callback when
// the button is pressed, then hide itself. Everything else is up to main.js.
//
// Anchored to the TOP of the screen so it does not compete with the army
// bar along the bottom, and so the eye lands on it the moment deployment
// begins. Uses position:fixed so the caller can append it anywhere in the
// DOM without worrying about the stacking context. z-index 20 keeps it
// above the HUD (10) and army bar (15) but below the main menu (30) so it
// never fights the menu overlay.
export class DeploymentPanel {
  constructor(containerElement, opts = {}) {
    this._onStart = opts.onStart || null;

    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position:fixed',
      'top:16px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:20',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:8px',
      'font-family:sans-serif',
      'user-select:none',
      'pointer-events:none'
    ].join(';');

    // Button first so it sits on top of the hint — the eye lands on the
    // action, the explanatory line reads underneath.
    this.button = document.createElement('button');
    this.button.textContent = 'Start Battle';
    this.button.style.cssText = [
      'padding:12px 44px',
      'font-size:17px',
      'font-weight:600',
      'letter-spacing:0.5px',
      'color:#ffffff',
      'background:#2e7d32',
      'border:1px solid #1b5e20',
      'border-radius:5px',
      'cursor:pointer',
      'pointer-events:auto',
      'box-shadow:0 2px 8px rgba(0,0,0,0.45)',
      'transition:background 0.12s ease'
    ].join(';');

    this.button.addEventListener('mouseenter', () => {
      this.button.style.background = '#388e3c';
    });
    this.button.addEventListener('mouseleave', () => {
      this.button.style.background = '#2e7d32';
    });
    this.button.addEventListener('click', () => {
      if (this._onStart) this._onStart();
      this.hide();
    });
    this.root.appendChild(this.button);

    const hint = document.createElement('div');
    hint.textContent = 'Reposition your units inside the blue zone, then start the battle.';
    hint.style.cssText = [
      'color:#e8e8e8',
      'background:rgba(20,30,45,0.78)',
      'padding:5px 14px',
      'border-radius:4px',
      'font-size:12px',
      'letter-spacing:0.2px',
      'pointer-events:none'
    ].join(';');
    this.root.appendChild(hint);

    containerElement.appendChild(this.root);
  }

  show() {
    this.root.style.display = 'flex';
  }

  hide() {
    this.root.style.display = 'none';
  }

  dispose() {
    this.root.remove();
  }
}
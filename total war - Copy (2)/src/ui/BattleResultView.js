// ===== BattleResultView.js =====
// End-of-battle result screen for standalone scenarios and custom battles.
// Not used by the campaign flow — the campaign has its own between-battle
// screens (see CampaignFlow / CardPickerView), so main.js only shows this
// when startScenario was called WITHOUT an onBattleEnded callback.
//
// One full-screen overlay, one panel, one of two headings:
//   'won'  → VICTORY
//   'lost' → DEFEAT
//
// Two actions:
//   Restart Battle        — reload the page without clearing persistence,
//                           so boot re-launches the same battle (same
//                           scenario id, or the same custom rosters).
//   Return to Main Menu   — delegated to the caller via onReturn; main.js
//                           wires this to the shared exit path (clears
//                           ActiveScenario / ActiveCustomBattle /
//                           CampaignState and reloads).
//
// Pure UI. No sim knowledge, no persistence knowledge.

export class BattleResultView {
  constructor() {
    this.el = null;
  }

  show(outcome, { onReturn } = {}) {
    this.hide();

    const won = outcome === 'won';

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0',
      'background:rgba(0,0,0,0.72)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'z-index:1000',
      'font-family:monospace'
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:#1e222a',
      'border:1px solid #384050',
      'border-radius:8px',
      'padding:32px 48px',
      'text-align:center',
      'min-width:320px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.6)'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = won ? 'VICTORY' : 'Our Forces Have Shattered!';
    title.style.cssText = [
      'font-size:32px',
      'font-weight:bold',
      'letter-spacing:6px',
      won ? 'color:#c8e6a0' : 'color:#e6a0a0',
      'text-shadow:0 0 12px rgba(0,0,0,0.8)',
      'margin-bottom:24px'
    ].join(';');
    panel.appendChild(title);

    const sub = document.createElement('div');
    sub.textContent = won
      ? 'The field is yours.'
      : 'The enemy holds the field.';
    sub.style.cssText = [
      'font-size:13px',
      'color:#99a',
      'margin-bottom:28px',
      'letter-spacing:0.5px'
    ].join(';');
    panel.appendChild(sub);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-direction:column;';

    const restartBtn = document.createElement('button');
    restartBtn.type = 'button';
    restartBtn.textContent = 'RESTART BATTLE';
    restartBtn.style.cssText = [
      'padding:10px 24px',
      'background:#2a3a5a',
      'color:#eee',
      'border:1px solid #4a5a8a',
      'border-radius:4px',
      'cursor:pointer',
      'font-family:inherit',
      'font-size:13px',
      'letter-spacing:0.6px'
    ].join(';');
    restartBtn.addEventListener('mouseenter', () => { restartBtn.style.background = '#3a4a7a'; });
    restartBtn.addEventListener('mouseleave', () => { restartBtn.style.background = '#2a3a5a'; });
    restartBtn.addEventListener('click', () => {
      // Reload WITHOUT clearing persistence — boot re-launches the same
      // battle (same scenario id, or the same custom rosters).
      window.location.reload();
    });
    btnRow.appendChild(restartBtn);

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.textContent = 'RETURN TO MAIN MENU';
    menuBtn.style.cssText = [
      'padding:10px 24px',
      'background:#2a2a2a',
      'color:#eee',
      'border:1px solid #555',
      'border-radius:4px',
      'cursor:pointer',
      'font-family:inherit',
      'font-size:13px',
      'letter-spacing:0.6px'
    ].join(';');
    menuBtn.addEventListener('mouseenter', () => { menuBtn.style.background = '#3a3a3a'; });
    menuBtn.addEventListener('mouseleave', () => { menuBtn.style.background = '#2a2a2a'; });
    menuBtn.addEventListener('click', () => {
      if (onReturn) onReturn();
    });
    btnRow.appendChild(menuBtn);

    panel.appendChild(btnRow);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.el = overlay;
  }

  hide() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
    this.el = null;
  }
}
// ===== PursuitUI.js =====
// End-of-battle prompts shown between "battle resolved" and "result screen":
//
//   showPursuitPrompt(onPursue, onFlee)
//     Blocking overlay shown when the player has won but enemies are still
//     fleeing the field. PURSUE keeps the sim running past the normal
//     battle-over point; LET THEM FLEE force-extracts all remaining
//     runners immediately.
//
//   showEndBattleButton(onClick) -> { remove() }
//     Small non-blocking floating button shown WHILE the player is
//     pursuing. Lets them abandon the chase at any moment — remaining
//     runners are force-extracted. The sim keeps ticking behind it.
//
// Both return/resolve immediately after attaching their DOM; the caller
// owns the transitions. Pure UI — no sim knowledge, no persistence.

export function showPursuitPrompt(onPursue, onFlee) {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.6)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'z-index:1000'
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'background:#222', 'color:#eee', 'padding:24px 32px',
    'border:1px solid #555', 'border-radius:6px',
    'font-family:monospace', 'text-align:center', 'max-width:440px'
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'Enemy Forces Shattered';
  title.style.cssText = 'font-size:18px;font-weight:bold;margin-bottom:12px;';

  const body = document.createElement('div');
  body.textContent = 'Enemy soldiers are fleeing the field. Pursue them and destroy them, or let them escape?';
  body.style.cssText = 'font-size:13px;color:#aac;margin-bottom:20px;line-height:1.5;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';

  const pursueBtn = document.createElement('button');
  pursueBtn.textContent = 'PURSUE';
  pursueBtn.style.cssText = [
    'padding:8px 20px', 'background:#5a2a2a', 'color:#eee',
    'border:1px solid #8a4a4a', 'border-radius:4px', 'cursor:pointer',
    'font-family:inherit', 'font-size:13px'
  ].join(';');
  pursueBtn.addEventListener('click', () => {
    document.body.removeChild(overlay);
    onPursue();
  });

  const fleeBtn = document.createElement('button');
  fleeBtn.textContent = 'LET THEM FLEE';
  fleeBtn.style.cssText = [
    'padding:8px 20px', 'background:#2a3a5a', 'color:#eee',
    'border:1px solid #4a5a8a', 'border-radius:4px', 'cursor:pointer',
    'font-family:inherit', 'font-size:13px'
  ].join(';');
  fleeBtn.addEventListener('click', () => {
    document.body.removeChild(overlay);
    onFlee();
  });

  btnRow.appendChild(pursueBtn);
  btnRow.appendChild(fleeBtn);
  panel.appendChild(title);
  panel.appendChild(body);
  panel.appendChild(btnRow);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

// Returns a handle with .remove() so the caller does not need to keep a
// reference to the DOM node just to detach it later.
export function showEndBattleButton(onClick) {
  const btn = document.createElement('button');
  btn.textContent = 'END BATTLE';
  btn.style.cssText = [
    'position:fixed',
    'top:16px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:60',
    'padding:10px 26px',
    'background:#5a2a2a',
    'color:#eee',
    'border:1px solid #8a4a4a',
    'border-radius:5px',
    'cursor:pointer',
    'font-family:monospace',
    'font-size:14px',
    'font-weight:bold',
    'letter-spacing:0.6px',
    'box-shadow:0 2px 8px rgba(0,0,0,0.45)',
    'pointer-events:auto'
  ].join(';');
  btn.addEventListener('mouseenter', () => { btn.style.background = '#7a3a3a'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#5a2a2a'; });
  btn.addEventListener('click', () => {
    if (btn.parentNode) btn.parentNode.removeChild(btn);
    onClick();
  });
  document.body.appendChild(btn);

  return {
    remove() {
      if (btn.parentNode) btn.parentNode.removeChild(btn);
    }
  };
}
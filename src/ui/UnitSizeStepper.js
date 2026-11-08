// Compact "[-] 30 [+]" control for resizing a roster unit. The number in
// the middle is the unit's actual soldier count; the buttons step it by the
// unit's base size. Pure UI: it reports button clicks through onStep(+1 /
// -1) and decides nothing about limits, budgets or counts.
//
// A screen using this control does not need to print the soldier count
// anywhere else.
//
// Injects its own stylesheet once, like the other self-contained UI modules,
// so the control looks the same in Custom Battle and the multiplayer lobby.

const STYLE_ID = 'unit-size-stepper-styles';
const STYLE_TEXT = `
  .size-stepper {
    display: inline-flex; align-items: center; gap: 2px;
    font-family: monospace; user-select: none;
  }
  .size-stepper-btn {
    width: 18px; height: 18px; padding: 0; line-height: 1;
    border: 1px solid #3a4a5e; border-radius: 3px;
    background: #1e2430; color: #d8e6ff;
    font-family: inherit; font-size: 13px; cursor: pointer;
  }
  .size-stepper-btn:hover:not(:disabled) { background: #2c3a52; border-color: #6a8ac0; }
  .size-stepper-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .size-stepper-count {
    min-width: 34px; text-align: center;
    font-size: 11px; font-weight: bold; color: #c8d4e0;
  }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

function makeButton(text, title, disabled, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'size-stepper-btn';
  btn.textContent = text;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

// count:  soldiers currently in the unit.
// state:  { base, canDecrease } from RosterScaling.sizeStateOf.
// onStep: called with -1 or +1.
export function createSizeStepper({ count, state, onStep }) {
  ensureStyles();

  const wrap = document.createElement('div');
  wrap.className = 'size-stepper';
  wrap.title = `Steps of ${state.base} soldiers`;

  wrap.appendChild(makeButton(
    '\u2212', `-${state.base} soldiers`, !state.canDecrease, () => onStep(-1)
  ));

  const countEl = document.createElement('span');
  countEl.className = 'size-stepper-count';
  countEl.textContent = String(count);
  wrap.appendChild(countEl);

  wrap.appendChild(makeButton(
    '+', `+${state.base} soldiers`, false, () => onStep(1)
  ));

  return wrap;
}
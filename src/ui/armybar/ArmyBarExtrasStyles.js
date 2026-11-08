// Styles for drag reordering, control-group badges, the casualty flash, the
// toolbar and the squad frames / tabs. Injected once per page, same pattern
// as ArmyBarView's bar styles.

const STYLE_ID = 'army-bar-extras-styles';
const STYLE_TEXT = `
  .army-card-dragging {
    opacity: 0.45;
    pointer-events: none;
  }
  .army-bar-drag-active .army-card {
    cursor: grabbing;
  }
  /* The drop target is raised above its neighbours so the indicator is
     visible in overlap mode too, where the next card would cover it. */
  .army-card-drop-before {
    box-shadow: -4px 0 0 0 #e8c060, -4px 0 10px 0 rgba(232, 192, 96, 0.8) !important;
    z-index: 7;
  }
  .army-card-drop-after {
    box-shadow: 4px 0 0 0 #e8c060, 4px 0 10px 0 rgba(232, 192, 96, 0.8) !important;
    z-index: 7;
  }

  /* style.css nudges a pressed card down 1px (.army-card:active). In a bar
     that scrolls vertically that 1px of overflow flashes a scrollbar for as
     long as the button is held, i.e. the whole drag. Cancel the nudge, and
     never scroll a bar that does not need it while a drag is running. */
  .army-card.army-card:active {
    transform: none;
  }
  .army-bar-drag-active:not(.scrollable) {
    overflow-y: hidden !important;
  }

  .army-card-group {
    position: absolute;
    left: 3px;
    bottom: 16px;
    min-width: 12px;
    padding: 0 3px;
    font-size: 10px;
    line-height: 13px;
    text-align: center;
    color: #f0e0b0;
    background: rgba(0, 0, 0, 0.65);
    border: 1px solid rgba(232, 192, 96, 0.7);
    border-radius: 3px;
    pointer-events: none;
  }
  @keyframes army-card-hit {
    0%   { outline: 2px solid rgba(220, 60, 60, 0.95); outline-offset: -2px; }
    100% { outline: 2px solid rgba(220, 60, 60, 0);    outline-offset: -2px; }
  }
  .army-card-hit {
    animation: army-card-hit 0.45s ease-out;
  }

  .army-bar-toolbar {
    position: fixed;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 3px;
    font-family: monospace;
    user-select: none;
  }
  .army-bar-tool-sep {
    width: 6px;
  }
  .army-bar-tool-btn {
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    box-sizing: border-box;
    font: 12px/18px monospace;
    color: #f0e0b0;
    background: rgba(0, 0, 0, 0.65);
    border: 1px solid rgba(232, 192, 96, 0.7);
    border-radius: 3px;
    cursor: pointer;
  }
  .army-bar-tool-btn:hover {
    background: rgba(60, 45, 15, 0.85);
  }

  .army-squad-overlay {
    position: fixed;
    left: 0;
    top: 0;
    width: 0;
    height: 0;
    z-index: 16;
    pointer-events: none;
  }
  .army-squad-frame {
    position: fixed;
    box-sizing: border-box;
    border: 3px solid;
    border-radius: 6px;
    pointer-events: none;
  }
  .army-squad-chip {
    position: fixed;
    display: flex;
    align-items: center;
    gap: 3px;
    height: 16px;
    padding: 0 4px;
    box-sizing: border-box;
    font: bold 11px/14px monospace;
    color: #111;
    white-space: nowrap;
    border: 1px solid rgba(0, 0, 0, 0.55);
    border-radius: 5px 5px 0 0;
    cursor: grab;
    user-select: none;
    pointer-events: auto;
  }
  .army-squad-chip.army-card-dragging {
    opacity: 0.45;
    pointer-events: none;
  }
  .army-squad-chip button {
    padding: 0 2px;
    font: inherit;
    line-height: 14px;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
  .army-squad-chip button:hover {
    background: rgba(0, 0, 0, 0.2);
  }
  .army-squad-grip {
    padding: 0 2px;
  }
  .army-squad-count {
    font-size: 10px;
  }
`;

export function ensureArmyBarExtrasStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_TEXT;
  document.head.appendChild(el);
}
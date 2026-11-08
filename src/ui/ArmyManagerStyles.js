// ===== ArmyManagerStyles.js =====
// Stylesheet for the army manager modal, injected once into document.head.
//
// Every class here is prefixed `amv-`. The old unprefixed names collided
// with the army bar's global `.army-card*` rules in style.css (notably
// `.army-card { width: 60px }`), which squeezed manager cards until their
// names no longer fit. Keep the prefix on anything added here.

const STYLE_ID = 'army-manager-styles';

const STYLE_TEXT = `
  .amv-root {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 1100;
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    color: #e8e8e8;
  }
  .amv-panel {
    background: #1e222a;
    border: 1px solid #384050;
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    width: min(980px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }
  .amv-header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 14px 20px;
    border-bottom: 1px solid #2a3544;
    background: linear-gradient(180deg, #262e3b 0%, #1c222c 100%);
    border-radius: 10px 10px 0 0;
  }
  .amv-header-text { flex: 1 1 auto; min-width: 0; }
  .amv-title { font-size: 20px; font-weight: 700; color: #eef2f8; }
  .amv-subtitle { font-size: 12px; color: #7a8a9e; margin-top: 4px; }
  .amv-close {
    background: transparent;
    border: none;
    color: #6a7a8e;
    font-size: 30px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    font-family: inherit;
  }
  .amv-close:hover { color: #eef2f8; }
  .amv-body { padding: 14px 20px 6px; overflow-y: auto; }
  .amv-pane {
    background: rgba(0, 0, 0, 0.15);
    border: 1px solid #2a3544;
    border-radius: 8px;
    margin-bottom: 12px;
    transition: border-color 0.1s, background 0.1s;
  }
  .amv-pane.amv-reserve { border-style: dashed; }
  .amv-pane.amv-drop-hover {
    border-color: #8ad0d0;
    background: rgba(138, 208, 208, 0.07);
  }
  .amv-pane-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px 0;
  }
  .amv-pane-title {
    font-size: 14px;
    font-weight: 700;
    color: #dde5ee;
    letter-spacing: 0.4px;
  }
  .amv-pane-count { margin-left: 8px; color: #e0c060; }
  .amv-pane-note { flex: 1 1 auto; font-size: 11px; color: #7a8a9e; }
  .amv-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
    gap: 10px;
    padding: 12px;
    min-height: 110px;
  }
  .amv-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 8px 6px;
    background: #232a36;
    border: 1px solid #384050;
    border-radius: 6px;
    cursor: grab;
    user-select: none;
    text-align: center;
    box-sizing: border-box;
    transition: border-color 0.1s, background 0.1s, box-shadow 0.1s;
  }
  .amv-card:hover { border-color: #6a8ac0; }
  .amv-card.amv-locked { cursor: default; }
  .amv-card.amv-dragging { opacity: 0.35; }
  .amv-card.amv-merge-target {
    border-color: #e0c060;
    box-shadow: 0 0 10px rgba(224, 192, 96, 0.55);
  }
  .amv-card.amv-drop-hover { background: #2e3a4e; border-color: #8ad0d0; }
  .amv-card-icon { position: relative; width: 52px; height: 52px; }
  .amv-card-icon svg {
    width: 100%;
    height: 100%;
    display: block;
    pointer-events: none;
  }
  .amv-card-name {
    max-width: 100%;
    min-height: 2.4em;
    font-size: 12px;
    color: #dde5ee;
    line-height: 1.2;
    overflow: hidden;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .amv-card-count {
    font-size: 11px;
    color: #8a9ab0;
    font-variant-numeric: tabular-nums;
  }
  .amv-card-count.amv-depleted { color: #d08a6a; }
  .amv-card-tag {
    font-size: 9px;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: #e0c060;
  }
  .amv-split-btn {
    margin-top: 2px;
    padding: 2px 12px;
    font-family: inherit;
    font-size: 10.5px;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    color: #b8c8dc;
    background: #2a3342;
    border: 1px solid #3f4d63;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s, color 0.1s;
  }
  .amv-split-btn:hover {
    background: #34425a;
    border-color: #6a8ac0;
    color: #eef2f8;
  }
  .amv-slot {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 104px;
    border: 1px dashed #3a4658;
    border-radius: 6px;
    color: #5a6a7e;
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    box-sizing: border-box;
  }
  .amv-footer {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 20px 14px;
    border-top: 1px solid #2a3544;
  }
  .amv-hint { flex: 1 1 auto; font-size: 11.5px; color: #7a8a9e; line-height: 1.4; }
  .amv-btn {
    padding: 7px 18px;
    border-radius: 5px;
    font-family: inherit;
    font-size: 12.5px;
    letter-spacing: 0.5px;
    cursor: pointer;
    border: 1px solid #384050;
    background: #2a2f3a;
    color: #dde5ee;
    transition: background 0.1s, border-color 0.1s;
  }
  .amv-btn:hover:not(:disabled) { background: #343a48; }
  .amv-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .amv-btn.amv-primary {
    background: #2e5c3a;
    border-color: #4a8a5a;
    color: #eef8f0;
    font-weight: 600;
  }
  .amv-btn.amv-primary:hover:not(:disabled) { background: #3a7248; }

  .amv-menu {
    position: absolute;
    z-index: 5;
    min-width: 230px;
    max-width: 300px;
    padding: 6px;
    background: #1a1f28;
    border: 1px solid #3a4a5e;
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.65);
    box-sizing: border-box;
  }
  .amv-menu-title {
    padding: 4px 8px 6px;
    font-size: 11px;
    color: #8a9ab0;
    letter-spacing: 1.4px;
    text-transform: uppercase;
  }
  .amv-menu-item {
    display: block;
    width: 100%;
    margin-top: 4px;
    padding: 7px 10px;
    text-align: left;
    font-family: inherit;
    color: #dde5ee;
    background: #232a36;
    border: 1px solid #2a3544;
    border-radius: 5px;
    cursor: pointer;
    box-sizing: border-box;
    transition: background 0.1s, border-color 0.1s;
  }
  .amv-menu-item:hover { background: #2e3a4e; border-color: #6a8ac0; }
  .amv-menu-label { display: block; font-size: 13px; font-weight: 600; }
  .amv-menu-detail {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    color: #7a8a9e;
    font-variant-numeric: tabular-nums;
  }

  .amv-reject { animation: amv-shake 0.25s; }
  @keyframes amv-shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-4px); }
    75% { transform: translateX(4px); }
  }
`;

export function ensureArmyManagerStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}
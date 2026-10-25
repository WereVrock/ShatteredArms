// ===== ChampionPanelView.js =====
// Modal viewer for the champion's level, XP progress, and skill tree.
// Also drives the champion PREVIEW screen shown before a new campaign
// begins: full skill tree in a non-interactive state, starting effects,
// and a Confirm button.
//
// Two modes:
//   show(champion, onClose)                — live view, spend points
//   showPreview({ def, stats, onConfirm, onCancel })
//                                          — pre-run preview
//
// Pure UI: reads and calls into Champion, never touches the sim or the
// campaign roster. All persistence flows back through Champion.unlock().
//
// Layout (live mode):
//   header   — name, description, level, XP bar, points available, close
//   body     — three tree columns side by side
//   each tree — title, description, then three tier rows; each tier row
//               shows its two node buttons
//
// Layout (preview mode):
//   header   — name, description, "Starting effects" block, close
//   body     — three tree columns, every node rendered non-interactive
//   footer   — [Back] [Confirm]

const STYLE_ID = 'champion-panel-styles';

const STYLE_TEXT = `
  .champ-root {
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
  .champ-panel {
    background: #1e222a;
    border: 1px solid #384050;
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    width: min(1080px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }
  .champ-header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 16px 20px;
    border-bottom: 1px solid #2a3544;
    background: linear-gradient(180deg, #262e3b 0%, #1c222c 100%);
    border-radius: 10px 10px 0 0;
  }
  .champ-identity {
    flex: 1 1 auto;
    min-width: 0;
  }
  .champ-name {
    font-size: 22px;
    font-weight: 700;
    color: #eef2f8;
  }
  .champ-level {
    font-size: 13px;
    color: #8a9ab0;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    margin-top: 2px;
  }
  .champ-desc {
    font-size: 12px;
    color: #7a8a9e;
    line-height: 1.45;
    margin-top: 6px;
    max-width: 620px;
  }

  /* Starting-effects block, preview mode only. */
  .champ-starting {
    margin-top: 12px;
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.22);
    border: 1px solid #2a3544;
    border-radius: 5px;
    max-width: 620px;
  }
  .champ-starting-title {
    font-size: 10px;
    color: #8a9ab0;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  .champ-starting-row {
    display: grid;
    grid-template-columns: 130px 1fr;
    column-gap: 10px;
    row-gap: 4px;
    font-size: 12.5px;
    line-height: 1.45;
  }
  .champ-starting-label {
    color: #8a9ab0;
  }
  .champ-starting-value {
    color: #dde5ee;
  }
  .champ-starting-value .hint {
    color: #7a8a9e;
    font-size: 11.5px;
  }

  .champ-right {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }
  .champ-points {
    font-size: 14px;
    color: #e0c060;
    font-weight: 600;
    letter-spacing: 0.6px;
    white-space: nowrap;
  }
  .champ-xpwrap {
    width: 200px;
  }
  .champ-xpbar {
    height: 10px;
    background: #10151d;
    border-radius: 5px;
    overflow: hidden;
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);
  }
  .champ-xpfill {
    height: 100%;
    background: linear-gradient(90deg, #4a8a9a 0%, #8ad0d0 100%);
    transition: width 0.2s linear;
  }
  .champ-xplabel {
    font-size: 11px;
    color: #7a8a9e;
    margin-top: 4px;
    letter-spacing: 0.4px;
    text-align: right;
  }
  .champ-close {
    background: transparent;
    border: none;
    color: #6a7a8e;
    font-size: 30px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    font-family: inherit;
  }
  .champ-close:hover { color: #eef2f8; }

  .champ-body {
    padding: 16px 20px 20px;
    overflow-y: auto;
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .champ-tree {
    flex: 1 1 0;
    min-width: 0;
    background: rgba(0, 0, 0, 0.15);
    border: 1px solid #2a3544;
    border-radius: 8px;
    padding: 12px;
  }
  .champ-tree-title {
    font-size: 15px;
    font-weight: 700;
    color: #dde5ee;
    letter-spacing: 0.4px;
    margin-bottom: 2px;
  }
  .champ-tree-desc {
    font-size: 11px;
    color: #7a8a9e;
    margin-bottom: 12px;
    line-height: 1.4;
  }
  .champ-tier {
    margin-bottom: 14px;
  }
  .champ-tier:last-child { margin-bottom: 0; }
  .champ-tier-label {
    font-size: 10px;
    color: #7a8a9e;
    letter-spacing: 1.4px;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  .champ-node {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    margin-bottom: 6px;
    border-radius: 5px;
    border: 1px solid #2a3544;
    background: #1a1f28;
    color: #aab8c8;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.1s, border-color 0.1s, color 0.1s;
    box-sizing: border-box;
  }
  .champ-node:hover:not(:disabled) {
    background: #232b38;
    border-color: #4a5a8a;
    color: #eef2f8;
  }
  .champ-node.owned {
    background: #1e2e24;
    border-color: #4a8a5a;
    color: #c8e6d0;
    cursor: default;
  }
  .champ-node.available {
    background: #23293a;
    border-color: #6a8ac0;
    color: #eef2f8;
  }
  .champ-node.locked,
  .champ-node.nopoints {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .champ-node.preview {
    /* Preview mode: nodes are shown but inert. Muted, no hover, no cursor
       signal. Softer than .locked so the tree reads as "here is the
       shape of what you can grow into", not "these are all locked out". */
    background: rgba(0, 0, 0, 0.15);
    border-color: #1e2836;
    color: #8a9ab0;
    cursor: default;
    opacity: 0.85;
  }
  .champ-node-name {
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.2px;
    margin-bottom: 2px;
  }
  .champ-node-desc {
    font-size: 11px;
    line-height: 1.4;
    color: inherit;
    opacity: 0.85;
  }

  .champ-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 20px 16px;
    border-top: 1px solid #2a3544;
  }
  .champ-btn {
    padding: 8px 22px;
    border-radius: 5px;
    font-family: inherit;
    font-size: 13px;
    letter-spacing: 0.6px;
    cursor: pointer;
    border: 1px solid #384050;
    background: #2a2f3a;
    color: #dde5ee;
    transition: background 0.1s, border-color 0.1s;
  }
  .champ-btn:hover { background: #343a48; }
  .champ-btn.primary {
    background: #2e5c3a;
    border-color: #4a8a5a;
    color: #eef8f0;
    font-weight: 600;
  }
  .champ-btn.primary:hover { background: #3a7248; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

import { SKILL_TREES, findNode, xpForLevel } from '../campaign/ChampionSkills.js';

export class ChampionPanelView {
  constructor() {
    ensureStyles();
    this.root = document.createElement('div');
    this.root.className = 'champ-root';
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) {
        if (this._previewMode) {
          const cb = this._previewOnCancel;
          this._teardown();
          if (cb) cb();
        } else {
          this.close();
        }
      }
    });
    document.body.appendChild(this.root);

    this._champion = null;
    this._onClose = null;

    // Preview-mode state. `def` is a ChampionConfig entry; `stats` is the
    // resolved-numbers object from previewStartingStats; onConfirm and
    // onCancel are the two flow callbacks.
    this._previewMode = false;
    this._previewDef = null;
    this._previewStats = null;
    this._previewOnConfirm = null;
    this._previewOnCancel = null;
  }

  isOpen() {
    return this.root.style.display === 'flex';
  }

  // --- live mode ---------------------------------------------------------

  // Opens the panel for the given Champion. `onClose` fires after the
  // panel is dismissed for any reason — the caller uses it to refresh
  // campaign UI (e.g. show a "new skill point available" badge).
  show(champion, onClose = null) {
    this._previewMode = false;
    this._champion = champion;
    this._onClose = onClose;
    this._render();
    this.root.style.display = 'flex';
  }

  close() {
    if (this._previewMode) return;
    if (!this.isOpen()) return;
    this.root.style.display = 'none';
    const cb = this._onClose;
    this._champion = null;
    this._onClose = null;
    if (cb) cb();
  }

  // --- preview mode ------------------------------------------------------

  // Opens the panel in preview mode: no Champion instance, all nodes
  // rendered inert, starting effects shown in the header, Confirm / Back
  // buttons in the footer. `def` is a ChampionConfig entry; `stats` is
  // the optional resolved-numbers object from previewStartingStats (pass
  // null to omit the starting-effects block).
  showPreview({ def, stats, onConfirm, onCancel } = {}) {
    this._champion = null;
    this._onClose = null;
    this._previewMode = true;
    this._previewDef = def;
    this._previewStats = stats || null;
    this._previewOnConfirm = onConfirm || null;
    this._previewOnCancel = onCancel || null;
    this._render();
    this.root.style.display = 'flex';
  }

  // Clears all state and hides the panel without firing any callback.
  // Used by confirm / cancel / backdrop-click, each of which invokes its
  // own callback after teardown.
  _teardown() {
    this.root.style.display = 'none';
    this._champion = null;
    this._onClose = null;
    this._previewMode = false;
    this._previewDef = null;
    this._previewStats = null;
    this._previewOnConfirm = null;
    this._previewOnCancel = null;
  }

  // --- internals ---------------------------------------------------------

_render() {
    this.root.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'champ-panel';
    panel.appendChild(this._buildHeader());
    // Pseudo-commanders (e.g. Mercenary Captains) have no Champion
    // instance, so they have no skill tree to grow. Skip the body
    // entirely for them in preview mode — the panel then reads as a
    // straight "starting conditions" summary with Confirm / Back, which
    // is exactly what the choice represents. Real champions and the live
    // champion view (opened from the reward shop) always render the body.
    const isPseudoPreview =
      !!(this._previewMode && this._previewDef && this._previewDef.pseudoCommander);
    if (!isPseudoPreview) panel.appendChild(this._buildBody());
    if (this._previewMode) panel.appendChild(this._buildPreviewFooter());
    this.root.appendChild(panel);
  }

  _buildHeader() {
    const header = document.createElement('div');
    header.className = 'champ-header';

    const identity = document.createElement('div');
    identity.className = 'champ-identity';

    const name = document.createElement('div');
    name.className = 'champ-name';
    name.textContent = this._previewMode
      ? (this._previewDef?.displayName || 'Champion')
      : this._champion.displayName;
    identity.appendChild(name);

    if (this._previewMode) {
      const def = this._previewDef;
      if (def?.description) {
        const desc = document.createElement('div');
        desc.className = 'champ-desc';
        desc.textContent = def.description;
        identity.appendChild(desc);
      }
      identity.appendChild(this._buildStartingEffects());
    } else {
      const c = this._champion;
      const level = document.createElement('div');
      level.className = 'champ-level';
      level.textContent = `Level ${c.level}${c.isMaxLevel ? ' (max)' : ''}`;
      identity.appendChild(level);
      if (c.def?.description) {
        const desc = document.createElement('div');
        desc.className = 'champ-desc';
        desc.textContent = c.def.description;
        identity.appendChild(desc);
      }
    }

    header.appendChild(identity);

    const right = document.createElement('div');
    right.className = 'champ-right';

    if (!this._previewMode) {
      const c = this._champion;
      const xpwrap = document.createElement('div');
      xpwrap.className = 'champ-xpwrap';
      const bar = document.createElement('div');
      bar.className = 'champ-xpbar';
      const fill = document.createElement('div');
      fill.className = 'champ-xpfill';
      let frac = 1;
      let labelText;
      if (c.isMaxLevel) {
        labelText = 'Max level reached';
      } else {
        const cur = xpForLevel(c.level);
        const next = xpForLevel(c.level + 1);
        const span = Math.max(1, next - cur);
        const into = Math.max(0, c.xp - cur);
        frac = Math.min(1, into / span);
        labelText = `${Math.round(c.xp - cur)} / ${span} XP toward level ${c.level + 1}`;
      }
      fill.style.width = (frac * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      const label = document.createElement('div');
      label.className = 'champ-xplabel';
      label.textContent = labelText;
      xpwrap.appendChild(bar);
      xpwrap.appendChild(label);
      right.appendChild(xpwrap);

      const points = document.createElement('div');
      points.className = 'champ-points';
      points.textContent = c.unspentPoints > 0
        ? `${c.unspentPoints} skill point${c.unspentPoints === 1 ? '' : 's'} available`
        : 'No skill points available';
      right.appendChild(points);
    }

    const close = document.createElement('button');
    close.className = 'champ-close';
    close.type = 'button';
    close.textContent = '\u00d7';
    close.title = this._previewMode ? 'Back' : 'Close';
    close.addEventListener('click', () => {
      if (this._previewMode) {
        const cb = this._previewOnCancel;
        this._teardown();
        if (cb) cb();
      } else {
        this.close();
      }
    });
    right.appendChild(close);

    header.appendChild(right);
    return header;
  }

  // Starting-effects block. Preview mode only. Reads from _previewDef
  // and _previewStats; missing stats degrade to a minimal block (passive
  // only) rather than throwing.
  _buildStartingEffects() {
    const def = this._previewDef;
    const stats = this._previewStats;

    const wrap = document.createElement('div');
    wrap.className = 'champ-starting';

    const title = document.createElement('div');
    title.className = 'champ-starting-title';
    title.textContent = 'Starting effects';
    wrap.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'champ-starting-row';

    const addRow = (label, value, hint = '') => {
      const l = document.createElement('div');
      l.className = 'champ-starting-label';
      l.textContent = label;
      grid.appendChild(l);

      const v = document.createElement('div');
      v.className = 'champ-starting-value';
      v.textContent = value;
      if (hint) {
        const h = document.createElement('span');
        h.className = 'hint';
        h.textContent = ` ${hint}`;
        v.appendChild(h);
      }
      grid.appendChild(v);
    };

    // Custom starting-effect rows declared on the def. Used by pseudo-
    // commanders (e.g. Mercenary Captains) that have no Champion unit and
    // therefore no stats object — they contribute a set of starting
    // conditions rather than a character, and those conditions belong in
    // the same block as a real champion's starting numbers.
    if (Array.isArray(def.startingEffects)) {
      for (const eff of def.startingEffects) {
        addRow(eff.label, eff.value, eff.hint || '');
      }
    }

    if (stats) {
      addRow('Champion HP', String(stats.championHp),
        `(${def.championHpMultiplier}× a bodyguard's)`);
      addRow('Bodyguards',
        `${stats.bodyguardCount} × ${stats.bodyguardTypeName}`,
        `${stats.bodyguardHp} HP each`);
    }

    if (def.passive) {
      addRow('Doctrine', def.passive.name, `— ${def.passive.description}`);
    }

    // Recruitment cost multipliers live on the champion def as
    // `costMultipliers`, separate from the passive. Same conceptual
    // "how this champion runs his army" mechanic, so it belongs in the
    // same starting-effects block — the panel is where a player decides
    // whether to commit, and the prices they will actually pay between
    // battles should be visible here rather than only on the shop
    // screen. Read defensively: a future champion with no pricing
    // overrides simply skips the row.
    if (def.costMultipliers) {
      const cm = def.costMultipliers;
      const parts = [];
      if (typeof cm.goblin === 'number') parts.push(`goblins ×${cm.goblin}`);
      if (typeof cm.human  === 'number') parts.push(`humans ×${cm.human}`);
      if (typeof cm.undead === 'number') parts.push(`undead ×${cm.undead}`);
      if (parts.length > 0) {
        addRow('Recruitment cost', parts.join(' · '));
      }
    }

    wrap.appendChild(grid);
    return wrap;
  }

  _buildBody() {
    const body = document.createElement('div');
    body.className = 'champ-body';
    for (const tree of SKILL_TREES) {
      body.appendChild(this._buildTree(tree));
    }
    return body;
  }

  _buildTree(tree) {
    const el = document.createElement('div');
    el.className = 'champ-tree';

    const title = document.createElement('div');
    title.className = 'champ-tree-title';
    title.textContent = tree.name;
    el.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'champ-tree-desc';
    desc.textContent = tree.description;
    el.appendChild(desc);

    for (const tier of tree.tiers) {
      const tierEl = document.createElement('div');
      tierEl.className = 'champ-tier';
      const tierLabel = document.createElement('div');
      tierLabel.className = 'champ-tier-label';
      tierLabel.textContent = `Tier ${tier.tier}`;
      tierEl.appendChild(tierLabel);
      for (const node of tier.nodes) {
        tierEl.appendChild(
          this._previewMode
            ? this._buildPreviewNode(node)
            : this._buildNode(node)
        );
      }
      el.appendChild(tierEl);
    }
    return el;
  }

  // Non-interactive node for preview mode. Same shape and content as a
  // live node, but always disabled and styled with a muted look so the
  // tree reads as a preview rather than a set of locked-out choices.
  _buildPreviewNode(node) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'champ-node preview';
    btn.disabled = true;

    const name = document.createElement('div');
    name.className = 'champ-node-name';
    name.textContent = node.name;
    btn.appendChild(name);

    const desc = document.createElement('div');
    desc.className = 'champ-node-desc';
    desc.textContent = node.description;
    btn.appendChild(desc);

    return btn;
  }

  _buildNode(node) {
    const c = this._champion;
    const owned = c.unlockedSkills.has(node.id);
    const available = !owned && c.canUnlock(node.id);
    const noPoints = !owned && !available && c.unspentPoints <= 0
      && this._couldUnlockWithPoints(node.id, c.unlockedSkills);
    const locked = !owned && !available && !noPoints;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'champ-node'
      + (owned ? ' owned' : '')
      + (available ? ' available' : '')
      + (noPoints ? ' nopoints' : '')
      + (locked ? ' locked' : '');
    btn.disabled = !available;

    const name = document.createElement('div');
    name.className = 'champ-node-name';
    name.textContent = (owned ? '\u2713 ' : '') + node.name;
    btn.appendChild(name);

    const desc = document.createElement('div');
    desc.className = 'champ-node-desc';
    desc.textContent = node.description;
    btn.appendChild(desc);

    if (owned) {
      btn.title = 'Already unlocked.';
    } else if (available) {
      btn.title = 'Click to unlock.';
    } else if (noPoints) {
      btn.title = 'No skill points available.';
    } else {
      const found = findNode(node.id);
      const tierNum = found ? found.tier.tier : 1;
      const prereq = Math.max(0, tierNum - 1);
      btn.title = `Requires at least ${prereq} point${prereq === 1 ? '' : 's'} in ${found ? found.tree.name : 'this tree'}.`;
    }

    if (available) {
      btn.addEventListener('click', () => {
        if (c.unlock(node.id)) this._render();
      });
    }

    return btn;
  }

  _buildPreviewFooter() {
    const footer = document.createElement('div');
    footer.className = 'champ-footer';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'champ-btn';
    back.textContent = 'Back';
    back.addEventListener('click', () => {
      const cb = this._previewOnCancel;
      this._teardown();
      if (cb) cb();
    });
    footer.appendChild(back);

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'champ-btn primary';
    confirm.textContent = 'Confirm and continue';
    confirm.addEventListener('click', () => {
      const cb = this._previewOnConfirm;
      this._teardown();
      if (cb) cb();
    });
    footer.appendChild(confirm);

    return footer;
  }

  // True if this node's tier prerequisite is met (used to distinguish
  // "locked by tier" from "no points left").
  _couldUnlockWithPoints(nodeId, unlockedSkills) {
    const found = findNode(nodeId);
    if (!found) return false;
    if (unlockedSkills.has(nodeId)) return false;
    const tierNum = found.tier.tier;
    if (tierNum <= 1) return true;
    let inTree = 0;
    for (const tier of found.tree.tiers) {
      for (const n of tier.nodes) if (unlockedSkills.has(n.id)) inTree++;
    }
    return inTree >= tierNum - 1;
  }
}
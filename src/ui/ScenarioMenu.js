// ===== ScenarioMenu.js =====
// ===== ScenarioMenu.js =====
// Scenario submenu. Same card list as the pre-campaign main menu, plus a
// back button that returns to the top-level menu.
//
// OPT-IN customization
//
// The player can override each team's role (player / AI, including
// both-AI spectator) and each AI team's difficulty tier. This is
// deliberately OFF by default — the tick box reads as "I am doing
// something non-standard". Unticked:
//   - the Configure button is disabled (greyed, inert),
//   - the scenario card dispatches the ORIGINAL PlayableScenarios entry
//     unchanged, so every scenario plays exactly as its author intended.
// Ticked:
//   - the Configure button becomes live and opens the modal,
//   - the scenario card dispatches a RESOLVED copy with playerTeamId /
//     aiTeamIds / aiTierByTeamId overridden from the modal's settings.
//
// Session-scoped: both the tick and the settings reset on every show(),
// so a fresh visit to the menu always starts in the default state. This
// matches the design intent — a re-entry into the scenario list should
// not silently inherit a leftover custom setup from a previous run.
//
// Pure UI. All sim-side wiring (creating BattleAI, honouring the resolved
// tier map) lives in main.js.
import { createMenuCard, createMenuButton } from './MenuCard.js';
import { AITierPicker } from './AITierPicker.js';
import { AITierPreference } from '../config/AITierPreference.js';

const ALL_TEAM_IDS = ['blue', 'red'];

// sessionStorage key for the ScenarioMenu's own customization state.
// Written whenever the tick, role, or a tier changes; read on every
// show(). Session-scoped on purpose: the customization is a session
// artifact, not a durable preference — a fresh tab starts clean.
//
// This is separate from ActiveScenario's overrides field. ActiveScenario
// records what a SPECIFIC launch resolved to (used by boot to route
// Ctrl+R back here, and by the Restart button to resume). This key
// records what the player currently has configured in the UI, so the
// menu they land on shows the same tick / role / tiers they last set.
const SETUP_STORAGE_KEY = 'sa.scenarioMenuSetup';

export class ScenarioMenu {
  constructor(rootElement, { scenarios, onSelect, onBack }) {
    this.root = rootElement;
    this.scenarios = scenarios;
    this.onSelect = onSelect;
    this.onBack = onBack;

    // Master opt-in flag. Controls BOTH whether the Configure button is
    // live AND whether the customization is applied on scenario dispatch.
    // See class header. Reset to false on every show().
    this.customizeEnabled = false;

    // Session-scoped customization values. Only meaningful when
    // customizeEnabled is true; still maintained while disabled so that
    // toggling the tick off and back on preserves the player's last
    // choices within a single visit to the menu.
    this.playerTeamId = 'blue';
    const defaultTier = AITierPreference.get();
    this.aiTierByTeamId = { blue: defaultTier, red: defaultTier };

    // The customize-players modal, when open. Null otherwise.
    this._modalEl = null;
    // Every AITierPicker currently mounted inside the modal. Rebuilding
    // the modal disposes and re-creates these; each construction in
    // controlled mode is cheap but still needs disposal to keep the
    // subscription contract uniform with the rest of the codebase.
    this._tierPickers = [];
  }

// Restore the player's last customization from sessionStorage if
  // present, instead of hard-resetting to defaults on every open.
  //
  // Rationale: a Ctrl+R reload now routes back to this menu (see
  // main.js boot), so the menu must present the last-used configuration
  // for the "click the scenario and you're back" flow to work. A fresh
  // tab still starts clean — the key lives in sessionStorage.
  show() {
    const saved = this._loadSetup();
    if (saved) {
      this.customizeEnabled = saved.customizeEnabled;
      this.playerTeamId = saved.playerTeamId;
      this.aiTierByTeamId = saved.aiTierByTeamId;
    } else {
      const defaultTier = AITierPreference.get();
      this.customizeEnabled = false;
      this.playerTeamId = 'blue';
      this.aiTierByTeamId = { blue: defaultTier, red: defaultTier };
    }
    this._closeModal();
    this._render();
  }

  // --- sessionStorage persistence -----------------------------------------

  // Writes the current tick / role / tier state. Called from every
  // mutation point below so a Ctrl+R at any time captures the state the
  // player is looking at.
  _persistSetup() {
    try {
      sessionStorage.setItem(SETUP_STORAGE_KEY, JSON.stringify({
        customizeEnabled: this.customizeEnabled,
        playerTeamId: this.playerTeamId,
        aiTierByTeamId: { ...this.aiTierByTeamId }
      }));
    } catch (e) { /* sessionStorage may throw in private mode */ }
  }

  // Returns the persisted setup, or null if absent / malformed. Role and
  // tier values are shape-checked so a stale save cannot put the picker
  // into a state with no valid selected option.
  _loadSetup() {
    try {
      const raw = sessionStorage.getItem(SETUP_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.customizeEnabled !== 'boolean') return null;

      const role = parsed.playerTeamId === null
        ? null
        : (parsed.playerTeamId === 'red' ? 'red' : 'blue');

      const defaultTier = AITierPreference.get();
      const tiers = (parsed.aiTierByTeamId && typeof parsed.aiTierByTeamId === 'object')
        ? parsed.aiTierByTeamId
        : {};

      return {
        customizeEnabled: parsed.customizeEnabled,
        playerTeamId: role,
        aiTierByTeamId: {
          blue: typeof tiers.blue === 'string' ? tiers.blue : defaultTier,
          red:  typeof tiers.red  === 'string' ? tiers.red  : defaultTier
        }
      };
    } catch (e) {
      return null;
    }
  }

  hide() {
    this._closeModal();
    this.root.classList.add('hidden');
  }

  // --- rendering -----------------------------------------------------------

  _render() {
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');

    const panel = document.createElement('div');
    // Extra class lets style.css bound this specific panel and scroll only
    // its card list — the scenario list can exceed a short viewport now
    // that there are ten entries, and the base .menu-panel has no scroll.
    panel.className = 'menu-panel scenario-menu-panel';

    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = 'Scenarios';
    panel.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'menu-subtitle';
    sub.textContent = 'Choose a scenario';
    panel.appendChild(sub);

    panel.appendChild(this._buildCustomizeRow());

    const list = document.createElement('div');
    list.className = 'menu-list';

    for (const scenario of this.scenarios) {
      list.appendChild(createMenuCard({
        name: scenario.name,
        description: scenario.description,
        onClick: () => this._selectScenario(scenario)
      }));
    }

    panel.appendChild(list);

    panel.appendChild(createMenuButton({
      label: '← Back',
      className: 'menu-back',
      onClick: () => this.onBack()
    }));

    this.root.appendChild(panel);
  }

  // Small inline row: an opt-in tick box, a short label, and a compact
  // Configure chip. Deliberately NOT a .menu-card — the whole point of
  // this control is that it reads as a secondary, off-by-default path,
  // and a full-width primary-styled card would read as "the main way to
  // play a scenario", which it is not.
  //
  // The chip is disabled and dimmed while the tick is off. Clicking the
  // label toggles the tick; clicking the chip opens the modal. Enabling
  // the tick enables the chip; disabling it while the modal is open
  // closes the modal, so the modal's edits cannot silently outlive the
  // opt-in that made them relevant.
  _buildCustomizeRow() {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'gap:8px',
      'margin:6px 0 10px'
    ].join(';');

    // --- tick + label ---------------------------------------------------
    // The label wraps the checkbox so clicking the text toggles it too,
    // matching the toggle-row convention used elsewhere in the UI.
    const label = document.createElement('label');
    label.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:6px',
      'padding:4px 6px',
      'font-size:12px',
      'color:#aab8c8',
      'letter-spacing:0.4px',
      'cursor:pointer',
      'user-select:none'
    ].join(';');
    label.title = 'Opt in to overriding which team you command and each AI team\'s difficulty.';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.customizeEnabled;
    cb.style.cssText = 'cursor:pointer;margin:0;';
    label.appendChild(cb);

    const labelText = document.createElement('span');
    labelText.textContent = 'Custom player setup';
    label.appendChild(labelText);

    row.appendChild(label);

    // --- Configure chip -------------------------------------------------
    // Built before the checkbox's listener wires to it, so the listener
    // can close over the reference without a TDZ hazard.
    const btn = this._buildConfigureButton();

    cb.addEventListener('change', () => {
      this.customizeEnabled = cb.checked;
      this._syncConfigureButton(btn, cb.checked);
      this._persistSetup();
      // Opt-in just switched off — the modal's edits are no longer
      // reachable from the scenario dispatch path, so leaving it open
      // would let the player edit settings that silently do nothing.
      if (!cb.checked && this._modalEl) this._closeModal();
    });

    row.appendChild(btn);
    return row;
  }

  _buildConfigureButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '⚙ Configure';
    btn.style.cssText = [
      'padding:4px 10px',
      'font-family:inherit',
      'font-size:11px',
      'letter-spacing:0.6px',
      'border-radius:4px',
      'border:1px solid #3a4a5e',
      'background:#1e2430',
      'color:#aab',
      'transition:background 0.1s ease, border-color 0.1s ease, color 0.1s ease'
    ].join(';');

    btn.addEventListener('mouseenter', () => {
      if (btn.disabled) return;
      btn.style.background = '#28303e';
    });
    btn.addEventListener('mouseleave', () => {
      if (btn.disabled) return;
      btn.style.background = '#1e2430';
    });

    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      this._openModal();
    });

    // Apply the initial disabled/active styling — matches the checkbox's
    // initial checked state (false on show()).
    this._syncConfigureButton(btn, this.customizeEnabled);
    return btn;
  }

  // Single source of truth for the Configure chip's enabled/disabled
  // look. Called from the checkbox handler and once at construction, so
  // the two channels (disabled attribute, visual dimming) cannot drift.
  _syncConfigureButton(btn, enabled) {
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '1' : '0.4';
    btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    btn.title = enabled
      ? 'Choose which team you command and each AI team\'s difficulty.'
      : 'Tick "Custom player setup" to enable.';
  }

  // Resolve the scenario for dispatch. When the opt-in is off, the
  // ORIGINAL scenario object is passed through unchanged — this is the
  // critical branch: the caller (main.js) relies on scenario.aiTeamIds
  // being the author-declared list, and injecting resolved defaults here
  // would look identical today but would silently override future
  // author-declared scenarios that use non-standard team layouts.
  //
  // When the opt-in is on, a shallow copy is emitted with playerTeamId /
  // aiTeamIds / aiTierByTeamId overridden. aiTeamIds is derived from
  // playerTeamId using the same rule CustomBattleBuilder uses: every team
  // that is not the player goes to the AI; a null playerTeamId puts BOTH
  // teams under AI control.
  _selectScenario(scenario) {
    if (!this.customizeEnabled) {
      this.onSelect(scenario);
      return;
    }

    const playerTeamId = this.playerTeamId;
    const aiTeamIds = playerTeamId
      ? ALL_TEAM_IDS.filter(id => id !== playerTeamId)
      : ALL_TEAM_IDS.slice();

    const resolved = {
      ...scenario,
      // Marker so main.js can tell a resolved copy from a base
      // PlayableScenarios entry — the resolved copy is the one whose
      // customization should be persisted via ActiveScenario
      // .setCustomized() rather than a bare set(id).
      customized: true,
      playerTeamId,
      aiTeamIds,
      aiTierByTeamId: { ...this.aiTierByTeamId }
    };

    this.onSelect(resolved);
  }

  // --- customize-players modal ---------------------------------------------

  _openModal() {
    // Dispose any previously-built modal before rebuilding. Called both
    // on first open and on every role toggle — see _toggleRole.
    this._closeModal();

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:rgba(0,0,0,0.6)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'z-index:1200',
      'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
      'color:#e8e8e8'
    ].join(';');

    // Backdrop mousedown closes. mousedown (not click) so a drag that
    // starts inside the panel and releases on the backdrop does not close.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this._closeModal();
    });

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:#1e222a',
      'border:1px solid #384050',
      'border-radius:8px',
      'padding:20px 24px',
      'min-width:400px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.5)'
    ].join(';');

    const title = document.createElement('h2');
    title.textContent = 'Customize Players';
    title.style.cssText = 'margin:0 0 6px;font-size:18px;font-weight:600;';
    panel.appendChild(title);

    const hint = document.createElement('p');
    hint.textContent =
      'Choose which team you command, or set both to AI for a spectator battle.';
    hint.style.cssText = 'margin:0 0 14px;font-size:12px;color:#889;line-height:1.4;';
    panel.appendChild(hint);

    for (const teamId of ALL_TEAM_IDS) {
      panel.appendChild(this._buildTeamRow(teamId));
    }

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'menu-card menu-confirm';
    doneBtn.textContent = 'Done';
    doneBtn.style.marginTop = '14px';
    doneBtn.addEventListener('click', () => this._closeModal());
    panel.appendChild(doneBtn);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this._modalEl = overlay;
  }

  // One team's row: colour-coded name, role toggle, and (when AI) a
  // per-team tier picker pushed to the right. The toggle model matches
  // CustomBattleSetup exactly — see _toggleRole.
  _buildTeamRow(teamId) {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:10px 0',
      'border-bottom:1px solid #2a2f3a'
    ].join(';');

    const label = document.createElement('span');
    label.textContent = teamId === 'blue' ? 'Blue' : 'Red';
    label.style.cssText = [
      'flex:0 0 56px',
      'font-size:14px',
      'font-weight:600',
      'color:' + (teamId === 'blue' ? '#8fb4da' : '#dc9090')
    ].join(';');
    row.appendChild(label);

    const isPlayer = this.playerTeamId === teamId;
    const roleBtn = document.createElement('button');
    roleBtn.type = 'button';
    roleBtn.textContent = isPlayer ? '⚔ Player' : 'AI';
    roleBtn.style.cssText = [
      'padding:5px 14px',
      'font-family:inherit',
      'font-size:12px',
      'letter-spacing:0.6px',
      'border-radius:4px',
      'cursor:pointer',
      'border:1px solid ' + (isPlayer ? '#6a8ac0' : '#3a4a5e'),
      'background:' + (isPlayer ? '#26354a' : '#1e2430'),
      'color:' + (isPlayer ? '#e6eef8' : '#aab')
    ].join(';');
    roleBtn.title = isPlayer
      ? 'This team is the player. Click to switch it to AI.'
      : 'Click to make this team the player.';
    roleBtn.addEventListener('click', () => this._toggleRole(teamId));
    row.appendChild(roleBtn);

    // Spacer pushes the picker to the right edge.
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1 1 auto;';
    row.appendChild(spacer);

    if (!isPlayer) {
      const picker = new AITierPicker({
        value: this.aiTierByTeamId[teamId] || AITierPreference.get(),
        compact: true,
        onChange: (tierId) => {
          this.aiTierByTeamId[teamId] = tierId;
          this._persistSetup();
        }
      });
      this._tierPickers.push(picker);
      row.appendChild(picker.el);
    }

    return row;
  }

  // Same toggle model as CustomBattleSetup._toggleRole:
  //   - clicking a non-player team's button promotes it to player (the
  //     other team silently becomes AI);
  //   - clicking the current player team's button demotes it to AI,
  //     leaving BOTH teams AI (spectator).
  // There is no "both player" state — the model never produces it.
  //
  // Rebuilds the modal in place rather than mutating the rows, because
  // the AI/Player transition changes which controls exist (the tier
  // picker appears or disappears). Rebuilding is the least-surprising
  // way to keep the row consistent.
  _toggleRole(teamId) {
    this.playerTeamId = (this.playerTeamId === teamId) ? null : teamId;
    this._persistSetup();
    this._openModal();
  }

  _closeModal() {
    for (const p of this._tierPickers) p.dispose();
    this._tierPickers = [];
    if (this._modalEl && this._modalEl.parentNode) {
      this._modalEl.parentNode.removeChild(this._modalEl);
    }
    this._modalEl = null;
  }
}
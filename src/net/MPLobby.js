// Multiplayer lobby. Single full-screen panel that owns everything between
// "player clicks Multiplayer in the main menu" and "both peers press
// Ready, build the same scenario, and hand off to main.js for the battle".
//
// Responsibilities:
//   - Room code entry, Host / Join buttons (single WebSocket per peer)
//   - Mode tabs: Scenario (pick from PlayableScenarios) or Custom
//     (each peer builds a roster within a shared power budget)
//   - Host-owned match settings: power budget, deployment time
//   - Roster exchange via lobby-roster messages
//   - Ready handshake: both peers Ready → host compiles match-start
//
// Deliberately NOT responsible for: the deployment phase (see
// MPDeploymentPhase), the battle itself, snapshots, or order forwarding
// (all handled by main.js once onMatchStart fires).
//
// Roster builder is compact compared with CustomBattleSetup — it only
// shows a palette and the player's OWN roster, since the peer's roster
// arrives as a summary row. Full both-sides editing belongs to the
// single-player Custom Battle screen, not to a symmetric lobby.

import { PlayableScenarios } from '../scenarios/PlayableScenarios.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { UnitFamilies } from '../campaign/UnitFamilies.js';
import { CampaignConfig } from '../campaign/CampaignConfig.js';
import { raceSupportsUndead } from '../config/RaceConfig.js';
import { buildPreviewUnit } from '../campaign/UnitPreview.js';
import { unitIconSvg } from '../ui/UnitIcon.js';

const DEFAULT_POWER_BUDGET = 1500;
const DEFAULT_DEPLOYMENT_SECONDS = 45;
const MIN_POWER_BUDGET = 200;
const MAX_POWER_BUDGET = 50000;
const DEPLOYMENT_OPTIONS = [0, 15, 30, 45, 60, 90];

// Pause modes. Values match the mode strings MPPauseController accepts.
// Displayed in complexity order.
const PAUSE_MODES = [
  { value: 'free',         label: 'Toggled — either peer can pause' },
  { value: 'voted',        label: 'Voted — both must agree' },
  { value: 'limited',      label: 'Limited — 5 × 30s each' },
  { value: 'timed',        label: 'Timed — 60s budget each, shared timer' },
  { value: 'accumulative', label: 'Accumulative — +1 per 2 min, max 3' }
];
const DEFAULT_PAUSE_MODE = 'free';

export class MPLobby {
  constructor(opts = {}) {
    // Called once a match is fully negotiated. Payload:
    //   { session, scenario, deploymentSeconds, playerTeamId, otherTeamId }
    // main.js takes it from there.
    this.onMatchStart = opts.onMatchStart || (() => {});
    this.onClose = opts.onClose || (() => {});
    // Fired when the player clicks "Same Device" in the connection
    // section. The lobby tears down any half-open session and hides
    // itself; main.js takes over from there.
    this.onSameDevice = opts.onSameDevice || (() => {});

    this._session = null;
    this._role = null;            // 'host' | 'guest' | null
    this._paired = false;

    // Host-owned config. Guest receives and echoes it locally but cannot
    // edit. mode 'scenario' uses scenarioId; 'custom' uses powerBudget.
    this._config = {
      mode: 'scenario',
      scenarioId: PlayableScenarios[0]?.id || null,
      powerBudget: DEFAULT_POWER_BUDGET,
      deploymentSeconds: DEFAULT_DEPLOYMENT_SECONDS,
      pauseMode: DEFAULT_PAUSE_MODE
    };

    // Own roster (custom mode only). Entries:
    //   { id, typeId, isUndead, aliveCount, maxCount }
    // Peer's roster arrives via lobby-roster and is stored for display
    // only — never mutated locally.
    this._myRoster = [];
    this._peerRoster = [];

    this._myReady = false;
    this._peerReady = false;

    this._skeletonMode = false;

    // Bound so close() can unwind them if the lobby is dismissed mid-flow.
    this._sessionHandlers = [];

    this._root = null;
    this._statusEl = null;
    this._build();
  }

  // Unsubscribes every handler registered through _connect's `add()`,
  // closes the socket if one exists, and clears both. Safe to call when
  // nothing is connected — the common case, since open() always runs it
  // before the player clicks Host / Join.
  _teardownSession() {
    for (const [type, fn] of this._sessionHandlers) {
      if (this._session) this._session.off(type, fn);
    }
    this._sessionHandlers = [];
    if (this._session) {
      this._session.close();
      this._session = null;
    }
  }

  open() {
    this._reset();
    this._root.classList.remove('hidden');
    this._render();
  }

  close() {
    this._teardownSession();
    this._root.classList.add('hidden');
    this.onClose();
  }

  // --- session plumbing -----------------------------------------------------

  // Called by the Host / Join buttons. Creates the WebSocket, wires the
  // welcome handshake, and stores the role the server assigned (which must
  // match what we asked for; a mismatch means the room slot is taken).
  _connect(roomCode, requestedRole) {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${window.location.host}/ws?room=${encodeURIComponent(roomCode)}`;

    // Imported lazily here (rather than at module top) so the lobby UI can
    // be instantiated even if NetSession fails to load — the failure then
    // surfaces as a status message rather than a broken import.
    return import('./NetSession.js').then(({ NetSession }) => {
      this._session = new NetSession(url);

      const add = (type, fn) => {
        this._session.on(type, fn);
        this._sessionHandlers.push([type, fn]);
      };

      add('welcome', (msg) => {
        if (msg.role !== requestedRole) {
          this._setStatus(`Room already has a ${msg.role}. Try ${msg.role === 'host' ? 'Join' : 'Host'}.`);
          this._teardownSession();
          return;
        }
        this._role = msg.role;
        this._setStatus('Waiting for opponent…');
      });

      add('paired', () => {
        this._paired = true;
        this._setStatus('Paired. Configure the match, then Ready up.');

        if (this._role === 'host') {
          // Host pushes the initial config; guest reflects it.
          this._send({ type: 'lobby-config', config: this._config });
        }
        this._render();
      });

      add('peerLeft', () => {
        this._paired = false;
        this._peerReady = false;
        this._setStatus('Opponent disconnected.');
        this._render();
      });

      add('lobby-config', (msg) => {
        // Only meaningful for the guest. A config from a non-host is
        // ignored (defensive — the server pairs exactly two peers).
        if (this._role !== 'guest') return;
        this._config = Object.assign({}, this._config, msg.config || {});
        this._render();
      });

      add('lobby-roster', (msg) => {
        this._peerRoster = Array.isArray(msg.roster) ? msg.roster : [];
        this._render();
      });

      add('lobby-ready', () => {
        this._peerReady = true;
        this._setStatus('Opponent is ready.');
        this._render();
        if (this._role === 'host') this._tryEmitMatchStart();
      });

      add('match-start', (msg) => {
        if (this._role !== 'guest') return;
        this._beginMatch(msg);
      });

      return this._session.connect();
    }).catch((err) => {
      console.error('[MPLobby] connect failed', err);
      this._setStatus('Connection failed.');
    });
  }

  _send(msg) {
    if (this._session) this._session.send(msg);
  }

  // --- match handshake ------------------------------------------------------

  _playerReady() {
    if (!this._paired || this._myReady) return;
    if (this._config.mode === 'custom' && this._myRoster.length === 0) {
      this._setStatus('Add at least one unit before readying.');
      return;
    }
    this._myReady = true;
    this._send({ type: 'lobby-ready', teamId: this._myTeamId() });
    this._setStatus('Waiting for opponent…');
    this._render();
    if (this._role === 'host') this._tryEmitMatchStart();
  }

  // Host-only. When both peers are ready, compiles the match-start payload
  // and begins the local side of the match; the guest receives the same
  // payload via the wire and begins identically.
  _tryEmitMatchStart() {
    if (this._role !== 'host') return;
    if (!this._myReady || !this._peerReady) return;

    const hostTeamId = 'blue';
    const guestTeamId = 'red';

    const blueRoster = hostTeamId === 'blue' ? this._myRoster : this._peerRoster;
    const redRoster  = hostTeamId === 'blue' ? this._peerRoster : this._myRoster;

    const payload = {
      blueRoster: blueRoster.slice(),
      redRoster: redRoster.slice(),
      mode: this._config.mode,
      scenarioId: this._config.scenarioId,
      deploymentSeconds: this._config.deploymentSeconds,
      pauseMode: this._config.pauseMode
    };

    this._send({ type: 'match-start', ...payload });
    this._beginMatch(payload);
  }

  _beginMatch(payload) {
    const scenario = this._buildScenario(payload);
    if (!scenario) {
      this._setStatus('Could not build the match scenario.');
      return;
    }

    const playerTeamId = this._role === 'host' ? 'blue' : 'red';
    const otherTeamId = playerTeamId === 'blue' ? 'red' : 'blue';

    // Hand the session over to main.js — the lobby no longer needs it and
    // must not tear it down on close, or the battle loses its socket.
    //
    // The lobby's own handlers must be UNSUBSCRIBED first, not merely
    // forgotten: NetSession keeps them registered by reference, and a
    // 'peerLeft' arriving mid-battle would otherwise still call
    // _setStatus + _render on a hidden panel (writing to DOM that no
    // longer has a parent). Clearing the bookkeeping array without
    // calling off() leaks every handler for the lifetime of the socket.
    const session = this._session;
    for (const [type, fn] of this._sessionHandlers) {
      session.off(type, fn);
    }
    this._session = null;
    this._sessionHandlers = [];

    this._root.classList.add('hidden');

    this.onMatchStart({
      session,
      scenario,
      deploymentSeconds: payload.deploymentSeconds,
      pauseMode: payload.pauseMode,
      playerTeamId,
      otherTeamId
    });
  }

  // Rebuilds the same scenario on both peers from the shared payload.
  // Scenario mode: look up by id. Custom mode: build a synthetic scenario
  // from the two rosters via CustomBattleBuilder.
  _buildScenario(payload) {
    if (payload.mode === 'custom') {
      // Imported lazily to keep the lobby's top-level deps small; also
      // lets scenario-mode lobbies run without loading the builder.
      // eslint-disable-next-line no-undef
      const mod = this._customBuilder;
      if (!mod) {
        // Synchronous import fallback: we rely on the fact that
        // CustomBattleBuilder is already loaded by main.js in every
        // normal boot. If it is not, main.js will have imported it
        // anyway by the time a lobby is opened.
        this._setStatus('Internal error: CustomBattleBuilder not loaded.');
        return null;
      }
      const scenario = mod(payload.blueRoster, payload.redRoster, 'blue');
      scenario.aiTeamIds = [];
      return scenario;
    }

    const entry = PlayableScenarios.find(s => s.id === payload.scenarioId);
    if (!entry) {
      this._setStatus(`Scenario "${payload.scenarioId}" not found.`);
      return null;
    }
    return entry;
  }

  // Provided by main.js at construction time so the lobby can call the
  // builder without a top-level import (keeps the dependency graph flat
  // and lets tests pass a stub).
  setCustomBuilder(fn) {
    this._customBuilder = fn;
  }

  // --- state helpers --------------------------------------------------------

  _reset() {
    this._teardownSession();
    this._role = null;
    this._paired = false;
    this._myReady = false;
    this._peerReady = false;
    this._myRoster = [];
    this._peerRoster = [];
    this._skeletonMode = false;
    this._config = {
      mode: 'scenario',
      scenarioId: PlayableScenarios[0]?.id || null,
      powerBudget: DEFAULT_POWER_BUDGET,
      deploymentSeconds: DEFAULT_DEPLOYMENT_SECONDS,
      pauseMode: DEFAULT_PAUSE_MODE
    };
  }

  _myTeamId() {
    return this._role === 'host' ? 'blue' : 'red';
  }

  // Shared power read for the roster summary and the budget gate. Routes
  // through buildPreviewUnit -> UnitPower.compute, the single power
  // formula the AI, Custom Battle, campaign pricing, and the in-battle
  // score all read. Deleting the old preview-only computePreviewPower
  // left every caller of it broken; this helper is the one replacement
  // shape so future call sites in this file don't need to know how
  // preview units are built.
  _powerOf(typeDef, isUndead, aliveCount) {
    const preview = buildPreviewUnit({
      id: 'mp-power-preview',
      typeDef,
      isUndead,
      aliveCount,
      maxCount: aliveCount,
      teamId: 'blue'
    });
    return preview.getPower().total;
  }

  _myTotalPower() {
    let sum = 0;
    for (const e of this._myRoster) {
      const t = UnitTypes[e.typeId];
      if (!t) continue;
      sum += this._powerOf(t, e.isUndead, e.aliveCount);
    }
    return sum;
  }

  _peerTotalPower() {
    let sum = 0;
    for (const e of this._peerRoster) {
      const t = UnitTypes[e.typeId];
      if (!t) continue;
      sum += this._powerOf(t, e.isUndead, e.aliveCount);
    }
    return sum;
  }

  // --- roster editing -------------------------------------------------------

  _addUnit(typeId) {
    const typeDef = UnitTypes[typeId];
    if (!typeDef) return;
    const size = CampaignConfig.defaultSizes[typeId] || 15;
    const isUndead = this._skeletonMode && raceSupportsUndead(typeDef);

    const entry = {
      id: `mp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      typeId,
      isUndead,
      aliveCount: size,
      maxCount: size
    };

    const test = this._myRoster.concat([entry]);
    let sum = 0;
    for (const e of test) {
      const t = UnitTypes[e.typeId];
      if (t) sum += this._powerOf(t, e.isUndead, e.aliveCount);
    }
    if (sum > this._config.powerBudget) {
      this._setStatus(`Adding that would exceed the ${this._config.powerBudget} power budget.`);
      return;
    }

    this._myRoster.push(entry);
    this._broadcastRoster();
    this._render();
  }

  _removeUnit(entryId) {
    const i = this._myRoster.findIndex(e => e.id === entryId);
    if (i < 0) return;
    this._myRoster.splice(i, 1);
    this._broadcastRoster();
    this._render();
  }

  _broadcastRoster() {
    if (!this._session) return;
    this._send({
      type: 'lobby-roster',
      teamId: this._myTeamId(),
      roster: this._myRoster.slice()
    });
  }

  // --- rendering ------------------------------------------------------------

  _build() {
    const root = document.createElement('div');
    root.className = 'mpl-root hidden';

    const style = document.createElement('style');
    style.textContent = `
      .mpl-root {
        position: fixed; inset: 0; z-index: 45;
        background: rgba(8, 10, 14, 0.94);
        display: flex; align-items: center; justify-content: center;
        font-family: monospace; color: #eee;
        overflow-y: auto;
      }
      .mpl-root.hidden { display: none; }
      .mpl-panel {
        background: #1a1f28; border: 1px solid #3a4a5e; border-radius: 10px;
        padding: 20px 24px; width: min(860px, calc(100vw - 40px));
        max-height: calc(100vh - 40px); overflow-y: auto;
        box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      }
      .mpl-title { margin: 0 0 4px; font-size: 20px; letter-spacing: 2px; }
      .mpl-sub { margin: 0 0 18px; font-size: 12px; color: #99a; letter-spacing: 0.5px; }
      .mpl-section { margin: 16px 0; padding-top: 14px; border-top: 1px solid #2a3544; }
      .mpl-section-title { font-size: 11px; color: #8a9ab0; letter-spacing: 1.6px;
        text-transform: uppercase; margin-bottom: 10px; }
      .mpl-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .mpl-label { font-size: 12px; color: #99a; flex: 0 0 130px; }
      .mpl-input, .mpl-select {
        background: #10161e; color: #eee; border: 1px solid #3a4a5e;
        border-radius: 4px; padding: 6px 8px; font-family: inherit; font-size: 13px;
        flex: 1 1 0;
      }
      .mpl-input { letter-spacing: 2px; text-transform: lowercase; }
      .mpl-btn {
        padding: 8px 14px; border-radius: 4px; cursor: pointer;
        border: 1px solid #3a4a5e; background: #26354a; color: #d8e6ff;
        font-family: inherit; font-size: 13px;
      }
      .mpl-btn:hover { background: #33465e; border-color: #6a8ac0; }
      .mpl-btn.host { background: #2c4a2c; border-color: #5a8a4b; }
      .mpl-btn.host:hover { background: #3a6a3a; }
      .mpl-btn.join { background: #2c3a4a; border-color: #5a7a9a; }
      .mpl-btn.join:hover { background: #3a4a6a; }
      .mpl-btn.ready { background: #2c4a2c; border-color: #5a8a4b; font-weight: bold; }
      .mpl-btn.ready:hover { background: #3a6a3a; }
      .mpl-btn.ready.on { background: #3a5a2c; border-color: #8aba4b; }
      .mpl-btn.back { background: #2a2a2a; border-color: #555; color: #ccc; }
      .mpl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .mpl-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
      .mpl-tab {
        padding: 6px 14px; border-radius: 4px; cursor: pointer;
        border: 1px solid #3a4a5e; background: #1e2430; color: #aab;
        font-family: inherit; font-size: 12px; letter-spacing: 0.6px;
      }
      .mpl-tab.active { background: #26354a; border-color: #6a8ac0; color: #e6eef8; }
      .mpl-power-bar {
        height: 8px; background: #10161d; border-radius: 4px; overflow: hidden;
        margin: 6px 0;
      }
      .mpl-power-fill { height: 100%; border-radius: 4px;
        background: linear-gradient(90deg, #4a8a4a, #8ad08a); transition: width 0.15s; }
      .mpl-power-fill.over { background: linear-gradient(90deg, #8a4a2a, #d06a4a); }
      .mpl-palette { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
      .mpl-pal-card {
        width: 96px; padding: 6px; background: #1e2430; border: 1px solid #3a4a5e;
        border-radius: 6px; display: flex; flex-direction: column; align-items: center;
        gap: 4px; cursor: pointer; user-select: none;
      }
      .mpl-pal-card:hover { border-color: #6a8ac0; background: #26354a; }
      .mpl-pal-icon { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; }
      .mpl-pal-icon svg { width: 100%; height: 100%; }
      .mpl-pal-name { font-size: 10px; color: #d8e6ff; text-align: center; }
      .mpl-roster { display: flex; flex-wrap: wrap; gap: 6px; min-height: 40px;
        padding: 6px; background: #0e1218; border: 1px solid #2a3544; border-radius: 4px; }
      .mpl-roster-item {
        position: relative; padding: 4px 20px 4px 6px; background: #1e2430;
        border: 1px solid #3a4a5e; border-radius: 4px; display: flex;
        align-items: center; gap: 6px; font-size: 11px;
      }
      .mpl-remove {
        position: absolute; top: 1px; right: 2px; background: transparent;
        border: none; color: #778; cursor: pointer; font-size: 14px; padding: 0 2px;
      }
      .mpl-remove:hover { color: #f88; }
      .mpl-status { font-size: 12px; color: #aab8c8; min-height: 16px; margin: 12px 0; }
      .mpl-actions { display: flex; gap: 8px; margin-top: 8px; }
      .mpl-skel-row { display: flex; align-items: center; gap: 8px; margin: 10px 0;
        font-size: 12px; color: #aac; cursor: pointer; user-select: none; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(root);

    this._root = root;
  }

  _render() {
    const root = this._root;
    root.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'mpl-panel';

    const title = document.createElement('h2');
    title.className = 'mpl-title';
    title.textContent = 'Multiplayer';
    panel.appendChild(title);

    // Room + role line. Once connected, shows the room code, the local
    // peer's role in bold colour, and the host→team mapping so both
    // peers know which side of the battle is which.
    const sub = document.createElement('p');
    sub.className = 'mpl-sub';

    if (this._role) {
      const roleWord = this._role === 'host' ? 'HOST' : 'GUEST';
      const roleColor = this._role === 'host' ? '#8fd08f' : '#d0a08f';
      const room = this._roomCode || '—';

      sub.innerHTML =
        `Room <b>${room}</b> · You are the `
        + `<b style="color:${roleColor};letter-spacing:1.5px">${roleWord}</b>`
        + (this._role === 'host' ? ' (Blue army)' : ' (Red army)');

      if (this._paired) {
        const map = document.createElement('div');
        map.style.cssText = [
          'margin-top:6px',
          'font-size:11px',
          'color:#7a8a9e',
          'letter-spacing:0.6px'
        ].join(';');
        map.textContent = 'Blue = Host · Red = Guest';
        sub.appendChild(map);
      }
    } else {
      sub.textContent = 'Host or join a room to begin.';
    }
    panel.appendChild(sub);

    // --- same-device option, above the networked options ---
    panel.appendChild(this._buildSameDeviceRow());

    // --- connection section ---
    panel.appendChild(this._buildConnectionSection());

    // --- only show the rest of the lobby once paired ---
    if (this._paired) {
      panel.appendChild(this._buildModeSection());
      if (this._config.mode === 'custom') {
        panel.appendChild(this._buildRosterSection());
      }
      panel.appendChild(this._buildSettingsSection());
    }

    // --- status + actions ---
    const status = document.createElement('div');
    status.className = 'mpl-status';
    status.textContent = this._statusText || '';
    panel.appendChild(status);
    this._statusEl = status;

    const actions = document.createElement('div');
    actions.className = 'mpl-actions';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'mpl-btn back';
    backBtn.textContent = '← Back';
    backBtn.addEventListener('click', () => this.close());
    actions.appendChild(backBtn);

    if (this._paired) {
      const readyBtn = document.createElement('button');
      readyBtn.type = 'button';
      readyBtn.className = 'mpl-btn ready' + (this._myReady ? ' on' : '');
      readyBtn.textContent = this._myReady
        ? 'Ready ✓ (waiting for opponent)'
        : 'Ready';
      readyBtn.disabled = this._myReady;
      readyBtn.addEventListener('click', () => this._playerReady());
      actions.appendChild(readyBtn);
    }

    panel.appendChild(actions);

    root.appendChild(panel);
    this._statusEl.textContent = this._statusText || '';
  }

  _buildConnectionSection() {
    const wrap = document.createElement('div');
    wrap.className = 'mpl-section';

    const title = document.createElement('div');
    title.className = 'mpl-section-title';
    title.textContent = 'Room';
    wrap.appendChild(title);

    const row = document.createElement('div');
    row.className = 'mpl-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mpl-input';
    input.maxLength = 8;
    input.placeholder = 'ab12cd';
    input.value = this._roomCode || randomRoomCode();
    input.disabled = !!this._session;
    input.addEventListener('input', () => {
      this._roomCode = input.value;
    });
    row.appendChild(input);

    const hostBtn = document.createElement('button');
    hostBtn.type = 'button';
    hostBtn.className = 'mpl-btn host';
    hostBtn.textContent = 'Host';
    hostBtn.disabled = !!this._session;
    hostBtn.addEventListener('click', () => {
      const code = sanitise(input.value);
      if (code.length < 3) { this._setStatus('Enter a room code (3+ chars).'); return; }
      this._roomCode = code;
      this._connect(code, 'host');
    });
    row.appendChild(hostBtn);

    const joinBtn = document.createElement('button');
    joinBtn.type = 'button';
    joinBtn.className = 'mpl-btn join';
    joinBtn.textContent = 'Join';
    joinBtn.disabled = !!this._session;
    joinBtn.addEventListener('click', () => {
      const code = sanitise(input.value);
      if (code.length < 3) { this._setStatus('Enter a room code (3+ chars).'); return; }
      this._roomCode = code;
      this._connect(code, 'guest');
    });
    row.appendChild(joinBtn);

    wrap.appendChild(row);
    return wrap;
  }

  _buildSameDeviceRow() {
    const wrap = document.createElement('div');
    wrap.className = 'mpl-section';

    const title = document.createElement('div');
    title.className = 'mpl-section-title';
    title.textContent = 'Same Device';
    wrap.appendChild(title);

    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:12px;color:#aab8c8;margin-bottom:10px;line-height:1.5;';
    desc.textContent = 'Two players sharing this keyboard and mouse. No network, no second device.';
    wrap.appendChild(desc);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mpl-btn same-device';
    btn.style.cssText = 'width:100%;padding:10px 14px;background:#3a2c4a;border-color:#7a5a9a;';
    btn.textContent = 'Same Device — 2 Players, 1 Screen';
    btn.addEventListener('click', () => {
      this._teardownSession();
      this._root.classList.add('hidden');
      this.onSameDevice();
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = '#4a3a6a'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#3a2c4a'; });
    wrap.appendChild(btn);

    return wrap;
  }

  _buildModeSection() {
    const wrap = document.createElement('div');
    wrap.className = 'mpl-section';

    const title = document.createElement('div');
    title.className = 'mpl-section-title';
    title.textContent = 'Match mode';
    wrap.appendChild(title);

    const tabs = document.createElement('div');
    tabs.className = 'mpl-tabs';

    const isHost = this._role === 'host';

    for (const mode of ['scenario', 'custom']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mpl-tab' + (this._config.mode === mode ? ' active' : '');
      btn.textContent = mode === 'scenario' ? 'Scenario' : 'Custom';
      btn.disabled = !isHost;
      btn.addEventListener('click', () => {
        if (!isHost) return;
        this._config.mode = mode;
        this._broadcastConfig();
        this._render();
      });
      tabs.appendChild(btn);
    }
    wrap.appendChild(tabs);

    if (this._config.mode === 'scenario') {
      const row = document.createElement('div');
      row.className = 'mpl-row';

      const label = document.createElement('span');
      label.className = 'mpl-label';
      label.textContent = 'Scenario';
      row.appendChild(label);

      const select = document.createElement('select');
      select.className = 'mpl-select';
      select.disabled = !isHost;
      for (const s of PlayableScenarios) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.displayName || s.name || s.id;
        select.appendChild(opt);
      }
      select.value = this._config.scenarioId || '';
      select.addEventListener('change', () => {
        if (!isHost) return;
        this._config.scenarioId = select.value;
        this._broadcastConfig();
      });
      row.appendChild(select);
      wrap.appendChild(row);
    }

    return wrap;
  }

  _buildRosterSection() {
    const wrap = document.createElement('div');
    wrap.className = 'mpl-section';

    const title = document.createElement('div');
    title.className = 'mpl-section-title';
    title.textContent = 'Your roster';
    wrap.appendChild(title);

    // Power bar for own roster.
    const myPower = this._myTotalPower();
    const budget = this._config.powerBudget;
    const frac = budget > 0 ? Math.min(1, myPower / budget) : 0;

    const barRow = document.createElement('div');
    barRow.style.fontSize = '12px';
    barRow.style.color = '#aab';
    barRow.textContent = `Power: ${Math.round(myPower)} / ${budget}`;
    wrap.appendChild(barRow);

    const bar = document.createElement('div');
    bar.className = 'mpl-power-bar';
    const fill = document.createElement('div');
    fill.className = 'mpl-power-fill' + (myPower > budget ? ' over' : '');
    fill.style.width = (frac * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    wrap.appendChild(bar);

    // Peer roster summary.
    const peerPower = this._peerTotalPower();
    const peerRow = document.createElement('div');
    peerRow.style.fontSize = '12px';
    peerRow.style.color = '#99a';
    peerRow.textContent = `Opponent: ${this._peerRoster.length} unit(s), power ${Math.round(peerPower)}`;
    wrap.appendChild(peerRow);

    // Skeleton toggle.
    const skelRow = document.createElement('label');
    skelRow.className = 'mpl-skel-row';
    const skelCb = document.createElement('input');
    skelCb.type = 'checkbox';
    skelCb.checked = this._skeletonMode;
    skelCb.addEventListener('change', () => {
      this._skeletonMode = skelCb.checked;
      this._render();
    });
    skelRow.appendChild(skelCb);
    const skelLbl = document.createElement('span');
    skelLbl.textContent = 'Skeleton units for new additions';
    skelRow.appendChild(skelLbl);
    wrap.appendChild(skelRow);

    // Palette.
    const palette = document.createElement('div');
    palette.className = 'mpl-palette';
    for (const typeId of UnitFamilies.customBattlePaletteTypeIds()) {
      palette.appendChild(this._buildPaletteCard(typeId));
    }
    wrap.appendChild(palette);

    // Roster list.
    const roster = document.createElement('div');
    roster.className = 'mpl-roster';
    if (this._myRoster.length === 0) {
      roster.style.color = '#556';
      roster.style.fontSize = '12px';
      roster.style.alignItems = 'center';
      roster.textContent = 'No units yet — click a palette entry above.';
    } else {
      for (const e of this._myRoster) {
        roster.appendChild(this._buildRosterItem(e));
      }
    }
    wrap.appendChild(roster);

    return wrap;
  }

  _buildPaletteCard(typeId) {
    const typeDef = UnitTypes[typeId];
    if (!typeDef) return document.createElement('div');
    const isUndead = this._skeletonMode && raceSupportsUndead(typeDef);

    const card = document.createElement('div');
    card.className = 'mpl-pal-card';

    const icon = document.createElement('div');
    icon.className = 'mpl-pal-icon';
    icon.innerHTML = unitIconSvg(typeDef, isUndead);
    card.appendChild(icon);

    const name = document.createElement('div');
    name.className = 'mpl-pal-name';
    name.textContent = typeDef.displayName;
    card.appendChild(name);

    card.addEventListener('click', () => this._addUnit(typeId));
    return card;
  }

  _buildRosterItem(entry) {
    const typeDef = UnitTypes[entry.typeId];
    const item = document.createElement('div');
    item.className = 'mpl-roster-item';

    const label = document.createElement('span');
    label.textContent = `${entry.isUndead ? 'Sk. ' : ''}${typeDef?.displayName || entry.typeId} ×${entry.aliveCount}`;
    item.appendChild(label);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'mpl-remove';
    rm.textContent = '×';
    rm.addEventListener('click', () => this._removeUnit(entry.id));
    item.appendChild(rm);
    return item;
  }

  _buildSettingsSection() {
    const wrap = document.createElement('div');
    wrap.className = 'mpl-section';

    const title = document.createElement('div');
    title.className = 'mpl-section-title';
    title.textContent = 'Match settings';
    wrap.appendChild(title);

    const isHost = this._role === 'host';

    if (this._config.mode === 'custom') {
      const budgetRow = document.createElement('div');
      budgetRow.className = 'mpl-row';

      const bLabel = document.createElement('span');
      bLabel.className = 'mpl-label';
      bLabel.textContent = 'Max power / side';
      budgetRow.appendChild(bLabel);

      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(MIN_POWER_BUDGET);
      range.max = String(MAX_POWER_BUDGET);
      range.step = '50';
      range.value = String(this._config.powerBudget);
      range.disabled = !isHost;
      range.style.flex = '1 1 0';
      range.addEventListener('input', () => {
        this._config.powerBudget = parseInt(range.value, 10);
        this._setStatus('');
      });
      range.addEventListener('change', () => {
        this._broadcastConfig();
        // Re-render so the roster section's "Power: X / Y" line picks up
        // the new budget. Without this, only the label next to the slider
        // updates on the host's own screen until the roster is edited.
        this._render();
      });
      budgetRow.appendChild(range);

      const bVal = document.createElement('span');
      bVal.style.minWidth = '46px';
      bVal.style.textAlign = 'right';
      bVal.textContent = String(this._config.powerBudget);
      budgetRow.appendChild(bVal);

      range.addEventListener('input', () => {
        bVal.textContent = range.value;
      });

      wrap.appendChild(budgetRow);
    }

    const deployRow = document.createElement('div');
    deployRow.className = 'mpl-row';

    const dLabel = document.createElement('span');
    dLabel.className = 'mpl-label';
    dLabel.textContent = 'Deployment time';
    deployRow.appendChild(dLabel);

    const dSelect = document.createElement('select');
    dSelect.className = 'mpl-select';
    dSelect.disabled = !isHost;
    for (const sec of DEPLOYMENT_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = String(sec);
      opt.textContent = sec === 0 ? 'Disabled' : `${sec}s`;
      dSelect.appendChild(opt);
    }
    dSelect.value = String(this._config.deploymentSeconds);
    dSelect.addEventListener('change', () => {
      if (!isHost) return;
      this._config.deploymentSeconds = parseInt(dSelect.value, 10);
      this._broadcastConfig();
    });
    deployRow.appendChild(dSelect);

    wrap.appendChild(deployRow);

    // Pause mode. Applies to both peers. Host-owned, so guest sees the
    // dropdown but cannot change it.
    const pauseRow = document.createElement('div');
    pauseRow.className = 'mpl-row';

    const pLabel = document.createElement('span');
    pLabel.className = 'mpl-label';
    pLabel.textContent = 'Pause mode';
    pauseRow.appendChild(pLabel);

    const pSelect = document.createElement('select');
    pSelect.className = 'mpl-select';
    pSelect.disabled = !isHost;
    for (const pm of PAUSE_MODES) {
      const opt = document.createElement('option');
      opt.value = pm.value;
      opt.textContent = pm.label;
      pSelect.appendChild(opt);
    }
    pSelect.value = this._config.pauseMode;
    pSelect.addEventListener('change', () => {
      if (!isHost) return;
      this._config.pauseMode = pSelect.value;
      this._broadcastConfig();
    });
    pauseRow.appendChild(pSelect);

    wrap.appendChild(pauseRow);

    return wrap;
  }

  _broadcastConfig() {
    if (this._role !== 'host' || !this._session) return;
    this._send({ type: 'lobby-config', config: this._config });
  }

  _setStatus(text) {
    this._statusText = text || '';
    if (this._statusEl) this._statusEl.textContent = this._statusText;
  }
}

function sanitise(raw) {
  return (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
}

function randomRoomCode() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
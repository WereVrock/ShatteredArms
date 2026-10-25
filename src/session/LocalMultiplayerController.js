// Same-device local multiplayer: turn state machine + its own HUD.
//
// Two modes:
//
//   'free'       Both players sit at one screen and issue orders at any
//                time. No turns, no gating. The controller returns a
//                fixed "both teams controllable, both bars visible"
//                state and never fires a change.
//
//   'turnBased'  Alternating turns. Cycle, repeated:
//
//                  DEPLOY_COIN_TOSS   sim frozen. Coin toss decides which
//                                     player deploys first.
//                  DEPLOY_P1          First-deployer repositions their
//                                     team. End Deploy → DEPLOY_P2.
//                  DEPLOY_P2          Second-deployer repositions. End
//                                     Deploy → fires onDeployComplete.
//                  BATTLE_COIN_TOSS   sim frozen. Coin toss decides who
//                                     takes the first turn this cycle.
//                  TURN (P1)          First-turn player orders, End Turn.
//                  TURN (P2)          Second-turn player orders, End Turn.
//                  INTERVAL           sim runs unpaused for intervalSeconds.
//                  → back to BATTLE_COIN_TOSS
//
// Team mapping is fixed: Player 1 = blue, Player 2 = red. The coin toss
// decides ORDER WITHIN A PHASE (who deploys first, who turns first this
// cycle) — it never decides which team is which player.
//
// The controller owns three DOM pieces: an interval/turn banner, a
// single context-sensitive action button (End Deploy / End Turn), and
// the coin toss overlay (delegated to CoinTossView). It does NOT own the
// army bars — main.js reads getState() each frame. It does NOT own the
// sim — main.js reads isPaused() and folds it into its effectivePaused.
//
// Pure of sim / scene knowledge: no imports from sim/, render/, or config/.

import { CoinTossView } from '../ui/CoinTossView.js';

export const LM_MODE = {
  FREE: 'free',
  TURN_BASED: 'turnBased'
};

export const LM_PHASE = {
  DEPLOY_COIN_TOSS: 'deployCoinToss',
  DEPLOY_P1: 'deployP1',
  DEPLOY_P2: 'deployP2',
  BATTLE_COIN_TOSS: 'battleCoinToss',
  TURN: 'turn',
  INTERVAL: 'interval',
  DONE: 'done'
};

const TEAM_P1 = 'blue';
const TEAM_P2 = 'red';
const BOTH_TEAMS = ['blue', 'red'];

function playerLabelForTeam(teamId) {
  return teamId === TEAM_P1 ? 'Player 1' : 'Player 2';
}
function teamLabelForTeam(teamId) {
  return teamId === TEAM_P1 ? 'Blue' : 'Red';
}
function otherTeam(teamId) {
  return teamId === TEAM_P1 ? TEAM_P2 : TEAM_P1;
}

export class LocalMultiplayerController {
  // opts:
  //   mode               — LM_MODE.FREE | LM_MODE.TURN_BASED
  //   intervalSeconds    — turn-based only. Seconds of unpaused sim between
  //                        turn cycles.
  //   onStateChange      — optional. Fired whenever the phase or active
  //                        team changes. main.js uses it to re-apply
  //                        selection gating immediately.
  //   onDeployComplete   — optional. Fired once the second deployer clicks
  //                        End Deploy. main.js wires this to
  //                        deploymentPhase.startBattle().
  constructor(opts = {}) {
    this.mode = opts.mode || LM_MODE.FREE;
    this.intervalSeconds = opts.intervalSeconds || 30;
    this.onStateChange = opts.onStateChange || null;
    this.onDeployComplete = opts.onDeployComplete || null;

    this._phase = this.mode === LM_MODE.TURN_BASED
      ? LM_PHASE.DEPLOY_COIN_TOSS
      : LM_PHASE.DONE;
    this._activeTeamId = null;
    this._firstDeployerTeamId = null;
    // Whoever won the battle coin toss. Both players get one turn per
    // cycle: this team goes first, the OTHER team goes second. The
    // interval begins only when the SECOND player ends their turn.
    // Without this field the code assumed P1 always went first, so a
    // coin toss that picked P2 sent the cycle straight to interval and
    // P1 never played.
    this._firstTurnTeamId = null;
    this._intervalTimeLeft = this.intervalSeconds;

    this._coinToss = new CoinTossView();
    this._hudEl = null;
    this._bannerEl = null;
    this._actionBtn = null;

    if (this.mode === LM_MODE.TURN_BASED) {
      this._buildHud();
      // Defer the first coin toss so the constructor returns before the
      // overlay appears. main.js finishes wiring the deployment phase
      // synchronously after this constructor returns.
      setTimeout(() => this._startDeployCoinToss(), 0);
    }
    this._renderHud();
  }

  // --- public API ----------------------------------------------------------

  // Called by main.js when the deployment phase ends (its onBattleStart
  // hook). Turn-based: DEPLOY_P2 → BATTLE_COIN_TOSS. Free: no-op.
  beginBattle() {
    if (this.mode !== LM_MODE.TURN_BASED) return;
    if (this._phase !== LM_PHASE.DONE) return;
    this._startBattleCoinToss();
  }

  // True when the sim should be frozen by this controller. Deploy phases
  // return false — the DeploymentPhase freezes the sim on its own.
  isPaused() {
    if (this.mode === LM_MODE.FREE) return false;
    if (this._phase === LM_PHASE.DEPLOY_P1) return false;
    if (this._phase === LM_PHASE.DEPLOY_P2) return false;
    if (this._phase === LM_PHASE.INTERVAL) return false;
    if (this._phase === LM_PHASE.DONE) return false;
    return true;
  }

  // Teams that may be selected / ordered right now.
  getControllableTeamIds() {
    if (this.mode === LM_MODE.FREE) return BOTH_TEAMS.slice();

    if (this._phase === LM_PHASE.DEPLOY_P1
        || this._phase === LM_PHASE.DEPLOY_P2) {
      return this._activeTeamId ? [this._activeTeamId] : [];
    }
    if (this._phase === LM_PHASE.TURN && this._activeTeamId) {
      return [this._activeTeamId];
    }
    if (this._phase === LM_PHASE.DONE) return BOTH_TEAMS.slice();
    return [];
  }

  // Called every render frame from main.js's loop.
  update(deltaSeconds) {
    if (this.mode !== LM_MODE.TURN_BASED) return;
    if (this._phase !== LM_PHASE.INTERVAL) return;

    this._intervalTimeLeft = Math.max(0, this._intervalTimeLeft - deltaSeconds);
    this._renderHud();

    if (this._intervalTimeLeft <= 0) this._startBattleCoinToss();
  }

  // Current state snapshot for main.js's per-frame reads.
  getState() {
    return {
      mode: this.mode,
      phase: this._phase,
      activeTeamId: this._activeTeamId,
      showBlueBar: this._showBar(TEAM_P1),
      showRedBar: this._showBar(TEAM_P2),
      isPaused: this.isPaused()
    };
  }

  dispose() {
    if (this._hudEl && this._hudEl.parentNode) {
      this._hudEl.parentNode.removeChild(this._hudEl);
    }
    this._hudEl = null;
    this._bannerEl = null;
    this._actionBtn = null;
    this._coinToss.dispose();
  }

  // --- state machine -------------------------------------------------------

  _startDeployCoinToss() {
    this._phase = LM_PHASE.DEPLOY_COIN_TOSS;
    this._activeTeamId = null;
    this._notify();

    this._coinToss.show((winnerTeamId) => {
      this._firstDeployerTeamId = winnerTeamId;
      this._phase = LM_PHASE.DEPLOY_P1;
      this._activeTeamId = winnerTeamId;
      this._notify();
    });
  }

  _startBattleCoinToss() {
    this._phase = LM_PHASE.BATTLE_COIN_TOSS;
    this._activeTeamId = null;
    this._notify();

    this._coinToss.show((winnerTeamId) => {
      this._firstTurnTeamId = winnerTeamId;
      this._phase = LM_PHASE.TURN;
      this._activeTeamId = winnerTeamId;
      this._notify();
    });
  }

  _enterInterval() {
    this._phase = LM_PHASE.INTERVAL;
    this._activeTeamId = null;
    this._firstTurnTeamId = null;
    this._intervalTimeLeft = this.intervalSeconds;
    this._notify();
  }

  _endDeploy() {
    if (this._phase === LM_PHASE.DEPLOY_P1) {
      this._phase = LM_PHASE.DEPLOY_P2;
      this._activeTeamId = otherTeam(this._firstDeployerTeamId);
      this._notify();
    } else if (this._phase === LM_PHASE.DEPLOY_P2) {
      // Both players have deployed. Mark the deploy half done, then fire
      // the callback — main.js calls deploymentPhase.startBattle(),
      // whose onBattleStart calls our beginBattle() synchronously.
      this._phase = LM_PHASE.DONE;
      this._activeTeamId = null;
      this._notify();
      if (this.onDeployComplete) this.onDeployComplete();
    }
  }

  _endTurn() {
    if (this._phase !== LM_PHASE.TURN) return;

    // Both players get a turn each cycle. The first-turn team is the coin
    // toss winner; the second is the other team. When the SECOND player
    // ends their turn, the interval begins. Comparing against the first-
    // turn team rather than hardcoding P1 is what makes the cycle work
    // when the coin toss picks red.
    if (this._activeTeamId === this._firstTurnTeamId) {
      this._activeTeamId = otherTeam(this._firstTurnTeamId);
      this._notify();
    } else {
      this._enterInterval();
    }
  }

  _handleActionClick() {
    if (this._phase === LM_PHASE.TURN) this._endTurn();
    else if (this._phase === LM_PHASE.DEPLOY_P1
          || this._phase === LM_PHASE.DEPLOY_P2) this._endDeploy();
  }

  _notify() {
    this._renderHud();
    if (this.onStateChange) this.onStateChange(this.getState());
  }

  _showBar(teamId) {
    if (this.mode === LM_MODE.FREE) return true;
    if (this._phase === LM_PHASE.DEPLOY_P1
        || this._phase === LM_PHASE.DEPLOY_P2) {
      return this._activeTeamId === teamId;
    }
    if (this._phase === LM_PHASE.TURN) return this._activeTeamId === teamId;
    if (this._phase === LM_PHASE.DONE) return true;
    return false;
  }

  // --- HUD -----------------------------------------------------------------

  _buildHud() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:16px', 'left:50%',
      'transform:translateX(-50%)',
      'z-index:21',
      'display:none', 'flex-direction:column',
      'align-items:center', 'gap:8px',
      'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
      'pointer-events:none', 'user-select:none'
    ].join(';');

    const banner = document.createElement('div');
    banner.style.cssText = [
      'padding:10px 22px',
      'background:rgba(20,30,45,0.9)',
      'border:1px solid #3a4a5e', 'border-radius:5px',
      'color:#eef2f8', 'font-size:16px', 'font-weight:600',
      'letter-spacing:1px', 'font-variant-numeric:tabular-nums',
      'text-align:center', 'min-width:260px'
    ].join(';');
    el.appendChild(banner);

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.textContent = 'End Turn';
    actionBtn.style.cssText = [
      'padding:10px 32px', 'font-size:14px', 'font-weight:600',
      'letter-spacing:0.6px', 'color:#ffffff',
      'background:#2e7d32', 'border:1px solid #1b5e20',
      'border-radius:5px', 'cursor:pointer', 'pointer-events:auto',
      'box-shadow:0 2px 8px rgba(0,0,0,0.45)', 'display:none'
    ].join(';');
    actionBtn.addEventListener('mouseenter', () => { actionBtn.style.background = '#388e3c'; });
    actionBtn.addEventListener('mouseleave', () => { actionBtn.style.background = '#2e7d32'; });
    actionBtn.addEventListener('click', () => this._handleActionClick());
    el.appendChild(actionBtn);

    document.body.appendChild(el);
    this._hudEl = el;
    this._bannerEl = banner;
    this._actionBtn = actionBtn;
  }

  _renderHud() {
    if (!this._hudEl) return;

    if (this._phase === LM_PHASE.DONE && this.mode === LM_MODE.FREE) {
      this._hudEl.style.display = 'none';
      return;
    }
    this._hudEl.style.display = 'flex';

    const showAction = (label, color) => {
      this._actionBtn.textContent = label;
      this._actionBtn.style.background = color;
      this._actionBtn.style.display = '';
    };
    const hideAction = () => { this._actionBtn.style.display = 'none'; };

    switch (this._phase) {
      case LM_PHASE.DEPLOY_COIN_TOSS:
        this._bannerEl.textContent = 'Coin toss — deciding who deploys first…';
        this._bannerEl.style.color = '#d0c8a0';
        hideAction();
        break;

      case LM_PHASE.DEPLOY_P1:
      case LM_PHASE.DEPLOY_P2: {
        const who = playerLabelForTeam(this._activeTeamId);
        const team = teamLabelForTeam(this._activeTeamId);
        this._bannerEl.textContent = `${who} (${team}) — Deploy your forces`;
        this._bannerEl.style.color = this._activeTeamId === TEAM_P1 ? '#8fb4da' : '#dc9090';
        showAction('End Deploy', '#2a5580');
        break;
      }

      case LM_PHASE.BATTLE_COIN_TOSS:
        this._bannerEl.textContent = 'Coin toss — deciding who moves first…';
        this._bannerEl.style.color = '#d0c8a0';
        hideAction();
        break;

      case LM_PHASE.TURN: {
        const who = playerLabelForTeam(this._activeTeamId);
        const team = teamLabelForTeam(this._activeTeamId);
        this._bannerEl.textContent = `${who}'s Turn (${team})`;
        this._bannerEl.style.color = this._activeTeamId === TEAM_P1 ? '#8fb4da' : '#dc9090';
        showAction('End Turn', '#2e7d32');
        break;
      }

      case LM_PHASE.INTERVAL: {
        const secs = Math.ceil(this._intervalTimeLeft);
        this._bannerEl.textContent = `Both players watch — next cycle in ${secs}s`;
        this._bannerEl.style.color = '#cdd6e2';
        hideAction();
        break;
      }

      default:
        this._hudEl.style.display = 'none';
    }
  }
}
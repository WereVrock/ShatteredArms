// Multiplayer pause controller. Owns the pause state machine for one peer
// and synchronises it with the other peer over NetSession. Five modes,
// selected by the host in the lobby:
//
//   free          Either peer toggles pause freely. Simplest mode.
//   voted         Both peers must vote pause to pause; both must vote
//                 unpause to unpause. Each peer sees the other's vote.
//   limited       Each peer gets 5 discrete pauses of 30s. Initiating a
//                 pause consumes one; it auto-ends after 30s.
//   timed         Each peer gets ONE pool of 60 seconds. Pausing draws the
//                 pool down while paused; unpausing freezes it wherever it
//                 stopped. Pool exhausted → cannot pause again. Both
//                 peers' pools are displayed to both peers.
//   accumulative  Starts with 1 pause; gains +1 every 2 minutes of
//                 unpaused time, capped at 3. Each pause lasts up to 30s.
//
// Host authority: the host is authoritative for effective pause state in
// free and voted modes (guest's input is a request; host applies and
// broadcasts). In limited, timed and accumulative modes each peer is
// authoritative for their own pool / count and initiation — the peer who
// pressed pause owns that pause and controls its end.
//
// main.js reads isPaused() every frame instead of a local flag, and calls
// update(frameDelta) so timers keep ticking while paused.
//
// Three pieces of UI (see _buildUI):
//   OVERLAY  — persistent top-center line showing mode + live state.
//   BANNER   — large centered "PAUSED" element while the sim is frozen.
//   TOAST    — ephemeral message near the bottom for one-shot events.

const OVERLAY_ID = 'mp-pause-overlay';
const BANNER_ID = 'mp-pause-banner';
const TOAST_ID = 'mp-pause-toast';

export class MPPauseController {
  constructor(opts) {
    this.mode = opts.mode || 'free';
    this.session = opts.session;
    this.isHost = !!opts.isHost;
    this.myTeamId = opts.myTeamId;
    this.otherTeamId = opts.otherTeamId;

    // Mode-specific parameters. Fixed per spec — no lobby UI exposes them.
    this.pauseDurationSeconds = 30;   // cap per pause (limited, accumulative)
    this.limitedPauses = 5;
    this.startingPauses = 1;
    this.maxPauses = 3;
    this.accumulateEverySeconds = 120;
    this.timedBudgetSeconds = 60;     // total pool per peer in 'timed' mode

    // Effective state: what main.js reads to freeze the sim.
    this._effectivePaused = false;

    // Voted mode: each peer's vote. Both agree → apply.
    this._myVote = false;
    this._peerVote = false;

    // Discrete modes (limited, accumulative): per-peer counts and the
    // current timed pause.
    this._myPauseCount = this._initialCount();
    this._peerPauseCount = this._initialCount();
    this._pauseTimeLeft = 0;      // seconds remaining in the active pause
    this._pausingTeam = null;     // which team initiated the active pause
    this._accumulator = 0;        // accumulative mode: unpaused seconds

    // Timed mode: per-peer remaining pool. Each peer is authoritative for
    // their own value; the peer's value is tracked locally from their
    // last message and ticked down while they hold an active pause.
    this._myTimeLeft = this.timedBudgetSeconds;
    this._peerTimeLeft = this.timedBudgetSeconds;

    this._wireSession();
    this._buildUI();
    this._refreshUI();
  }

  _initialCount() {
    if (this.mode === 'limited') return this.limitedPauses;
    if (this.mode === 'accumulative') return this.startingPauses;
    return 0;
  }

  _wireSession() {
    const s = this.session;
    s.on('pause-set',   (m) => this._onPauseSet(m));
    s.on('pause-state', (m) => this._onPauseState(m));
    s.on('pause-vote',  (m) => this._onPeerVote(m));
    s.on('pause-count', (m) => this._onPeerCount(m));
    s.on('pause-begin', (m) => this._onPauseBegin(m));
    s.on('pause-end',   (m) => this._onPauseEnd(m));
  }

  // --- public API ----------------------------------------------------------

  isPaused() { return this._effectivePaused; }

  requestToggle() {
    switch (this.mode) {
      case 'free':         return this._requestToggleFree();
      case 'voted':        return this._requestToggleVoted();
      case 'limited':
      case 'accumulative': return this._requestToggleTimed();
      case 'timed':        return this._requestToggleBudget();
    }
  }

  // Called every render frame with frame delta in seconds. Drives the
  // timed-pause countdown and the accumulative gain timer. Runs even when
  // the sim is paused — that is the point.
  update(deltaSeconds) {
    if (this.mode === 'timed') {
      this._updateTimedBudget(deltaSeconds);
      return;
    }

    // Discrete-mode 30s cap.
    if ((this.mode === 'limited' || this.mode === 'accumulative') &&
        this._effectivePaused && this._pausingTeam) {
      this._pauseTimeLeft = Math.max(0, this._pauseTimeLeft - deltaSeconds);
      if (this._pauseTimeLeft <= 0) {
        const iAmInitiator = this._pausingTeam === this.myTeamId;
        this._effectivePaused = false;
        this._pauseTimeLeft = 0;
        this._pausingTeam = null;
        if (iAmInitiator) this._send({ type: 'pause-end', by: this.myTeamId });
      }
      this._refreshUI();
    }

    // Accumulative gain. Counts unpaused wall-clock time only.
    if (this.mode === 'accumulative' && !this._effectivePaused) {
      this._accumulator += deltaSeconds;
      if (this._accumulator >= this.accumulateEverySeconds) {
        this._accumulator -= this.accumulateEverySeconds;
        if (this._myPauseCount < this.maxPauses) {
          this._myPauseCount++;
          this._send({ type: 'pause-count', count: this._myPauseCount });
          this._toast(`+1 pause available (${this._myPauseCount}/${this.maxPauses})`);
        }
      }
      this._refreshUI();
    }
  }

  dispose() {
    for (const id of [OVERLAY_ID, BANNER_ID, TOAST_ID]) {
      const el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    this._overlay = null;
    this._banner = null;
    this._toastEl = null;
  }

  // --- free ---------------------------------------------------------------

  _requestToggleFree() {
    if (this.isHost) {
      this._applyEffective(!this._effectivePaused);
      this._send({ type: 'pause-state', paused: this._effectivePaused });
    } else {
      this._send({ type: 'pause-set', paused: !this._effectivePaused });
    }
  }

  // --- voted --------------------------------------------------------------

  _requestToggleVoted() {
    this._myVote = !this._myVote;
    this._send({ type: 'pause-vote', vote: this._myVote });
    this._recomputeVoted();
  }

  _recomputeVoted() {
    if (this._myVote === this._peerVote && this._myVote !== this._effectivePaused) {
      if (this.isHost) {
        this._applyEffective(this._myVote);
        this._send({ type: 'pause-state', paused: this._effectivePaused });
      }
    }
    this._refreshUI();
  }

  // --- limited + accumulative (discrete count, 30s cap per pause) ---------

  _requestToggleTimed() {
    if (this._effectivePaused) {
      if (this._pausingTeam === this.myTeamId) {
        this._sendPauseEnd();
      } else {
        this._toast('Only the initiating player can unpause early.');
      }
      return;
    }
    if (this._myPauseCount <= 0) {
      this._toast('No pauses remaining.');
      return;
    }
    this._myPauseCount--;
    this._send({ type: 'pause-count', count: this._myPauseCount });
    this._send({
      type: 'pause-begin',
      by: this.myTeamId,
      duration: this.pauseDurationSeconds
    });
    this._applyTimedPause(this.pauseDurationSeconds, this.myTeamId);
  }

  // --- timed (60s budget per peer, drawn down while paused) ---------------

  _requestToggleBudget() {
    if (this._effectivePaused) {
      if (this._pausingTeam === this.myTeamId) {
        this._send({
          type: 'pause-end',
          by: this.myTeamId,
          timeLeft: this._myTimeLeft
        });
        this._effectivePaused = false;
        this._pausingTeam = null;
        this._refreshUI();
      } else {
        this._toast('Only the initiating player can unpause early.');
      }
      return;
    }
    if (this._myTimeLeft <= 0) {
      this._toast('Your pause budget is exhausted.');
      return;
    }
    this._send({
      type: 'pause-begin',
      by: this.myTeamId,
      timeLeft: this._myTimeLeft
    });
    this._effectivePaused = true;
    this._pausingTeam = this.myTeamId;
    this._refreshUI();
  }

  _updateTimedBudget(deltaSeconds) {
    if (!this._effectivePaused || !this._pausingTeam) return;

    if (this._pausingTeam === this.myTeamId) {
      this._myTimeLeft = Math.max(0, this._myTimeLeft - deltaSeconds);
      if (this._myTimeLeft <= 0) {
        this._send({ type: 'pause-end', by: this.myTeamId, timeLeft: 0 });
        this._effectivePaused = false;
        this._pausingTeam = null;
        this._toast('Pause budget exhausted — resuming.');
      }
    } else {
      // Peer is pausing. Tick their displayed timer locally; they are
      // authoritative and will send the final value on pause-end, so any
      // accumulation of network jitter is corrected on that message.
      this._peerTimeLeft = Math.max(0, this._peerTimeLeft - deltaSeconds);
    }
    this._refreshUI();
  }

  // --- message handlers ---------------------------------------------------

  _onPauseSet(m) {
    if (!this.isHost) return;
    this._applyEffective(!!m.paused);
    this._send({ type: 'pause-state', paused: this._effectivePaused });
  }

  _onPauseState(m) {
    if (this.isHost) return;
    this._applyEffective(!!m.paused);
  }

  _onPeerVote(m) {
    this._peerVote = !!m.vote;
    if (this.mode === 'voted') this._recomputeVoted();
    this._toast(`Opponent voted to ${this._peerVote ? 'pause' : 'unpause'}.`);
  }

  _onPeerCount(m) {
    this._peerPauseCount = Math.max(0, m.count | 0);
    this._refreshUI();
  }

  _onPauseBegin(m) {
    if (m.by === this.myTeamId) return; // our own echo, ignore

    if (this.mode === 'timed') {
      // Peer's pause-begin carries their current pool value. Adopt it as
      // our displayed starting point, then tick down locally in update().
      this._peerTimeLeft = Math.max(0, m.timeLeft | 0);
      this._effectivePaused = true;
      this._pausingTeam = m.by;
      this._refreshUI();
      this._toast(`Opponent paused (${Math.ceil(this._peerTimeLeft)}s budget left).`);
    } else {
      this._applyTimedPause(m.duration, m.by);
      this._toast('Opponent paused the game.');
    }
  }

  _onPauseEnd(m) {
    if (m.by === this.myTeamId) return;

    if (this.mode === 'timed') {
      if (typeof m.timeLeft === 'number') {
        this._peerTimeLeft = Math.max(0, m.timeLeft);
      }
      this._effectivePaused = false;
      this._pausingTeam = null;
      this._refreshUI();
    } else {
      this._effectivePaused = false;
      this._pauseTimeLeft = 0;
      this._pausingTeam = null;
      this._refreshUI();
    }
  }

  // --- internals ----------------------------------------------------------

  _applyEffective(paused) {
    if (paused === this._effectivePaused) return;
    this._effectivePaused = paused;
    this._refreshUI();
  }

  _applyTimedPause(duration, by) {
    this._effectivePaused = true;
    this._pauseTimeLeft = duration;
    this._pausingTeam = by;
    this._refreshUI();
  }

  _sendPauseEnd() {
    this._send({ type: 'pause-end', by: this.myTeamId });
    this._effectivePaused = false;
    this._pauseTimeLeft = 0;
    this._pausingTeam = null;
    this._refreshUI();
  }

  _send(msg) {
    if (this.session) this.session.send(msg);
  }

  // --- UI -----------------------------------------------------------------

  _buildUI() {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      el.style.cssText = [
        // Anchored top-left, directly below #topBar (the Restart / Menu /
        // Info buttons). Reads as control-area info rather than a modal
        // overlay. No transform — left edge lines up with the buttons.
        'position:fixed', 'top:44px', 'left:8px',
        'z-index:19',
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
        'font-size:13px', 'color:#eef2f8',
        'background:rgba(20,30,45,0.85)',
        'border:1px solid #3a4a5e', 'border-radius:5px',
        'padding:6px 14px', 'letter-spacing:0.3px',
        'pointer-events:none', 'user-select:none',
        // pre-line: newlines are real line breaks, other whitespace is
        // collapsed. Accumulative and timed modes use \n to stack
        // "You" and "Opponent" on separate lines; the other modes emit a
        // single line and render identically to before.
        'white-space:pre-line',
        'text-align:left',
        'line-height:1.5'
      ].join(';');
      document.body.appendChild(el);
    }
    this._overlay = el;

    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.textContent = 'PAUSED';
      banner.style.cssText = [
        'position:fixed', 'top:30%', 'left:50%',
        'transform:translate(-50%,-50%)',
        'z-index:200',
        'font-family:monospace', 'font-weight:bold',
        'font-size:52px', 'letter-spacing:12px',
        'color:#ffffff',
        'text-shadow:0 0 16px rgba(0,0,0,0.85), 0 4px 0 rgba(0,0,0,0.55)',
        'pointer-events:none', 'user-select:none',
        'display:none'
      ].join(';');
      document.body.appendChild(banner);
    }
    this._banner = banner;

    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.style.cssText = [
        'position:fixed', 'bottom:120px', 'left:50%',
        'transform:translateX(-50%)',
        'z-index:201',
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
        'font-size:14px', 'color:#ffffff',
        'background:rgba(20,30,45,0.92)',
        'border:1px solid #5a7a9a', 'border-radius:5px',
        'padding:8px 18px',
        'pointer-events:none', 'user-select:none',
        'box-shadow:0 4px 16px rgba(0,0,0,0.5)',
        'opacity:0', 'transition:opacity 0.2s',
        'white-space:nowrap'
      ].join(';');
      document.body.appendChild(toast);
    }
    this._toastEl = toast;
    this._toastTimer = null;
  }

  _toast(text) {
    if (!this._toastEl) return;
    this._toastEl.textContent = text;
    this._toastEl.style.opacity = '1';
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      if (this._toastEl) this._toastEl.style.opacity = '0';
    }, 2200);
  }

  _refreshUI() {
    if (!this._overlay) return;

    let text = '';

    if (this.mode === 'free') {
      text = 'Pause mode: Toggled · either player can pause freely';

    } else if (this.mode === 'voted') {
      text = `Voted pause — You: ${this._myVote ? '⏸ pause' : '▶ unpause'}`
           + ` · Opponent: ${this._peerVote ? '⏸ pause' : '▶ unpause'}`;

    } else if (this.mode === 'limited') {
      const timer = this._effectivePaused
        ? ` · ${Math.ceil(this._pauseTimeLeft)}s left` : '';
      text = `Pauses — You: ${this._myPauseCount} · Opponent: ${this._peerPauseCount}`
           + timer;

    } else if (this.mode === 'accumulative') {
      // Two lines: header, then one row per peer. The player's own
      // count carries the "next +1" hint and any active-pause timer;
      // the opponent's row stays clean so scanning either side is a
      // single read.
      const timer = this._effectivePaused
        ? ` · ${Math.ceil(this._pauseTimeLeft)}s left` : '';
      const nextIn = Math.max(0, this.accumulateEverySeconds - this._accumulator);
      const gain = this._myPauseCount < this.maxPauses
        ? ` · next +1 in ${Math.ceil(nextIn)}s`
        : ' · max';

      text = 'Accumulative pauses'
           + `\nYou: ${this._myPauseCount}${gain}${timer}`
           + `\nOpponent: ${this._peerPauseCount}`;

    } else if (this.mode === 'timed') {
      // Two lines: header, then one row per peer. A ⏸ marks the peer
      // whose pool is currently draining. Whole seconds only, so the
      // readout does not jitter at 60fps.
      const myActive = this._effectivePaused && this._pausingTeam === this.myTeamId;
      const peerActive = this._effectivePaused && this._pausingTeam === this.otherTeamId;

      const mySecs = Math.ceil(this._myTimeLeft);
      const peerSecs = Math.ceil(this._peerTimeLeft);

      const myLabel = mySecs > 0
        ? `${mySecs}s${myActive ? ' ⏸' : ''}`
        : '0s (exhausted)';
      const peerLabel = peerSecs > 0
        ? `${peerSecs}s${peerActive ? ' ⏸' : ''}`
        : '0s (exhausted)';

      text = 'Timed pause'
           + `\nYou: ${myLabel}`
           + `\nOpponent: ${peerLabel}`;
    }

    this._overlay.textContent = text;
    this._overlay.style.display = text ? 'block' : 'none';

    if (this._banner) {
      this._banner.style.display = this._effectivePaused ? 'block' : 'none';
      if (this._effectivePaused) {
        if (this.mode === 'limited' || this.mode === 'accumulative') {
          this._banner.textContent = `PAUSED  ${Math.ceil(this._pauseTimeLeft)}s`;
        } else if (this.mode === 'timed') {
          const t = this._pausingTeam === this.myTeamId
            ? this._myTimeLeft
            : this._peerTimeLeft;
          this._banner.textContent = `PAUSED  ${Math.ceil(t)}s`;
        } else {
          this._banner.textContent = 'PAUSED';
        }
      }
    }
  }
}
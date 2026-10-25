// Multiplayer pre-battle placement.
//
// Both peers place their OWN team inside their own deployment zone. The
// opponent's placement is invisible until both are done — that is the
// point of hiding it. When a peer is finished (Ready button OR timer
// expiry), they package their own team's live positions and send them.
// When both sides have both (a) sent their own placement and (b)
// received the peer's, both locally apply the peer's positions to the
// OTHER team's units, mark themselves done, and call onComplete.
//
// The interface matches the single-player DeploymentPhase just enough
// that OrderDragController can route player moves through it unchanged:
//   - isActive()
//   - getZone(teamId)
//   - tryPlayerMoveBatch(moves)
//   - getHiddenTeamId()  ← MP-specific, read by main.js's render filter
//
// The sim is frozen while active: BattleSimulation.tick() early-returns
// when its deploymentPhase.isActive() is true, which is the same gate the
// SP phase uses.
//
// Pure of any rendering: the deployment zone overlay is drawn by
// DeploymentZoneView in main.js, same as SP. This class only owns state
// and the countdown timer UI.

export class MPDeploymentPhase {
  // @param simulation       the live BattleSimulation
  // @param opts.myTeamId    the team this peer controls
  // @param opts.otherTeamId the peer's team
  // @param opts.session     the connected NetSession
  // @param opts.seconds     countdown duration; 0 disables the timer
  // @param opts.myZone      DeploymentZone for the local team
  // @param opts.otherZone   DeploymentZone for the peer's team
  // @param opts.onComplete  called once both sides are deployed
  constructor(simulation, opts) {
    this.simulation = simulation;
    this.myTeamId = opts.myTeamId;
    this.otherTeamId = opts.otherTeamId;
    this.session = opts.session;
    this.totalSeconds = opts.seconds ?? 45;
    this.myZone = opts.myZone || null;
    this.otherZone = opts.otherZone || null;
    this.onComplete = opts.onComplete || (() => {});

    this._active = true;
    this._myReady = false;
    this._peerDeployment = null;
    this._timeLeft = this.totalSeconds;

    this._handlers = [];
    this._wireSession();

    this._overlay = this._buildOverlay();
    document.body.appendChild(this._overlay);

    this._renderTimer();
  }

  isActive() { return this._active; }

  // Only the LOCAL team's zone is exposed for rendering. The peer's zone
  // is deliberately not visible to this peer (matches SP, where the enemy
  // zone is never drawn either).
  getZone(teamId) {
    if (teamId === this.myTeamId) return this.myZone;
    return null;
  }

  // Team whose soldiers must be filtered out of the render list while
  // deployment is active — the opponent's. main.js reads this each frame
  // and skips the returned team's soldiers.
  getHiddenTeamId() { return this.otherTeamId; }

  // Called from the render loop with frame delta in seconds. Only the
  // timer path drives anything; the sim is frozen while active.
  update(deltaSeconds) {
    if (!this._active) return;
    if (this.totalSeconds <= 0) return;
    if (this._myReady) return;

    this._timeLeft = Math.max(0, this._timeLeft - deltaSeconds);
    this._renderTimer();

    if (this._timeLeft <= 0) {
      this._playerReady();
    }
  }

  // Player hit the Ready button — skip the countdown.
  playerReadyNow() {
    if (this._active && !this._myReady) this._playerReady();
  }

  // Drag-controller entry point. Each move carries a unit reference plus
  // target coordinates and facing; only units of the local team are
  // accepted, and every destination must lie inside the local zone. If
  // any destination fails, the whole batch is rejected — same all-or-
  // nothing contract as SP.
  //
  // DeploymentZone exposes `contains(x, z)` (see DeploymentZone.js); the
  // pre-patch `.containsPoint()` name does not exist.
  tryPlayerMoveBatch(moves) {
    if (!this._active) return;
    if (!Array.isArray(moves) || moves.length === 0) return;

    for (const m of moves) {
      if (!m.unit || m.unit.teamId !== this.myTeamId) return;
      if (this.myZone && !this.myZone.contains(m.x, m.z)) return;
    }

    for (const m of moves) {
      const u = m.unit;
      if (m.widthUnits) {
        u.issueInstantFormationOrder(m.x, m.z, m.facing ?? u.formationFacing, m.widthUnits);
      } else {
        u.issueInstantMoveOrder(m.x, m.z, m.facing ?? u.formationFacing);
      }
    }
  }

  // Abort on peer disconnect. Nothing else has to happen — main.js will
  // show the peer-left overlay.
  abort() {
    this._active = false;
    this._teardown();
  }

  // --- internals ------------------------------------------------------------

  _wireSession() {
    const onDeploy = (msg) => this._onPeerDeployment(msg);
    this.session.on('deployment', onDeploy);
    this._handlers.push(['deployment', onDeploy]);
  }

  _teardown() {
    for (const [type, fn] of this._handlers) this.session.off(type, fn);
    this._handlers = [];
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    this._overlay = null;
  }

  _playerReady() {
    if (this._myReady) return;
    this._myReady = true;

    // Send formationOrigin, NOT getCenter(). issueInstantMoveOrder takes
    // its (x, z) argument as the formation ANCHOR (it writes
    // this.formationOrigin = { x, z } and derives every soldier's slot
    // from that). getCenter() returns the mean soldier position, which
    // for a rectangular grid sits roughly one half-formation away from
    // the anchor — sending it would place the peer's copy visibly
    // offset from ours.
    const positions = [];
    for (const u of this.simulation.units) {
      if (u.teamId !== this.myTeamId) continue;
      positions.push({
        unitId: u.id,
        x: u.formationOrigin.x,
        z: u.formationOrigin.z,
        facing: u.formationFacing
      });
    }
    this.session.send({ type: 'deployment', teamId: this.myTeamId, positions });

    this._renderTimer();
    this._maybeComplete();
  }

  _onPeerDeployment(msg) {
    if (!msg || !Array.isArray(msg.positions)) return;
    if (msg.teamId === this.myTeamId) return; // defensive

    this._peerDeployment = msg.positions;

    // Apply the peer's placement to the peer's units. Because the sim is
    // frozen while active, this is safe and does not race any system.
    for (const p of msg.positions) {
      const u = this.simulation.unitsById.get(p.unitId);
      if (!u) continue;
      if (u.teamId !== this.otherTeamId) continue;
      u.issueInstantMoveOrder(p.x, p.z, p.facing ?? u.formationFacing);
    }

    this._maybeComplete();
  }

  _maybeComplete() {
    if (!this._myReady) return;
    if (!this._peerDeployment) return;

    this._active = false;
    this._teardown();
    this.onComplete();
  }

  // --- countdown UI ---------------------------------------------------------

  _buildOverlay() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:16px', 'left:50%',
      'transform:translateX(-50%)',
      'z-index:22',
      'display:flex', 'flex-direction:column', 'align-items:center',
      'gap:8px', 'font-family:system-ui, -apple-system, Segoe UI, sans-serif',
      'user-select:none'
    ].join(';');

    const timer = document.createElement('div');
    timer.style.cssText = [
      'padding:10px 20px',
      'background:rgba(20,30,45,0.9)',
      'border:1px solid #3a4a5e', 'border-radius:5px',
      'color:#eef2f8', 'font-size:16px', 'font-weight:600',
      'letter-spacing:1px',
      'font-variant-numeric:tabular-nums'
    ].join(';');
    el.appendChild(timer);
    this._timerEl = timer;

    const hint = document.createElement('div');
    hint.textContent = 'Place your units inside the zone. Your opponent cannot see your placement.';
    hint.style.cssText = [
      'color:#e8e8e8', 'background:rgba(20,30,45,0.78)',
      'padding:5px 14px', 'border-radius:4px',
      'font-size:12px', 'letter-spacing:0.2px'
    ].join(';');
    el.appendChild(hint);

    const readyBtn = document.createElement('button');
    readyBtn.type = 'button';
    readyBtn.textContent = 'Ready — Begin Battle';
    readyBtn.style.cssText = [
      'padding:10px 32px',
      'font-size:14px', 'font-weight:600', 'letter-spacing:0.5px',
      'color:#ffffff', 'background:#2e7d32',
      'border:1px solid #1b5e20', 'border-radius:5px',
      'cursor:pointer', 'pointer-events:auto',
      'box-shadow:0 2px 8px rgba(0,0,0,0.45)'
    ].join(';');
    readyBtn.addEventListener('mouseenter', () => { readyBtn.style.background = '#388e3c'; });
    readyBtn.addEventListener('mouseleave', () => { readyBtn.style.background = '#2e7d32'; });
    readyBtn.addEventListener('click', () => this.playerReadyNow());
    el.appendChild(readyBtn);
    this._readyBtn = readyBtn;

    return el;
  }

  _renderTimer() {
    if (!this._timerEl) return;
    if (this._myReady) {
      this._timerEl.textContent = 'Waiting for opponent…';
      if (this._readyBtn) {
        this._readyBtn.disabled = true;
        this._readyBtn.textContent = 'Ready ✓';
        this._readyBtn.style.background = '#3a5a2c';
        this._readyBtn.style.cursor = 'default';
      }
      return;
    }
    if (this.totalSeconds <= 0) {
      this._timerEl.textContent = 'Deployment — no time limit';
      return;
    }
    const secs = Math.ceil(this._timeLeft);
    this._timerEl.textContent = `Deployment — ${secs}s`;
  }
}
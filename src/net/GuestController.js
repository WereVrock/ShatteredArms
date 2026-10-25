// Guest-side networking. Applies snapshots into the guest's local mirror
// and forwards player orders to the host. The guest does NOT tick its own
// sim systems (main.js sets simulation.tickEnabled = false).

import { SnapshotCodec } from './SnapshotCodec.js';

export class GuestController {
  constructor(session, simulation, options = {}) {
    this.session = session;
    this.simulation = simulation;
    this.playerTeamId = options.playerTeamId || null;
    this.onScenario = options.onScenario || null;
    this.onPeerLeft = options.onPeerLeft || null;

    this._lastTickApplied = 0;

    this.session.on('snapshot', (msg) => this._onSnapshot(msg));
    this.session.on('peerLeft', () => this._onPeerLeft());
  }

  sendOrder(kind, unitIds, params) {
    if (!this.session.paired) return false;
    return this.session.send({ type: 'order', kind, unitIds, params });
  }

  announce() {
    this.session.send({ type: 'hello', playerTeamId: this.playerTeamId });
  }

  _onSnapshot(msg) {
    if (!msg || typeof msg.data !== 'string') return;
    const tick = SnapshotCodec.decode(msg.data, this.simulation.unitsById);
    if (tick >= this._lastTickApplied) this._lastTickApplied = tick;
  }

  _onPeerLeft() { if (this.onPeerLeft) this.onPeerLeft(); }
}
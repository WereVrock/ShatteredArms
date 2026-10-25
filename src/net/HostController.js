// Host-side networking. Broadcasts snapshots after each tick and applies
// orders received from the guest to the guest's units. The host is
// authoritative — the guest sees only what the host produces.

import { SnapshotCodec } from './SnapshotCodec.js';

export class HostController {
  constructor(session, simulation, options = {}) {
    this.session = session;
    this.simulation = simulation;
    this.guestTeamId = options.guestTeamId || null;
    this.snapshotEveryTicks = options.snapshotEveryTicks ?? 1;

    this._tickCounter = 0;
    this._running = false;

    this.session.on('paired', () => this._onPaired());
    this.session.on('order', (msg) => this._onOrder(msg));
    this.session.on('hello', () => {});
  }

  start() { this._running = true; }
  stop()  { this._running = false; }

  afterTick() {
    if (!this._running || !this.session.paired) return;
    this._tickCounter++;
    if (this._tickCounter % this.snapshotEveryTicks !== 0) return;
    const json = SnapshotCodec.encode(this.simulation.units, this._tickCounter);
    this.session.send({ type: 'snapshot', data: json });
  }

  // The scenario handshake now happens in MPLobby (before this controller
  // is even constructed). _onPaired is a no-op here.
  _onPaired() {}

  _onOrder(msg) {
    const { kind, unitIds, params } = msg || {};
    if (!Array.isArray(unitIds) || unitIds.length === 0) return;
    const p = params || {};

    for (const id of unitIds) {
      const unit = this.simulation.unitsById.get(id);
      if (!unit) continue;
      if (this.guestTeamId && unit.teamId !== this.guestTeamId) continue;

      switch (kind) {
        case 'move':
          unit.issueMoveOrder(p.x, p.z, p.facing, p.opts || {});
          break;
        case 'formation':
          unit.issueFormationOrder(p.x, p.z, p.facing, p.width, p.opts || {});
          break;
        case 'attack': {
          const target = this.simulation.unitsById.get(p.targetUnitId);
          if (target) unit.issueAttackOrder(target);
          break;
        }
        case 'stop':
          unit.stopOrder();
          break;
        case 'fireAtWill':
          unit.fireAtWill = !!p.value;
          break;
      }
    }
  }
}
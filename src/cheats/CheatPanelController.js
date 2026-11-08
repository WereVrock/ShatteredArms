// ===== CheatPanelController.js =====
// Connects CheatPanelView to the battle and campaign cheats. Builds the
// view model, runs the chosen cheat, and voids scoring the moment the panel
// opens in a campaign battle. The view holds no game logic.
//
// open(ctx):
//   ctx = {
//     simulation,      live BattleSimulation
//     playerTeamId,    team id of the player (may be null in spectator mode)
//     campaignState,   live campaign state, or null outside a campaign
//     onClose()        called when the panel is dismissed
//   }

import { BATTLE_CHEATS } from './BattleCheats.js';
import { RUN_CHEATS, RunCheats } from './RunCheats.js';
import { CheatPanelView } from '../ui/CheatPanelView.js';
import { CampaignState } from '../campaign/CampaignState.js';

export class CheatPanelController {
  constructor() {
    this.view = new CheatPanelView();
    this._ctx = null;
  }

  isOpen() {
    return this.view.isOpen();
  }

  close() {
    this.view.close();
  }

  open(ctx) {
    this._ctx = ctx;
    this._voidScoring();
    this.view.show({
      getModel: () => this._buildModel(),
      onRun: (id) => this._run(id),
      onClose: () => {
        const cb = this._ctx ? this._ctx.onClose : null;
        this._ctx = null;
        if (cb) cb();
      }
    });
  }

  // Opening the panel is what voids the score, not using a cheat.
  _voidScoring() {
    const state = this._ctx.campaignState;
    if (!state) return;
    RunCheats.voidScoring(state);
    CampaignState.save(state);
  }

  _buildModel() {
    const state = this._ctx.campaignState;
    return {
      notice: state
        ? 'Cheat panel opened: this campaign run no longer scores.'
        : 'Not a campaign battle: there is no campaign score to void.',
      sections: [
        {
          title: 'Battle',
          items: BATTLE_CHEATS.map(c => ({
            id: c.id, label: c.label, description: c.description,
            enabled: true, note: ''
          }))
        },
        {
          title: 'Campaign run',
          items: RUN_CHEATS.map(c => {
            const reason = c.unavailable(state);
            return {
              id: c.id, label: c.label, description: c.description,
              enabled: !reason, note: reason || ''
            };
          })
        }
      ]
    };
  }

  _run(id) {
    const ctx = this._ctx;
    if (!ctx) return '';
    try {
      const battleCheat = BATTLE_CHEATS.find(c => c.id === id);
      if (battleCheat) return battleCheat.run(ctx.simulation, ctx.playerTeamId);

      const runCheat = RUN_CHEATS.find(c => c.id === id);
      if (runCheat) {
        const state = ctx.campaignState;
        if (runCheat.unavailable(state)) return 'Not available here.';
        const message = runCheat.run(state);
        CampaignState.save(state);
        return message;
      }
      return 'Unknown cheat.';
    } catch (e) {
      console.error('[cheat] failed', e);
      return `Cheat failed: ${e && e.message ? e.message : e}`;
    }
  }
}
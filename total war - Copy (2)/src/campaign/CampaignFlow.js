import { CampaignState } from './CampaignState.js';
import { CampaignRoster } from './CampaignRoster.js';
import { generateRewards } from './CampaignRewards.js';
import { generateAIRoster } from './CampaignBattleBuilder.js';
import { CampaignConfig } from './CampaignConfig.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { UnitFamilies } from './UnitFamilies.js';
import { unitIconSvg } from '../ui/UnitIcon.js';
import { CardPickerView } from '../ui/CardPickerView.js';

// Orchestrates the campaign: initial pick, battle launches, between-battle
// rewards, game-over. All UI rendering is delegated to CardPickerView; this
// class only builds view-model data and mutates roster/state.
//
// Reload semantics: transitioning from a picker to a battle reloads the page
// when a previous battle is still in the DOM (to clear its controllers).
// Transitioning from the main menu to the initial picker, or from the initial
// picker to the first battle, happens in-page.
export class CampaignFlow {
  constructor({ menuElement, mainMenu, onStartBattle }) {
    this.menuElement = menuElement;
    this.mainMenu = mainMenu;
    this.onStartBattle = onStartBattle;
    this.picker = new CardPickerView(menuElement);
  }

  // Main menu -> Campaign click.
  startNewCampaign() {
    const state = CampaignState.newCampaign();
    CampaignState.save(state);
    this._showInitialPicker(state);
  }

  // Called at boot when a campaign exists but the phase is a picker phase.
  resume(state) {
    switch (state.phase) {
      case 'pick-initial': this._showInitialPicker(state); break;
      case 'pick-reward': this._showRewardPicker(state); break;
      case 'pick-recover': this._showRecoverPicker(state); break;
      case 'game-over': this._showGameOver(state); break;
      default: this.mainMenu.show(); break;
    }
  }

  // Called from main.js's battle-end callback.
  handleBattleEnded(state, simulation) {
    const redUnits = simulation.units.filter(u => u.teamId === 'red');
    const playerWon = redUnits.every(u => u.isDefeated());

    // Extraction record: routing soldiers who fled past the map edge.
    // Not yet integrated into campaign flow (the 40% return chance and
    // 50% depletion roll are deferred per the roadmap), but logged here
    // so the shape is visible in the console and the plumbing is verified
    // end-to-end. When campaign integration lands, this is where
    // state.roster gets updated with surviving-depleted versions of
    // extracted units.
    const extractions = simulation.extractionSystem
      ? simulation.extractionSystem.getExtractions()
      : [];
    if (extractions.length > 0) {
      console.log('[campaign] routed units escaped the field:', extractions);
    }

    const result = {};
    for (const unit of simulation.units) {
      if (unit.teamId !== 'blue') continue;
      result[unit.id] = unit.getAliveSoldiers().length;
    }
    CampaignRoster.applyBattleResult(state.roster, result);
    state.roster = CampaignRoster.removeDestroyed(state.roster);

    if (!playerWon || state.roster.length === 0) {
      state.phase = 'game-over';
      state.lastBattleOutcome = 'lost';
      CampaignState.save(state);
      this._showGameOver(state);
      return;
    }

    state.phase = 'pick-reward';
    state.lastBattleOutcome = 'won';
    state.rewardOptions = generateRewards(state.roster);
    CampaignState.save(state);
    this._showRewardPicker(state);
  }

  // --- Screens ----------------------------------------------------------

  // Sequential initial pick: N rounds, each round offering two horizontally-
  // aligned cards. One click picks the unit and advances. Progress is
  // persisted in state.initialPickState so a reload mid-pick does not reroll
  // the current round or lose the units already chosen.
  _showInitialPicker(state) {
    if (!state.initialPickState) {
      state.initialPickState = {
        picksRemaining: CampaignConfig.initialPickCount,
        pickedOffers: [],
        currentOffer: this._rollInitialOffer()
      };
      CampaignState.save(state);
    }

    const pickState = state.initialPickState;

    if (pickState.picksRemaining <= 0) {
      // Guard against landing here after a completed sequence (e.g. a reload
      // between the last pick and the battle launch).
      this._finishInitialPicks(state);
      return;
    }

    const roundNumber = CampaignConfig.initialPickCount - pickState.picksRemaining + 1;
    const cards = pickState.currentOffer.map((offer, i) => {
      const typeDef = UnitTypes[offer.typeId];
      const baseName = typeDef.displayName;
      return {
        id: String(i),
        name: offer.isUndead ? `Skeleton ${baseName}` : baseName,
        description: `${CampaignConfig.defaultSizes[offer.typeId]} soldiers`,
        imageHtml: unitIconSvg(typeDef, offer.isUndead)
      };
    });

    this.picker.show({
      title: 'Choose your army',
      subtitle: `Pick ${roundNumber} of ${CampaignConfig.initialPickCount}`,
      cards,
      mode: 'single',
      orientation: 'horizontal',
      onSelect: (id) => {
        const chosenOffer = pickState.currentOffer[parseInt(id, 10)];
        pickState.pickedOffers.push(chosenOffer);
        pickState.picksRemaining -= 1;
        pickState.currentOffer = pickState.picksRemaining > 0
          ? this._rollInitialOffer()
          : null;
        CampaignState.save(state);

        if (pickState.picksRemaining <= 0) {
          this._finishInitialPicks(state);
        } else {
          this._showInitialPicker(state);
        }
      },
      onBack: () => {
        CampaignState.clear();
        this.mainMenu.show();
      }
    });
  }

  // Two unit offers from two different families. Both cards share one shield
  // roll (30% both shielded, else both unshielded); skeleton is rolled per
  // card (30% each). Same helper as the between-battle rewards.
  _rollInitialOffer() {
    return UnitFamilies.pickTwoOffers({
      shieldedChance: CampaignConfig.shieldedOfferChance,
      skeletonChance: CampaignConfig.skeletonOfferChance
    });
  }

  _finishInitialPicks(state) {
    state.roster = CampaignRoster.fromOffers(state.initialPickState.pickedOffers);
    state.initialPickState = null;
    this._beginBattle(state, 0, { reload: false });
  }

  _showRewardPicker(state) {
    const opts = state.rewardOptions || [];
    const recoverable = CampaignRoster.hasRecoverableUnit(state.roster);

    const cards = opts.map((opt, i) => {
      if (opt.kind === 'unit') {
        const typeDef = UnitTypes[opt.typeId];
        const baseName = typeDef.displayName;
        return {
          id: String(i),
          name: opt.isUndead ? `Skeleton ${baseName}` : baseName,
          description: `New unit — ${CampaignConfig.defaultSizes[opt.typeId]} soldiers`,
          imageHtml: unitIconSvg(typeDef, opt.isUndead)
        };
      }
      return {
        id: String(i),
        name: 'Recover one unit',
        description: recoverable
          ? 'Restore one depleted unit to its original strength.'
          : 'No units need recovering.',
        imageHtml: '',
        disabled: !recoverable
      };
    });

    this.picker.show({
      title: `Battle ${state.battleIndex + 1} won`,
      subtitle: 'Choose your reward before the next battle.',
      cards,
      mode: 'single',
      onSelect: (id) => {
        const opt = opts[parseInt(id, 10)];
        if (opt.kind === 'unit') {
          CampaignRoster.addUnit(state.roster, opt.typeId, opt.isUndead);
          this._beginBattle(state, state.battleIndex + 1, { reload: true });
        } else {
          state.phase = 'pick-recover';
          CampaignState.save(state);
          this._showRecoverPicker(state);
        }
      },
      onBack: () => {
        CampaignState.clear();
        this.mainMenu.show();
      }
    });
  }

_showRecoverPicker(state) {
    const cards = state.roster.map(entry => {
      const typeDef = UnitTypes[entry.typeId];
      return {
        id: entry.id,
        name: typeDef.displayName,
        description: `${entry.aliveCount} / ${entry.maxCount} soldiers`,
        imageHtml: unitIconSvg(typeDef, false),
        disabled: entry.aliveCount >= entry.maxCount
      };
    });

    this.picker.show({
      title: 'Recover a unit',
      subtitle: 'Choose a unit to restore to its original strength.',
      cards,
      mode: 'single',
      orientation: 'horizontal',
      onSelect: (entryId) => {
        CampaignRoster.recoverUnit(state.roster, entryId);
        this._beginBattle(state, state.battleIndex + 1, { reload: true });
      },
      onBack: () => {
        state.phase = 'pick-reward';
        CampaignState.save(state);
        this._showRewardPicker(state);
      }
    });
  }

  _showGameOver(state) {
    this.picker.show({
      title: 'Campaign Over',
      subtitle: `You reached battle ${state.battleIndex + 1}.`,
      cards: [],
      mode: 'single',
      onSelect: () => {},
      onBack: () => {
        CampaignState.clear();
        this.mainMenu.show();
      },
      backLabel: 'Back to Main Menu'
    });
  }

  // --- Battle launch ----------------------------------------------------

  _beginBattle(state, battleIndex, { reload }) {
    state.battleIndex = battleIndex;
    state.phase = 'battle';
    state.aiRoster = generateAIRoster(battleIndex);
    state.rewardOptions = null;
    state.lastBattleOutcome = null;
    CampaignState.save(state);
    if (reload) {
      window.location.reload();
    } else {
      this.onStartBattle(state);
    }
  }
}
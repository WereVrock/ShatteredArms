// ===== CampaignFlow.js =====
import { CampaignState } from './CampaignState.js';
import { CampaignRoster } from './CampaignRoster.js';
import { Champion } from './Champion.js';
import { ChampionConfig, CHAMPION_IDS, areChampionsEnabled, previewStartingStats } from './ChampionConfig.js';
import { effectiveUnitXp, unitLevelForXp } from './UnitXp.js';
import { generateRewards } from './CampaignRewards.js';
import { generateAIRoster, processAISurvivors } from './CampaignBattleBuilder.js';
import { CampaignConfig } from './CampaignConfig.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { UnitFamilies } from './UnitFamilies.js';
import { unitIconSvg } from '../ui/UnitIcon.js';
import { attachRankBadge } from '../ui/UnitRank.js';
import { CardPickerView } from '../ui/CardPickerView.js';
import { ChampionPanelView } from '../ui/ChampionPanelView.js';
import { computeUnitPrice, buildPreviewUnit } from './UnitPreview.js';
import { AITierPreference } from '../config/AITierPreference.js';
import { installCampaignCheats } from './CampaignCheats.js';

// Orchestrates the campaign. All UI rendering is delegated to
// CardPickerView; this class only builds view-model data and mutates
// roster/gold/state.
//
// Difficulty:
//   - The campaign opens with a difficulty pick (easy / normal / hard).
//     The chosen preset (see CampaignConfig.difficulties) selects the AI
//     tier used for campaign battles, adjusts enemy gold growth, and
//     shapes the first battle's AI roster.
//   - Easy: weakened AI tier, -50 gold growth, first battle is a 3-unit
//     goblin force.
//   - Normal: standard AI tier, unchanged growth, first battle is a
//     3-unit human force.
//   - Hard: standard AI tier, +50 gold growth, standard first battle.
//
// Economy:
//   - Player starts with CampaignConfig.startingGold and receives
//     CampaignConfig.battleReward after each won battle.
//   - Unit prices derive from preview power: floor(power / 10). See
//     UnitPreview.computeUnitPrice.
//   - Initial picker: N rounds, each offering two random units. The
//     player MUST pick one per round, and can only pick what they can
//     afford. If both offers in a round are unaffordable the round
//     auto-skips.
//   - Reward picker (after a win): a "shop" screen. The player buys any
//     number of the offers they can afford, may pay to heal one depleted
//     unit, and continues to the next battle when ready.
//
// Reload semantics: transitioning from a picker to a battle reloads the
// page when a previous battle is still in the DOM (to clear its
// controllers). Transitioning from the main menu to the initial picker,
// or from the initial picker to the first battle, happens in-page.

const STYLE_ID = 'campaign-flow-styles';

const STYLE_TEXT = `
  .campaign-info {
    position: fixed;
    left: 16px;
    top: 50%;
    transform: translateY(-50%);
    width: 220px;
    max-height: calc(100vh - 40px);
    overflow-y: auto;
    padding: 12px;
    background: rgba(0,0,0,0.65);
    border: 1px solid #384050;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    color: #e0e8f0;
    font-size: 12px;
    text-align: left;
    z-index: 5;
    scrollbar-width: thin;
    scrollbar-color: #3a4a5e rgba(0,0,0,0.65);
  }
  .campaign-info::-webkit-scrollbar { width: 8px; }
  .campaign-info::-webkit-scrollbar-track { background: transparent; }
  .campaign-info::-webkit-scrollbar-thumb {
    background: #3a4a5e;
    border-radius: 4px;
  }
  .campaign-info-gold {
    font-size: 20px;
    font-weight: 700;
    color: #e0c060;
    letter-spacing: 0.5px;
    text-align: center;
    margin-bottom: 10px;
    padding-bottom: 10px;
    border-bottom: 1px solid #384050;
    white-space: nowrap;
  }
  .campaign-info-roster {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .campaign-info-roster-empty {
    color: #6a7a8e;
    font-style: italic;
    text-align: center;
    padding: 6px 0;
  }
  .campaign-info-card {
    display: grid;
    grid-template-columns: 36px 1fr auto;
    align-items: center;
    column-gap: 8px;
    padding: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid #2a3544;
    border-radius: 5px;
  }
  .campaign-info-card-icon {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .campaign-info-card-icon svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .campaign-info-card-name {
    font-size: 12px;
    color: #dde5ee;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .campaign-info-card-count {
    font-size: 11px;
    color: #8a9ab0;
    font-variant-numeric: tabular-nums;
  }
  .campaign-info-card-count.depleted {
    color: #d08a6a;
  }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_TEXT;
  document.head.appendChild(el);
}

export class CampaignFlow {
  constructor({ menuElement, mainMenu, onStartBattle, unitInfoPanel }) {
    ensureStyles();

    this.menuElement = menuElement;
    this.mainMenu = mainMenu;
    this.onStartBattle = onStartBattle;
    // Optional. When supplied, right-clicking a card opens this panel with
    // a synthetic preview unit built from the card's data — no live sim
    // unit exists at this stage. Null-safe.
    this.unitInfoPanel = unitInfoPanel || null;

    // Custom Battle still shows a power score; the campaign shows prices
    // instead. Kept as a flag so a future "show both" toggle is a
    // one-line change.
    this.showPower = false;

    this.picker = new CardPickerView(menuElement);
    // Modal champion sheet. Built once per flow; show()/close() drive it.
    this.championPanel = new ChampionPanelView();

    // Test-only cheats. The listener is inert unless
    // SettingsStore.enableTestFeatures is on; getState returns the live
    // state of the currently displayed picker (see _setActivePicker), so
    // a cheat can never mutate a stale object after the picker is gone.
    this._cheatState = null;
    this._cheatRedraw = null;
    this._uninstallCheats = installCampaignCheats({
      getState: () => this._cheatState,
      onChange: () => {
        if (!this._cheatState) return;
        CampaignState.save(this._cheatState);
        if (this._cheatRedraw) this._cheatRedraw();
      }
    });
  }

  // Main menu -> Campaign click.
// Main menu -> Campaign click. Creates an empty campaign state and
  // hands control to the champion picker. The champion is created only
  // when the player confirms a selection, so backing out of the picker
  // leaves no orphaned roster entry.
// Main menu -> Campaign click. Creates an empty campaign state and,
  // when the champion system is enabled, hands control to the champion
  // picker. When CHAMPIONS_ENABLED is false the picker is skipped and the
  // flow goes straight to the difficulty picker — the resulting campaign
  // has `champion: null` and every downstream reader that gates on
  // `state.champion` behaves as though the feature does not exist.
  //
  // The champion-picker path defers champion creation until the player
  // confirms, so backing out of the picker leaves no orphaned roster
  // entry. See _showChampionPicker / _showChampionPreview.
startNewCampaign() {
    const state = CampaignState.newCampaign();
    CampaignState.save(state);
    // Show the commander picker whenever at least one commander is
    // eligible. Pseudo-commanders (see ChampionConfig.mercenary_captains)
    // are always eligible — they are not Champions, need no Champion
    // instance, and their effects run entirely through
    // state.mercenaryCaptain and the starting-unit hook in
    // _commitPseudoCommander. Only when the eligible list is empty
    // (e.g. a future build with no pseudo-commanders and champions
    // disabled) does the flow skip straight to the difficulty picker.
    if (this._eligibleCommanderIds().length > 0) {
      this._showChampionPicker(state);
    } else {
      this._showDifficultyPicker(state);
    }
  }

// First screen of a new campaign. Presents every champion in
  // ChampionConfig. Each card shows the champion's displayName, its
  // short description, and (in the description) the passive it brings.
  //
  // Selecting commits the choice: creates the Champion instance, adds the
  // retinue roster entry, and moves on to the difficulty picker. Backing
  // out returns to the main menu and clears the (still champion-less)
  // campaign state.
// First screen of a new campaign. Presents every champion in
  // ChampionConfig. Each card shows the champion's displayName, its
  // short description, and (in the description) the passive it brings.
  //
  // Selecting a card does NOT commit — it opens a preview screen showing
  // the champion's full skill tree and starting effects, with a Confirm
  // button that performs the commit. Backing out of the picker returns to
  // the main menu and clears the (still champion-less) campaign state.
_showChampionPicker(state) {
    const ids = this._eligibleCommanderIds();
    const hasRealChampion = ids.some(id => !ChampionConfig[id].pseudoCommander);

    const cards = ids.map(id => {
      const def = ChampionConfig[id];
      return {
        id,
        name: def.displayName,
        description: def.description,
        imageHtml: '',
        disabled: false
      };
    });

    this.picker.show({
      title: 'Choose your commander',
      // The "if he dies" clause only applies when a real champion is on
      // the menu. A pseudo-commander (mercenary_captains) has no
      // figurehead whose fall ends the campaign, so the promise would be
      // false for that option.
      subtitle: hasRealChampion
        ? 'Pick a commander. If he dies, your journey ends.'
        : 'Pick a commander.',
      cards,
      mode: 'single',
      onSelect: (id) => {
        if (!ChampionConfig[id]) return;
        this._showChampionPreview(state, id);
      },
      onBack: () => {
        CampaignState.clear();
        this.mainMenu.show();
      },
      backLabel: 'Exit campaign'
    });
  }

// Returns the commander ids the player can pick from right now.
  //
  // Pseudo-commanders (ChampionConfig.mercenary_captains) are always
  // eligible: they are not Champions, need no Champion instance, and
  // their effects run entirely through state.mercenaryCaptain and the
  // starting-unit hook in _commitPseudoCommander. This makes the
  // commander picker reachable even when the champion system is
  // disabled by the test-features flag.
  //
  // Real champions are gated on areChampionsEnabled(), matching every
  // other champion decision site. The filter is by the def's
  // pseudoCommander flag, not by a hardcoded id list, so a future
  // pseudo-commander is automatically always-eligible and a future real
  // champion is automatically gated.
  _eligibleCommanderIds() {
    const championsOn = areChampionsEnabled();
    return CHAMPION_IDS.filter(id => {
      const def = ChampionConfig[id];
      if (!def) return false;
      if (def.pseudoCommander) return true;
      return championsOn;
    });
  }

// Preview screen between the champion card list and the difficulty
  // picker. Shows the champion's full skill tree in a non-interactive
  // state plus the starting numbers (HP, bodyguard count). Confirm
  // commits the choice; Back returns to the card list.
  //
  // The preview does NOT create a Champion instance — a Champion created
  // and discarded here would leave an orphaned roster entry. The instance
  // is built only on Confirm.
  _showChampionPreview(state, championId) {
    const def = ChampionConfig[championId];
    if (!def) return;
    const stats = previewStartingStats(def);

    this.championPanel.showPreview({
      def,
      stats,
      onConfirm: () => {
        if (def.pseudoCommander) {
          this._commitPseudoCommander(state, def);
          return;
        }
        state.champion = new Champion(championId);
        const entry = CampaignRoster.addChampionUnit(state.roster, def);
        state.champion.rosterEntryId = entry.id;
        state.phase = 'pick-difficulty';
        CampaignState.save(state);
        this._showDifficultyPicker(state);
      },
      onCancel: () => {
        this._showChampionPicker(state);
      },
    });
  }

  // Commits a pseudo-commander (see ChampionConfig.mercenary_captains).
  // No Champion instance is created — the pseudo-commander is not an
  // entity on the battlefield, it is a set of starting conditions. What
  // it provides:
  //   - the starting unit declared on the def, added to the roster at
  //     the declared level,
  //   - a per-victory gold bonus, added by handleBattleEnded when
  //     state.mercenaryCaptain is true.
  // The state flag is what distinguishes this from "no commander at
  // all" downstream; state.champion stays null either way, and every
  // champion-gated reader is null-safe.
  _commitPseudoCommander(state, def) {
    state.mercenaryCaptain = true;
    if (def.startingUnit) {
      const su = def.startingUnit;
      const entry = CampaignRoster.addUnit(
        state.roster, su.typeId, !!su.isUndead
      );
      if (entry && su.level) entry.level = su.level;
    }
    state.phase = 'pick-difficulty';
    CampaignState.save(state);
    this._showDifficultyPicker(state);
  }

// Called at boot when a campaign exists but the phase is a picker phase.
  resume(state) {
    switch (state.phase) {
      case 'pick-difficulty': this._showDifficultyPicker(state); break;
      case 'pick-initial': this._showInitialPicker(state); break;
      case 'pick-reward':  this._showRewardPicker(state); break;
      case 'pick-recover': this._showReinforcePicker(state); break;
      case 'game-over':    this._showGameOver(state); break;
      default:             this.mainMenu.show(); break;
    }
  }

  // Called from main.js's battle-end callback.
  handleBattleEnded(state, simulation) {
    const redUnits = simulation.units.filter(u => u.teamId === 'red');
    const playerWon = redUnits.every(u => u.isDefeated());

    // Extraction: routing soldiers who fled past the map edge. For PLAYER
    // units, escapees come back next battle at 100% — routing is a
    // setback, not a death sentence — provided the unit still has MORE
    // THAN 20% of its soldiers alive at battle end (on-field survivors +
    // escapees, measured against the unit's maxCount). A unit that falls
    // to 20% or below is considered destroyed; its escapees scatter and
    // the whole entry is dropped by removeDestroyed below.
    //
    // AI has no persistent roster — generateAIRoster rebuilds it from
    // scratch each battle — so the return rule is player-only by
    // construction.
    const extractions = simulation.extractionSystem
      ? simulation.extractionSystem.getExtractions()
      : [];

    const result = {};
    for (const unit of simulation.units) {
      if (unit.teamId !== 'blue') continue;
      // Riderless mounts are battlefield-temporary: they never persist
      // to the campaign roster. Counting them here would let a beast
      // silently stand in for a lost guard slot on the next battle's
      // retinue rebuild — the warlord's retinue would mysteriously
      // recover a hobgoblin for every beast that survived the battle.
      const alive = unit.getAliveSoldiers();
      let count = 0;
      for (const s of alive) {
        if (!s.isRiderlessMount) count++;
      }
      result[unit.id] = count;
    }
    CampaignRoster.applyBattleResult(state.roster, result);

    // Routing survival rule. Every routing (escaped) player soldier
    // rejoins its unit next battle — routing is a setback, not a death
    // sentence. The escaped count is added straight onto the unit's
    // on-field alive count. A routed unit is then force-destroyed only
    // if its resulting size is below 20% of its maxCount. Units that
    // did not rout keep their standard aliveCount > 0 rule untouched.
    const extractedByUnit = new Map();
    for (const ex of extractions) {
      if (!ex || ex.teamId !== 'blue') continue;
      if (typeof ex.unitId === 'undefined') continue;
      if (typeof ex.escapedCount !== 'number' || ex.escapedCount <= 0) continue;
      extractedByUnit.set(ex.unitId, ex.escapedCount);
    }

    for (const entry of state.roster) {
      const escaped = extractedByUnit.get(entry.id) || 0;
      if (escaped <= 0) continue; // didn't rout — standard aliveCount > 0 rule applies

      // Snapshot whether the unit was FULLY routed (0 on-field alive)
      // before folding its escapees back in. The 20% floor applies only
      // to fully-routed units: a unit that kept even one soldier on the
      // field survives regardless of how many routed away — its on-field
      // remnant is treated like any other non-routing unit (aliveCount > 0
      // → keep).
      const wasFullyRouted = entry.aliveCount === 0;

      entry.aliveCount += escaped;
      if (wasFullyRouted && entry.aliveCount / entry.maxCount < 0.2) {
        entry.aliveCount = 0;
      }
    }

    state.roster = CampaignRoster.removeDestroyed(state.roster);

    // Champion status. Multiple independent signals, any of which ends
    // the campaign on the champion's fall:
    //
    //   1. The sim's champion soldier reads 'dead' — the intended
    //      signal, and the only one that fires in a clean kill.
    //
    //   2. The sim no longer tracks ANY unit with a championSoldier
    //      reference. Defensive — the champion's unit is never removed
    //      from simulation.units in the current code, but if a future
    //      change starts removing destroyed units, the campaign must
    //      still see the champion as dead rather than silently
    //      continuing as though the champion never existed.
    //
    //   3. The champion's roster entry is gone AND the champion is not
    //      in the 'extracted' state. The roster entry is dropped by
    //      removeDestroyed above when the retinue's aliveCount hits
    //      zero — which happens when the retinue is wiped including
    //      the champion. The `!champExtracted` guard preserves the
    //      campaign rule that a champion who routed off the field
    //      survives: if the champion is 'extracted', an empty roster
    //      entry means the guards died but the champion lived, and the
    //      campaign continues.
    //
    // An extracted champion (state 'extracted') is deliberately NOT a
    // loss on its own — routing off the field is a survival per the
    // campaign rules (see CampaignBattleBuilder.forceExtractRunners).
    const championUnit = simulation.units.find(u => u.championSoldier);
    const champSoldier = championUnit ? championUnit.championSoldier : null;
    const championRawXp = champSoldier ? (champSoldier.championXpRaw || 0) : 0;

    const champExtracted = champSoldier && champSoldier.state === 'extracted';
    // Dead = non-alive AND not extracted. The sim's clean-kill path sets
    // state to the literal 'dead', but any other non-alive state (or a
    // future death path that does not use that exact string) must also
    // register — otherwise a slain champion slips past this check and the
    // flow falls through to the "player won" branch. Extraction remains
    // the sole survival exception: a champion that routed off the field
    // is still alive for campaign purposes even though isAlive() is false.
    const champSoldierIsDead = !!(champSoldier
      && !champSoldier.isAlive()
      && champSoldier.state !== 'extracted');
    const champRosterEntryExists = state.roster.some(e => e.hasChampion);
    const championDead = state.champion
      ? (champSoldierIsDead
          || !championUnit
          || (!champRosterEntryExists && !champExtracted))
      : false;

    // AI survivors carry over to the next battle. Each surviving AI unit
    // faces two independent 50% rolls (desert outright, then lose 20-30%
    // of remaining) and a final threshold check (>20% of max). Units
    // that pass all three join the next battle's AI roster for free —
    // the per-battle gold budget is spent on NEW units on top of them.
    // See CampaignBattleBuilder.processAISurvivors for the full rule.
    state.aiRoster = processAISurvivors(state.aiRoster, simulation);

    // Champion death overrides every other consideration — the campaign
    // ends on the champion's fall regardless of whether the rest of the
    // army survived or won. Ordering matters: this check runs BEFORE the
    // general loss check so the specific "champion dead" ending wins.
    if (championDead) {
      state.phase = 'game-over';
      state.lastBattleOutcome = 'lost';
      CampaignState.save(state);
      this._showGameOver(state, { reason: 'champion-dead' });
      return;
    }

    // Award the champion's combat XP. The diminishing curve is applied
    // inside awardBattleXp — a large raw sim total is expected and safe.
    // Applied whether the battle was won or lost, as long as the champion
    // survived; a hard-fought loss still teaches the champion something.
    if (state.champion && championRawXp > 0) {
      state.champion.awardBattleXp(championRawXp);
    }

    // Award unit XP to every surviving roster entry. Runs on the
    // already-filtered roster — units wiped out in this battle earn
    // nothing and were dropped by removeDestroyed above. Same
    // diminishing curve as the champion (see UnitXp.effectiveUnitXp);
    // the raw total is the sum across every soldier of the roster
    // entry's matching simulation unit.
    this._awardRosterUnitXp(state, simulation);

    if (!playerWon || state.roster.length === 0) {
      state.phase = 'game-over';
      state.lastBattleOutcome = 'lost';
      CampaignState.save(state);
      this._showGameOver(state);
      return;
    }

    // Win reward: gold, fresh offers, cleared heal flag. Champion
    // passives can shift the offer pool (guaranteed goblin, halved
    // skeleton chance) — passed through as a modifiers object.
    state.gold += CampaignConfig.battleReward;
    // Mercenary Captains pseudo-commander: an extra payment per victory.
    // The def may not exist in a build with the feature disabled, so the
    // bonus is looked up defensively.
    if (state.mercenaryCaptain) {
      const merc = ChampionConfig['mercenary_captains'];
      if (merc && typeof merc.goldPerWin === 'number') {
        state.gold += merc.goldPerWin;
      }
    }
    state.phase = 'pick-reward';
    state.lastBattleOutcome = 'won';
    state.rewardOptions = generateRewards(
      state.roster, state.champion?.def?.passive || null
    );
    state.recoveredThisReward = false;
    CampaignState.save(state);
    this._showRewardPicker(state);
  }

// Award post-battle unit XP to every surviving roster entry.
  //
  // Raw XP is the sum of Soldier.championXpRaw across every soldier of
  // the roster entry's matching simulation unit — including the champion
  // soldier, if any. The field is named after the champion because the
  // champion's personal progression reads the same data; the unit
  // progression simply reads it aggregated. See UnitXp.js for the
  // curve and thresholds, and CombatResolutionSystem / ProjectileSystem
  // for the two accrual sites (melee swings and arrow hits).
  //
  // Level-ups are silent for now — the roster entry's level simply
  // becomes >1 and the per-level bonuses apply on the next battle's
  // build. A future UI pass can surface a "Unit promoted!" toast; this
  // method already stores everything such a toast would need.
  _awardRosterUnitXp(state, simulation) {
    if (!state.roster || state.roster.length === 0) return;
    if (!simulation || !simulation.units) return;

    const simUnitById = new Map();
    for (const u of simulation.units) {
      if (u.teamId === 'blue') simUnitById.set(u.id, u);
    }

    for (const entry of state.roster) {
      const unit = simUnitById.get(entry.id);
      if (!unit) continue;

      let rawXp = 0;
      for (const s of unit.soldiers) {
        rawXp += s.championXpRaw || 0;
      }
      if (rawXp <= 0) continue;

      const gained = effectiveUnitXp(rawXp);
      entry.xp = (entry.xp || 0) + gained;

      const newLevel = unitLevelForXp(entry.xp);
      if (newLevel > (entry.level || 1)) {
        entry.level = newLevel;
      }
    }
  }

// --- Difficulty picker ------------------------------------------------

  // Entry screen for a new campaign. Presents the three preset difficulties
  // defined in CampaignConfig.difficulties. Nothing campaign-shaping has
  // happened yet at this point — roster and aiRoster are empty, gold is at
  // its starting value — so the state is safe to abandon if the player
  // backs out.
_showDifficultyPicker(state) {
    const presets = CampaignConfig.difficulties;
    const order = ['easy', 'normal', 'hard'];

    const cards = order.map(id => {
      const preset = presets[id];
      return {
        id,
        name: preset.label,
        description: preset.description,
        imageHtml: '',
        disabled: false
      };
    });

    this.picker.show({
      title: 'Choose difficulty',
      cards,
      mode: 'single',
      orientation: 'horizontal',
      onSelect: (id) => {
        if (!presets[id]) return;
        state.difficulty = id;
        state.phase = 'pick-initial';
        CampaignState.save(state);
        this._showInitialPicker(state);
      },
      onBack: () => {
        CampaignState.clear();
        this.mainMenu.show();
      },
      backLabel: 'Exit campaign'
    });
  }

  // --- Initial picker ---------------------------------------------------

  // Sequential initial pick: N rounds, each offering two random units.
  // The player MUST pick one per round. Progress is persisted in
  // state.initialPickState so a reload mid-pick does not reroll the
  // current round or lose the units already chosen.
  //
  // Safety valve: if neither offer in a round is affordable (rare with a
  // sensible economy), the round auto-skips rather than locking the UI.
  _showInitialPicker(state) {
    this._setActivePicker(state, () => this._showInitialPicker(state));
    if (!state.initialPickState) {
      state.initialPickState = {
        picksRemaining: CampaignConfig.initialPickRounds,
        currentOffer: this._rollInitialOffer(state)
      };
      CampaignState.save(state);
    }

    const pickState = state.initialPickState;

    if (pickState.picksRemaining <= 0) {
      this._finishInitialPicks(state);
      return;
    }

    const costModifiers = state.champion?.costMultipliers || null;
    const cards = pickState.currentOffer.map((offer, i) => {
      const card = this._buildOfferCard(offer, String(i), { prefix: null, costModifiers });
      card.disabled = this._priceOfOffer(offer, costModifiers) > state.gold;
      return card;
    });

    // Auto-skip if neither card is affordable.
    if (cards.every(c => c.disabled)) {
      console.warn('[campaign] initial pick round had no affordable offer — skipping');
      pickState.picksRemaining -= 1;
      pickState.currentOffer = pickState.picksRemaining > 0
        ? this._rollInitialOffer(state)
        : null;
      CampaignState.save(state);
      if (pickState.picksRemaining <= 0) this._finishInitialPicks(state);
      else this._showInitialPicker(state);
      return;
    }

    const roundNumber = CampaignConfig.initialPickRounds - pickState.picksRemaining + 1;

    this.picker.show({
      title: 'Choose your army',
      subtitle: `Pick ${roundNumber} of ${CampaignConfig.initialPickRounds}. You must choose one.`,
      infoElement: this._buildInfoElement(state),
      cards,
      mode: 'single',
      orientation: 'horizontal',
      onCardRightClick: (cardDef, el) => this._openCardInfo(cardDef, el),
      onSelect: (id) => {
        const chosenOffer = pickState.currentOffer[parseInt(id, 10)];
        const price = this._priceOfOffer(chosenOffer, state.champion?.costMultipliers || null);
        if (price > state.gold) return; // safety: disabled cards shouldn't fire anyway
        state.gold -= price;
        CampaignRoster.addUnit(state.roster, chosenOffer.typeId, chosenOffer.isUndead);
        pickState.picksRemaining -= 1;
        pickState.currentOffer = pickState.picksRemaining > 0
          ? this._rollInitialOffer(state)
          : null;
        CampaignState.save(state);

        if (pickState.picksRemaining <= 0) this._finishInitialPicks(state);
        else this._showInitialPicker(state);
      },
      onBack: () => {
        CampaignState.clear();
        this.mainMenu.show();
      },
      backLabel: 'Exit campaign'
    });
  }

  // Two random offers from the full campaign pool for the initial picker.
  // Duplicates are forbidden here: the two cards in a round must be
  // distinct types, and neither may be a type the player has already
  // picked (derived from state.roster, which grows as picks are made).
  // The reward picker does NOT use this method — it rolls via
  // UnitFamilies.randomOffer directly and still allows duplicates.
  //
  // If the pool is somehow exhausted (it is not expected to be — five
  // picks from a nine-type pool leaves plenty of room) the loop bails
  // out and returns however many distinct offers it found.
// Two random offers from the full campaign pool for the initial picker.
  // Duplicates are forbidden here: the two cards in a round must be
  // distinct types, and neither may be a type the player has already
  // picked (derived from state.roster, which grows as picks are made).
  // The reward picker does NOT use this method — it rolls via
  // UnitFamilies.randomOffer directly and still allows duplicates.
  //
  // Champion passive applies here as well as on the reward screen:
  // state.champion.def.passive.skeletonOfferChanceMultiplier scales the
  // base skeleton chance (0.5 for the Goblin Warlord = half rate). Same
  // modifier object the reward roller reads — see CampaignRewards.
  //
  // If the pool is somehow exhausted (it is not expected to be — five
  // picks from a twelve-type pool leaves plenty of room) the loop bails
  // out and returns however many distinct offers it found.
  _rollInitialOffer(state) {
    const skeletonMult =
      state.champion?.def?.passive?.skeletonOfferChanceMultiplier ?? 1;
    const skeletonChance = CampaignConfig.skeletonOfferChance * skeletonMult;

    const excluded = new Set(state.roster.map(e => e.typeId));
    const offers = [];
    const maxAttempts = 500;
    let attempts = 0;
    while (offers.length < CampaignConfig.initialOffersPerRound
           && attempts < maxAttempts) {
      attempts++;
      const offer = UnitFamilies.randomOffer({ skeletonChance });
      if (excluded.has(offer.typeId)) continue;
      if (offers.some(o => o.typeId === offer.typeId)) continue;
      offers.push(offer);
    }
    return offers;
  }

  _finishInitialPicks(state) {
    state.initialPickState = null;
    this._beginBattle(state, 0, { reload: false });
  }

  // --- Reward picker (shop mode) ----------------------------------------

  // Between-battle shop. The player buys any number of unit offers they
  // can afford, may pay to heal one depleted unit, and continues when
  // ready. Each purchase re-renders this screen so gold and roster stay
  // current.
  _showRewardPicker(state) {
    this._setActivePicker(state, () => this._showRewardPicker(state));
    const opts = state.rewardOptions || [];

    const costModifiers = state.champion?.costMultipliers || null;
    const cards = opts.map((offer, i) => {
      const card = this._buildOfferCard(offer, String(i), { prefix: 'Recruit —', costModifiers });
      card.disabled = this._priceOfOffer(offer, costModifiers) > state.gold;
      return card;
    });

    // Optional reinforce entry point. One reinforce per reward phase (see
    // state.recoveredThisReward), and only when some unit actually needs
    // it — full-strength units are excluded from the roster screen itself
    // (see _showReinforcePicker), so this gate keeps the entry point from
    // appearing when the resulting screen would be empty.
    const canReinforce = !state.recoveredThisReward
      && CampaignRoster.hasRecoverableUnit(state.roster);
    if (canReinforce) {
      cards.push({
        id: 'reinforce',
        name: 'Reinforce a unit',
        description: 'Restore one depleted unit to full strength. Costs the unit\'s full price.',
        imageHtml: '',
        disabled: false
      });
    }

    // Champion sheet. Always shown when a champion exists so the player
    // can inspect the tree even with no unspent points; the description
    // flags whether there is anything to spend.
    if (state.champion) {
      const pts = state.champion.unspentPoints;
      const ptsText = pts > 0
        ? `${pts} skill point${pts === 1 ? '' : 's'} available`
        : `Level ${state.champion.level} — no points to spend`;
      // Mention the champion's pricing bias in the card description, so
      // the effect is not invisible between champion selection and the
      // first shop screen. Cheap to surface, and the player should
      // understand why a goblin offer costs half and a skeleton costs
      // double.
      const cm = state.champion.costMultipliers;
      const pricingText = cm
        ? 'Recruitment: goblins ×0.5, humans ×1.3, undead ×2.'
        : '';
      const desc = pricingText
        ? `Open the champion sheet. ${pricingText}`
        : 'Open the champion sheet to view skills and spend points.';
      cards.push({
        id: 'champion',
        name: `${state.champion.displayName} — ${ptsText}`,
        description: desc,
        imageHtml: '',
        disabled: false
      });
    }

    const subtitle = opts.length > 0
      ? 'Buy any units you can afford, then continue.'
      : 'No units left to buy. Continue when ready.';

    this.picker.show({
      title: `Battle ${state.battleIndex + 1} won`,
      subtitle,
      infoElement: this._buildInfoElement(state),
      cards,
      mode: 'single',
      onCardRightClick: (cardDef, el) => this._openCardInfo(cardDef, el),
      onCardAction: (cardDef) => {
        if (cardDef.id === 'reinforce') {
          state.phase = 'pick-recover';
          CampaignState.save(state);
          this._showReinforcePicker(state);
          return;
        }
        if (cardDef.id === 'champion') {
          // The panel is modal and closes on its own; re-render the
          // reward picker afterwards so a spent point is reflected in
          // the champion card's description.
          this.championPanel.show(state.champion, () => {
            CampaignState.save(state);
            this._showRewardPicker(state);
          });
          return;
        }
        const idx = parseInt(cardDef.id, 10);
        const offer = opts[idx];
        if (!offer) return;
        const price = this._priceOfOffer(offer, state.champion?.costMultipliers || null);
        if (price > state.gold) return;
        state.gold -= price;
        CampaignRoster.addUnit(state.roster, offer.typeId, offer.isUndead);
        state.rewardOptions.splice(idx, 1);
        CampaignState.save(state);
        this._showRewardPicker(state);
      },
      onContinue: () => {
        this._beginBattle(state, state.battleIndex + 1, { reload: true });
      },
      continueLabel: 'Continue to next battle →',
      onBack: () => {
        CampaignState.clear();
        this.mainMenu.show();
      },
      backLabel: 'Exit campaign'
    });
  }

  // --- Heal picker ------------------------------------------------------

  // Priced reinforce screen. Only DEPLETED units appear — full-strength
  // entries are filtered out entirely rather than shown disabled, so the
  // screen stays focused on what it can actually do. Affordability still
  // disables individual cards (the player may see the price and decide to
  // fight the next battle short-handed instead).
  //
  // Cost is the FULL price — same as buying the unit new — which is why
  // the price shown is computed against maxCount rather than the current
  // aliveCount.
// Priced reinforce screen. Only DEPLETED units appear — full-strength
  // entries are filtered out entirely rather than shown disabled, so the
  // screen stays focused on what it can actually do. Affordability still
  // disables individual cards (the player may see the price and decide to
  // fight the next battle short-handed instead).
  //
  // Cost is the FULL price — same as buying the unit new — which is why
  // the price shown is computed against maxCount rather than the current
  // aliveCount. Champion cost multipliers apply here too, so a Warlord's
  // goblin units are cheap to heal while their skeletons cost double.
  _showReinforcePicker(state) {
    this._setActivePicker(state, () => this._showReinforcePicker(state));
    const depleted = state.roster.filter(e => e.aliveCount < e.maxCount);
    const costModifiers = state.champion?.costMultipliers || null;

    const cards = depleted.map(entry => {
      const typeDef = UnitTypes[entry.typeId];
      const fullPrice = computeUnitPrice({
        typeDef,
        isUndead: entry.isUndead,
        aliveCount: entry.maxCount,
        championCostMultipliers: costModifiers
      });
      const affordable = fullPrice <= state.gold;
      const name = entry.customName
        || (entry.isUndead ? `Skeleton ${typeDef.displayName}` : typeDef.displayName);

      return {
        id: entry.id,
        name,
        description: `${entry.aliveCount} / ${entry.maxCount} — ${fullPrice} gold`,
        imageHtml: unitIconSvg(typeDef, entry.isUndead),
        disabled: !affordable,
        ...this._optionalPower(typeDef, entry.isUndead, entry.aliveCount),
        typeId: entry.typeId,
        isUndead: entry.isUndead,
        aliveCount: entry.aliveCount,
        maxCount: entry.maxCount,
        teamId: 'blue'
      };
    });

    this.picker.show({
      title: 'Reinforce a unit',
      subtitle: 'Choose a depleted unit to restore to full strength.',
      infoElement: this._buildInfoElement(state),
      cards,
      mode: 'single',
      orientation: 'horizontal',
      onCardRightClick: (cardDef, el) => this._openCardInfo(cardDef, el),
      onSelect: (entryId) => {
        const entry = state.roster.find(e => e.id === entryId);
        if (!entry) return;
        const typeDef = UnitTypes[entry.typeId];
        const fullPrice = computeUnitPrice({
          typeDef,
          isUndead: entry.isUndead,
          aliveCount: entry.maxCount,
          championCostMultipliers: costModifiers
        });
        if (fullPrice > state.gold) return;
        if (entry.aliveCount >= entry.maxCount) return;

        state.gold -= fullPrice;
        CampaignRoster.recoverUnit(state.roster, entryId);
        state.recoveredThisReward = true;
        state.phase = 'pick-reward';
        CampaignState.save(state);
        this._showRewardPicker(state);
      },
      onBack: () => {
        state.phase = 'pick-reward';
        CampaignState.save(state);
        this._showRewardPicker(state);
      }
    });
  }

_showGameOver(state, opts = {}) {
    const championDead = opts.reason === 'champion-dead';
    const title = championDead ? 'Champion Slain' : 'Campaign Over';
    const subtitle = championDead && state.champion
      ? `${state.champion.displayName} fell in battle ${state.battleIndex + 1}. The campaign ends here.`
      : `You reached battle ${state.battleIndex + 1}.`;

    this.picker.show({
      title,
      subtitle,
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

// Records the state object and redraw thunk of the picker currently on
  // screen. The test-cheat listener consults these to know which live
  // state to mutate and how to refresh the view afterwards. Passing
  // (null, null) — as _beginBattle does — closes the window during which
  // a cheat could fire, so a stale reference from a previous picker can
  // never be touched mid-battle.
  _setActivePicker(state, redraw) {
    this._cheatState = state;
    this._cheatRedraw = redraw;
  }

// --- Card view-model helpers -----------------------------------------

  // Builds a unit card for an offer. `prefix` is prepended to the
  // description (e.g. "Recruit — ") when supplied; the initial picker
  // passes null so the description reads as plain stats.
// Builds a unit card for an offer. `prefix` is prepended to the
  // description (e.g. "Recruit — ") when supplied; the initial picker
  // passes null so the description reads as plain stats.
  //
  // `costModifiers` is the active champion's cost-multiplier table, or
  // null. It flows through to computeUnitPrice so the displayed price
  // honours the champion's race-based pricing (Warlord: goblins 0.5×,
  // humans 1.3×, skeletons 2×).
  _buildOfferCard(offer, id, { prefix, costModifiers = null }) {
    const typeDef = UnitTypes[offer.typeId];
    const baseName = typeDef.displayName;
    const size = CampaignConfig.defaultSizes[offer.typeId];
    const price = computeUnitPrice({
      typeDef,
      isUndead: offer.isUndead,
      aliveCount: size,
      championCostMultipliers: costModifiers
    });
    const name = offer.isUndead ? `Skeleton ${baseName}` : baseName;
    const statLine = `${size} soldiers — ${price} gold`;
    const description = prefix ? `${prefix} ${statLine}` : statLine;

    return {
      id,
      name,
      description,
      imageHtml: unitIconSvg(typeDef, offer.isUndead),
      ...this._optionalPower(typeDef, offer.isUndead, size),
      typeId: offer.typeId,
      isUndead: offer.isUndead,
      aliveCount: size,
      maxCount: size,
      teamId: 'blue'
    };
  }

_priceOfOffer(offer, costModifiers = null) {
    const typeDef = UnitTypes[offer.typeId];
    const size = CampaignConfig.defaultSizes[offer.typeId];
    return computeUnitPrice({
      typeDef,
      isUndead: offer.isUndead,
      aliveCount: size,
      championCostMultipliers: costModifiers
    });
  }

  // Gold + roster summary shown on every campaign picker. Built as DOM
  // nodes (not an HTML string) so type defs with unusual display names
  // cannot inject markup. Positioned as a fixed left-side panel by CSS
  // (see STYLE_TEXT); each roster entry renders as a compact card with
  // the same icon vocabulary the picker cards use. A depleted entry's
  // count is tinted to draw the eye to it (the heal screen's candidate).
  _buildInfoElement(state) {
    const wrap = document.createElement('div');
    wrap.className = 'campaign-info';

    const gold = document.createElement('div');
    gold.className = 'campaign-info-gold';
    gold.textContent = `${state.gold} gold`;
    wrap.appendChild(gold);

    const roster = document.createElement('div');
    roster.className = 'campaign-info-roster';

    if (state.roster.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'campaign-info-roster-empty';
      empty.textContent = 'No units yet.';
      roster.appendChild(empty);
    } else {
      for (const entry of state.roster) {
        const typeDef = UnitTypes[entry.typeId];
        // customName wins when present — used by the champion's retinue
        // entry, which reads as the champion's name rather than the
        // unit type's default label.
        const baseName = entry.customName || typeDef.displayName;
        const name = entry.isUndead ? `Skeleton ${baseName}` : baseName;
        const depleted = entry.aliveCount < entry.maxCount;

        const card = document.createElement('div');
        card.className = 'campaign-info-card';
        card.title = `${name} — ${entry.aliveCount}/${entry.maxCount} (right-click for details)`;
        card.style.cursor = 'pointer';

        // Right-click → open the shared UnitInfoPanel with a synthetic
        // preview of this roster entry. Mirrors the picker-card
        // right-click path (see _openCardInfo): the roster entry already
        // carries every field that method reads (id, typeId, isUndead,
        // aliveCount, maxCount), so it is passed through directly rather
        // than being adapted into a card-shaped object. teamId defaults
        // to 'blue' inside _openCardInfo, matching this panel's
        // player-only roster.
        //
        // No-op when no UnitInfoPanel was supplied — CampaignFlow is
        // constructible without one, and _openCardInfo guards on that
        // case (as does its cardDef.typeId check). preventDefault
        // suppresses the browser's native context menu, matching the
        // picker-card behaviour.
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this._openCardInfo(entry, card);
        });

        const icon = document.createElement('div');
        icon.className = 'campaign-info-card-icon';
        icon.innerHTML = unitIconSvg(typeDef, entry.isUndead);
        // Rank badge for levelled roster entries. entry.level is always
        // present (CampaignRoster.newEntry seeds it to 1); level 1 gets
        // no badge, so a fresh recruit card looks exactly as before.
        attachRankBadge(icon, entry.level);
        card.appendChild(icon);

        const nameEl = document.createElement('div');
        nameEl.className = 'campaign-info-card-name';
        nameEl.textContent = name;
        card.appendChild(nameEl);

        const countEl = document.createElement('div');
        countEl.className = 'campaign-info-card-count'
          + (depleted ? ' depleted' : '');
        countEl.textContent = `${entry.aliveCount}/${entry.maxCount}`;
        card.appendChild(countEl);

        roster.appendChild(card);
      }
    }
    wrap.appendChild(roster);

    return wrap;
  }

  // --- Card power gating ------------------------------------------------

  // Returns `{ power }` when the campaign power display is on, `{}` when
  // it is off. The campaign shows prices in the description text, so this
  // is off by default; the hook is kept so a future "show both" toggle is
  // trivial.
  _optionalPower(typeDef, isUndead, aliveCount) {
    if (!this.showPower) return {};
    const preview = buildPreviewUnit({
      id: 'card-preview',
      typeDef,
      isUndead,
      aliveCount,
      maxCount: aliveCount,
      teamId: 'blue'
    });
    return { power: preview.getPower().total };
  }

  // --- Card info panel --------------------------------------------------

  // Right-click handler shared by every campaign picker. Builds a
  // full-strength preview of the unit the card represents and opens the
  // shared UnitInfoPanel on it. No-op when the panel was not supplied or
  // the card lacks a usable typeId (e.g. the reward screen's "Heal a
  // unit" card, which is an action, not a unit).
  _openCardInfo(cardDef, anchorEl) {
    if (!this.unitInfoPanel) return;
    if (!cardDef || !cardDef.typeId) return;
    const typeDef = UnitTypes[cardDef.typeId];
    if (!typeDef) return;

    const preview = buildPreviewUnit({
      id: cardDef.id,
      typeDef,
      isUndead: cardDef.isUndead,
      aliveCount: cardDef.aliveCount,
      maxCount: cardDef.maxCount,
      teamId: cardDef.teamId || 'blue'
    });
    this.unitInfoPanel.open(preview, anchorEl);
  }

  // --- Battle launch ----------------------------------------------------

  _beginBattle(state, battleIndex, { reload }) {
    // No picker is on screen during a battle; close the cheat window so
    // the listener cannot mutate the pre-battle state object while the
    // simulation runs.
    this._setActivePicker(null, null);
    state.battleIndex = battleIndex;
    state.phase = 'battle';

    // Apply this campaign's AI tier to the shared preference that BattleAI
    // reads when no explicit opts.tierName is supplied. Easy maps to
    // 'weakened', normal and hard both map to 'best_possible'. Set every
    // battle (not just the first) so that a mid-campaign change to the
    // preference via the Custom Battle picker cannot silently desync a
    // campaign in progress — the campaign reasserts its own tier here.
    const diffCfg = state.difficulty
      ? CampaignConfig.difficulties[state.difficulty]
      : null;
    if (diffCfg && diffCfg.aiTierName) {
      AITierPreference.set(diffCfg.aiTierName);
    }

    // state.aiRoster currently holds the survivors produced by the
    // previous battle's processAISurvivors (or [] on the very first
    // battle). generateAIRoster seeds with them at no gold cost, then
    // spends this battle's gold budget on fresh units on top. The active
    // difficulty tunes gold growth past the schedule's end and — on
    // normal and easy — replaces the first battle's roster with a fixed
    // 3-unit force (see CampaignBattleBuilder).
    state.aiRoster = generateAIRoster(battleIndex, state.aiRoster, state.difficulty);
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
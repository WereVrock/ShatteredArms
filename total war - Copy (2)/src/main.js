// ===== main.js =====
import { BattleSimulation } from './sim/BattleSimulation.js';
import { SceneSetup } from './render/SceneSetup.js';
import { BattleRenderer } from './render/BattleRenderer.js';
import { OrderPreviewView } from './render/OrderPreviewView.js';
import { SelectionBoxView } from './render/SelectionBoxView.js';
import { HudView } from './ui/HudView.js';
import { MainMenu } from './ui/MainMenu.js';
import { ScenarioMenu } from './ui/ScenarioMenu.js';
import { ArmyBarView } from './ui/ArmyBarView.js';
import { CommandBarView } from './ui/CommandBarView.js';
import { CameraController } from './input/CameraController.js';
import { SelectionController } from './input/SelectionController.js';
import { OrderDragController } from './input/OrderDragController.js';
import { PlayableScenarios } from './scenarios/PlayableScenarios.js';
import { CombatConfig } from './config/CombatConfig.js';
import { isRanged } from './config/UnitClasses.js';
import { BattleAI } from './ai/BattleAI.js';
import { AIDebugLog } from './ai/AIDebugLog.js';
import { CampaignState } from './campaign/CampaignState.js';
import { CampaignFlow } from './campaign/CampaignFlow.js';
import { buildCampaignScenario } from './campaign/CampaignBattleBuilder.js';
import { ActiveScenario } from './session/ActiveScenario.js';
import { ActiveCustomBattle } from './session/ActiveCustomBattle.js';
import { BattleFlowController } from './session/BattleFlowController.js';
import { CustomBattleSetup } from './ui/CustomBattleSetup.js';
import { buildCustomScenario } from './scenarios/CustomBattleBuilder.js';
import { DeploymentPhase } from './deployment/DeploymentPhase.js';
import { DeploymentZoneView } from './deployment/DeploymentZoneView.js';
import { DeploymentPanel } from './ui/DeploymentPanel.js';
import { DeploymentConfig } from './config/DeploymentConfig.js';
import { SettingsStore } from './ui/settings/SettingsStore.js';
import { SettingsPanel } from './ui/settings/SettingsPanel.js';
import { PauseMenuPanel } from './ui/PauseMenuPanel.js';
import { BattleResultView } from './ui/BattleResultView.js';

// Boot flow: build the menu stack, then either resume whatever was running
// before the last reload, or show the top-level menu.
//
// Persistence contract (both sessionStorage, both survive a same-tab reload):
//   - CampaignState      tracks an in-progress campaign (any phase).
//   - ActiveScenario     tracks a standalone scenario being played.
// Only one is ever meaningful at a time — launching a campaign clears the
// scenario key, and launching a scenario is only possible when no campaign
// exists (the main menu is not reachable mid-campaign except via Menu, which
// clears both).
//
// Menu button:  opens the in-game pause menu. Its Exit-to-Main-Menu action
//               clears both keys and reloads — the previous direct behavior.
// Restart button: reloads without clearing. Boot resumes the same battle.
//
// Settings live in SettingsStore (localStorage), and are applied to the
// scene by a subscribe() wired in startScenario(). The SettingsPanel is a
// single shared instance, opened from both the main menu and the pause menu.

// Shape-tolerant adapter for the intent snapshot of a unit that belongs to
// an AI team. BattleAI holds its TeamAI instances under one of a handful of
// conventional field names; this tries each, walks the resulting list, and
// returns the info object from the team whose teamId matches the unit's.
// Returns null when the unit's team has no TeamAI (player team) or when the
// BattleAI shape isn't recognised — either way the HUD simply omits the
// intent block rather than throwing.
//
// If BattleAI exposes its teams under a name not listed here, add it to
// `candidates` below. The rest of the debug flow needs no changes.
function findIntentInfo(battleAI, unit) {
  if (!battleAI || !unit) return null;
  const candidates = battleAI.teams
    || battleAI._teams
    || battleAI.teamAIs
    || battleAI._teamAIs
    || null;
  if (!candidates) return null;

  const list = Array.isArray(candidates)
    ? candidates
    : (typeof candidates.values === 'function' ? Array.from(candidates.values()) : []);
  for (const team of list) {
    if (!team || team.teamId !== unit.teamId) continue;
    if (!team.intents) continue;
    return {
      intent: team.intents.get(unit.id),
      currentTick: team.tickCounter,
      teamId: team.teamId,
      posture: team.assessment ? team.assessment.posture : null,
      strengthRatio: team.assessment ? team.assessment.strengthRatio : null,
      moraleAdvantage: team.assessment ? team.assessment.moraleAdvantage : null,
      planTactic: team._currentPlan ? team._currentPlan.tactic : null,
      planPhase: team._currentPlan ? team._currentPlan.phase : null,
      objectiveUnitId: team._currentObjectiveUnit ? team._currentObjectiveUnit.id : null
    };
  }
  return null;
}

const canvas = document.getElementById('renderCanvas');
const hudElement = document.getElementById('hud');
const hudToggle = document.getElementById('hudToggle');
const menuButton = document.getElementById('menuButton');
const restartButton = document.getElementById('restartButton');
const pauseIndicator = document.getElementById('pauseIndicator');
const menuElement = document.getElementById('mainMenu');
const armyBarElement = document.getElementById('armyBar');
const commandBarElement = document.getElementById('commandBar');

let isPaused = false;

// --- Shared exit path -----------------------------------------------------

// Clears all three persistence keys (campaign, scenario, custom battle)
// and reloads so boot shows the main menu with nothing to resume. Used by
// both the pause menu's Exit action and the standalone battle result
// screen's Return-to-Main-Menu button.
function returnToMainMenu() {
  ActiveScenario.clear();
  ActiveCustomBattle.clear();
  CampaignState.clear();
  window.location.reload();
}

// --- Menu wiring ----------------------------------------------------------

// The shared settings dialog. One instance per page, opened from both the
// main menu (via MainMenu.onSettings) and the in-game pause menu. The panel
// reads and writes SettingsStore directly; the running scene reacts to
// changes via the subscription set up in startScenario().
const settingsPanel = new SettingsPanel();

// End-of-battle result screen for standalone scenarios and custom battles.
// The campaign flow uses its own between-battle pickers instead (see
// CampaignFlow), so this is shown only when startScenario was called
// without an onBattleEnded callback.
const battleResultView = new BattleResultView();

const menu = new MainMenu(menuElement, {
  onScenarios: () => scenarioMenu.show(),
  onCampaign: () => campaignFlow.startNewCampaign(),
  onCustomBattle: () => customBattleSetup.show(ActiveCustomBattle.getLastSetup()),
  onSettings: () => settingsPanel.open()
});

const scenarioMenu = new ScenarioMenu(menuElement, {
  scenarios: PlayableScenarios,
  onSelect: (scenario) => {
    ActiveCustomBattle.clear();
    ActiveScenario.set(scenario.id);
    menuElement.classList.add('hidden');
    startScenario(scenario);
  },
  onBack: () => menu.show()
});

const campaignFlow = new CampaignFlow({
  menuElement,
  mainMenu: menu,
  onStartBattle: (state) => launchCampaignBattle(state)
});

// Custom battle setup. Not persisted through ActiveScenario — a reload
// mid-custom-battle drops back to the main menu, which is fine for a
// one-off configuration screen. onStart receives freshly-cloned roster
// arrays; the setup screen resets itself the next time it is opened.
const customBattleSetup = new CustomBattleSetup(menuElement, {
  onStart: (blueRoster, redRoster) => {
    // Custom battle is tracked by ActiveCustomBattle alone; clear the
    // scenario key so a later reload can't resume a stale standalone
    // scenario. Persist BEFORE building — buildCustomScenario takes the
    // rosters by reference, so what we store is what we fight.
    ActiveScenario.clear();
    // Two writes: the ACTIVE slot drives Restart/resume and is cleared on
    // Exit; the LAST SETUP slot survives Exit and seeds the setup screen
    // next time the player opens Custom Battle.
    ActiveCustomBattle.set(blueRoster, redRoster);
    ActiveCustomBattle.setLastSetup(blueRoster, redRoster);
    const scenario = buildCustomScenario(blueRoster, redRoster);
    menuElement.classList.add('hidden');
    startScenario(scenario);
  },
  // Reset to Blank also forgets the saved setup, so the blank state
  // survives a close-and-reopen. Without this the button would only
  // clear the current view, and reopening the screen would restore the
  // pre-reset rosters from storage — which reads as the reset silently
  // failing.
  onReset: () => ActiveCustomBattle.clearLastSetup(),
  onBack: () => menu.show()
});

// The in-game pause menu. "Exit to Main Menu" routes through the shared
// returnToMainMenu() helper — same path the result screen uses. onClose
// restores whatever pause state was active before the menu opened, so
// opening the menu while manually paused and then closing it does not
// silently unpause the game.
let _pausedBeforePauseMenu = false;

const pauseMenu = new PauseMenuPanel({
  onExitToMainMenu: () => returnToMainMenu(),
  onClose: () => {
    isPaused = _pausedBeforePauseMenu;
    pauseIndicator.classList.toggle('hidden', !isPaused);
  },
  settingsPanel
});

// The Menu button now opens the pause menu instead of jumping straight out
// of the battle. The battle is paused while the menu is open so the fight
// does not run behind the overlay.
menuButton.addEventListener('click', () => {
  _pausedBeforePauseMenu = isPaused;
  isPaused = true;
  pauseIndicator.classList.toggle('hidden', !isPaused);
  pauseMenu.open();
});

// "Restart" re-runs the current battle from its initial state. The page
// reloads without clearing persistence, so boot re-launches whatever battle
// was active: the same scenario, or the same campaign battle.
restartButton.addEventListener('click', () => {
  window.location.reload();
});

hudToggle.addEventListener('click', () => {
  hudElement.classList.toggle('hidden');
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    isPaused = !isPaused;
    pauseIndicator.classList.toggle('hidden', !isPaused);
  }
});

// --- Scenario launcher ----------------------------------------------------

function launchCampaignBattle(state) {
  // A campaign battle is tracked by CampaignState alone; clear the scenario
  // key so a later reload can't resume a stale standalone scenario.
  ActiveScenario.clear();
  const scenario = buildCampaignScenario(state);
  menuElement.classList.add('hidden');
  startScenario(scenario, (sim) => {
    campaignFlow.handleBattleEnded(state, sim);
  });
}

// onBattleEnded is optional. When supplied (campaign battles), it is
// called once the battle resolves, in place of the standalone result
// screen. When omitted (scenarios and custom battles), the
// BattleResultView shows instead.
function startScenario(scenario, onBattleEnded) {
  battleResultView.hide();

  const units = scenario.build();

  const sceneSetup = new SceneSetup(canvas, {
    cameraTarget: scenario.cameraTarget || { x: 0, z: 0 },
    cameraYaw: scenario.cameraYaw ?? Math.PI,
    cameraDistance: scenario.cameraDistance ?? 34,
    cameraPitch: scenario.cameraPitch ?? 0.95,
    // Apply the persisted user settings to the freshly-built scene. The
    // subscription below keeps them in sync if the player toggles a setting
    // mid-battle from the pause menu.
    settings: SettingsStore.get()
  });

  // Apply live settings changes (shadows on/off, ground texture on/off) to
  // the running scene as soon as the SettingsStore value changes, no matter
  // which UI panel flipped it. Never unsubscribed — the scene lives for the
  // whole page, and exiting to the main menu reloads the page.
  SettingsStore.subscribe(() => {
    sceneSetup.applySettings(SettingsStore.get());
  });

  const battleRenderer = new BattleRenderer(sceneSetup);

  // Corridor-check debug visualization. ChargeReadiness fires a geometry
  // event whenever the corridor check refuses a charge; the renderer draws
  // it as a red translucent rectangle for 2 seconds of sim-time, freezing
  // while paused.
  AIDebugLog.onCorridorEvent = (evt) => battleRenderer.pushCorridorEvent(evt);
  const orderPreviewView = new OrderPreviewView(sceneSetup.scene);
  const selectionBoxView = new SelectionBoxView(document.body);
  const hudView = new HudView(hudElement);

  const simulation = new BattleSimulation(units, {
    playerTeamId: scenario.playerTeamId
  });
  simulation.battleAI = new BattleAI(simulation.units, scenario.aiTeamIds, {
    valiantDefenceTeamIds: scenario.valiantDefenceTeamIds
  });

  // --- Deployment phase ---
  // Pre-battle placement. Every team (AI and player) is placed instantly by
  // its deployment template. The player can then reposition their own units
  // inside the blue zone; the AI's units stay frozen until Start Battle.
  //
  // While deployment is active, BattleSimulation.tick() early-returns: no
  // AI decisions, no MovementSystem, no combat. The player's repositioning
  // orders go through Unit.issueInstantMoveOrder (via
  // DeploymentPhase.playerMoveUnit), which snaps soldiers directly to their
  // new formation slots.
  //
  // deploymentPanel is constructed BEFORE deploymentPhase is assigned: its
  // onStart closure captures the `let` binding, so it sees the final value
  // by the time the button is actually pressed.
  const deploymentZoneView = new DeploymentZoneView(sceneSetup.scene);

  let deploymentPhase = null;
  const deploymentPanel = new DeploymentPanel(document.body, {
    onStart: () => {
      if (deploymentPhase) deploymentPhase.startBattle();
    }
  });

  deploymentPhase = new DeploymentPhase(simulation, {
    // The scenario's player team is the only human-controlled team. Every
    // other team goes through the AI deployment director. Passing this
    // explicitly is what allows DeploymentPhase to distinguish "player
    // repositions this manually" from "AI places it according to its own
    // decision" — without it, all teams would use the same template.
    playerTeamIds: [scenario.playerTeamId],
    onBattleStart: () => {
      deploymentZoneView.hideAll();
    }
  });
  simulation.deploymentPhase = deploymentPhase;

  // Show the player's deployment zone on the ground. The enemy's zone is
  // deliberately not rendered: the player has no authority over it, and
  // showing it would give away the AI's placement area for free.
  const playerZone = deploymentPhase.getZone(scenario.playerTeamId);
  if (playerZone) {
    deploymentZoneView.show(
      scenario.playerTeamId,
      playerZone,
      DeploymentConfig.playerZoneColor,
      DeploymentConfig.zoneFillOpacity,
      DeploymentConfig.zoneOutlineOpacity
    );
  }

  const cameraController = new CameraController(canvas, sceneSetup);
  const selectionController = new SelectionController(
    canvas,
    sceneSetup,
    simulation.units,
    battleRenderer,
    selectionBoxView,
    [scenario.playerTeamId]
  );
  const orderDragController = new OrderDragController(
    canvas,
    sceneSetup,
    selectionController,
    orderPreviewView,
    deploymentPhase
  );

  // Debug-inspect wiring: hold G + left-click to open a unit in the HUD
  // info panel and draw a line from its center to its formationOrigin (its
  // ordered destination). The intent snapshot tells you what the AI is
  // actually trying to do — phase, target, attempts, posture, plan — which
  // is what makes an otherwise-opaque "why is this unit walking that way"
  // reproducible from the UI instead of from a log dump.
  selectionController.onDebugSelectionChanged = (unit) => {
    const intentInfo = findIntentInfo(simulation.battleAI, unit);
    hudView.setDebugInfo(unit ? { unit, intentInfo } : null);
    battleRenderer.setDebugPathUnit(unit);
    battleRenderer.setDebugCorridorUnit(unit);

    // Debug mode is on exactly while a G+click target is selected. While
    // on, the formation-slot overlay tracks the player's CURRENT selection
    // live (via the provider function) — not the G+click target itself,
    // since the slot overlay is meant to inspect your own units' formation
    // math, separate from whichever enemy is being G-clicked for intent info.
    battleRenderer.setDebugModeOn(
      !!unit,
      () => selectionController.selectedUnits
    );
  };

  // Double-clicking a card recenters the camera on that unit's current
  // center. panCamera() takes a DELTA, so the delta is (unit center) minus
  // (current camera target). Going through panCamera rather than writing
  // sceneSetup.cameraTarget directly keeps the sun-shadow frustum
  // recentering inside SceneSetup._updateCameraTransform, which is the
  // only place that knows the frustum follows the camera target.
  const armyBarView = new ArmyBarView(
    armyBarElement,
    selectionController,
    scenario.playerTeamId,
    (unit) => {
      const c = unit.getCenter();
      sceneSetup.panCamera(
        c.x - sceneSetup.cameraTarget.x,
        c.z - sceneSetup.cameraTarget.z
      );
    }
  );

  // Command bar sits directly above the army bar. Both callbacks operate
  // on selectionController.selectedUnits — the same Set the HUD reads —
  // so the bar's state and the camera selection can never diverge.
  const commandBarView = new CommandBarView(commandBarElement, armyBarElement);

  commandBarView.onSetFireAtWill = (newState) => {
    for (const u of selectionController.selectedUnits) {
      const lead = u.soldiers && u.soldiers[0];
      if (lead && lead.unitTypeDef && isRanged(lead.unitTypeDef)) {
        u.fireAtWill = newState;
      }
    }
  };

  commandBarView.onStop = () => {
    for (const u of selectionController.selectedUnits) {
      u.stopOrder();
    }
  };

  // Battle lifecycle. Owns the fighting / awaiting-choice / pursuing /
  // ended state machine, the pursuit prompt, the end-battle button, and
  // the tick gating that goes with them. main.js only asks it to step()
  // once per tick interval.
  //
  // Resolution routing: campaign battles supply onBattleEnded, so the
  // controller hands off to it. Standalone scenarios and custom battles
  // do not, so the result screen shows instead.
  const battleFlow = new BattleFlowController({
    simulation,
    playerTeamId: scenario.playerTeamId,
    onResolved: (outcome) => {
      if (onBattleEnded) {
        onBattleEnded(simulation);
      } else {
        battleResultView.show(outcome, { onReturn: returnToMainMenu });
      }
    }
  });

  const tickIntervalMs = 1000 / CombatConfig.tickRateHz;
  let lastTickTime = performance.now();
  let lastFrameTime = performance.now();

  function loop(now) {
    requestAnimationFrame(loop);

    const frameDelta = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    const visualDelta = isPaused ? 0 : frameDelta;

    cameraController.update(frameDelta);
    orderPreviewView.update(visualDelta);

    let meleeEvents = [];
    let rangedEvents = [];
    if (!isPaused && now - lastTickTime >= tickIntervalMs) {
      lastTickTime = now;
      const ticked = battleFlow.step();
      if (ticked) {
        meleeEvents = simulation.combatResolutionSystem.drainEvents();
        rangedEvents = simulation.projectileSystem.drainEvents();
      }
    }

    const allSoldiers = simulation.getAllSoldiers();
    const allSoldiersById = new Map(allSoldiers.map(s => [s.id, s]));
    const projectiles = simulation.projectileSystem.getActiveProjectiles();

    battleRenderer.syncWithSimulation(
      allSoldiers,
      simulation.unitsById,
      meleeEvents,
      rangedEvents,
      projectiles,
      visualDelta
    );
    hudView.update(simulation.units, allSoldiersById, selectionController.selectedUnits);
    armyBarView.update(simulation.units);
    commandBarView.update(selectionController.selectedUnits);
    battleRenderer.render();
  }

  requestAnimationFrame(loop);
}

// --- Boot -----------------------------------------------------------------

const campaign = CampaignState.load();

if (campaign && campaign.phase === 'battle') {
  // Reload during a campaign battle: resume it.
  launchCampaignBattle(campaign);
} else if (campaign) {
  // Reload during a between-battle picker: resume the picker.
  campaignFlow.resume(campaign);
} else {
  // No active campaign. A standalone scenario OR a custom battle may still
  // be in progress — both are set at launch time from the main menu and
  // both are cleared by Exit to Main Menu. The two are mutually exclusive
  // by construction (starting either clears the other's key), so at most
  // one of these branches fires. Precedence is scenario > custom only
  // because the scenario lookup is cheaper; the exclusivity makes the
  // order irrelevant in practice.
  const activeScenarioId = ActiveScenario.get();
  const scenario = activeScenarioId
    ? PlayableScenarios.find(s => s.id === activeScenarioId)
    : null;
  const customBattle = scenario ? null : ActiveCustomBattle.load();

  if (scenario) {
    startScenario(scenario);
  } else if (customBattle) {
    startScenario(buildCustomScenario(customBattle.blueRoster, customBattle.redRoster));
  } else {
    if (activeScenarioId) ActiveScenario.clear();
    menu.show();
  }
}
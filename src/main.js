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
import { ActiveLocalMultiplayer } from './session/ActiveLocalMultiplayer.js';
import { BattleFlowController } from './session/BattleFlowController.js';
import { CustomBattleSetup } from './ui/CustomBattleSetup.js';
import { buildCustomScenario } from './scenarios/CustomBattleBuilder.js';
import { DeploymentPhase } from './deployment/DeploymentPhase.js';
import { DeploymentPlanner } from './deployment/DeploymentPlanner.js';
import { StandardDeployment } from './deployment/templates/StandardDeployment.js';
import { DeploymentZoneView } from './deployment/DeploymentZoneView.js';
import { DeploymentPanel } from './ui/DeploymentPanel.js';
import { DeploymentConfig } from './config/DeploymentConfig.js';
import { SettingsStore } from './ui/settings/SettingsStore.js';
import { SettingsPanel } from './ui/settings/SettingsPanel.js';
import { PauseMenuPanel } from './ui/PauseMenuPanel.js';
import { BattleResultView } from './ui/BattleResultView.js';
import { UnitInfoPanel } from './ui/UnitInfoPanel.js';
import { HelpPanel } from './ui/HelpPanel.js';
import { FpsCounter } from './ui/FpsCounter.js';
import { PowerBalanceView } from './ui/PowerBalanceView.js';
import { MPLobby } from './net/MPLobby.js';
import { LocalMultiplayerSetup } from './ui/LocalMultiplayerSetup.js';
import { LocalMultiplayerController } from './session/LocalMultiplayerController.js';
import { MPDeploymentPhase } from './net/MPDeploymentPhase.js';
import { MPPauseController } from './net/MPPauseController.js';
import { HostController } from './net/HostController.js';
import { GuestController } from './net/GuestController.js';
import { VersionBadge } from './ui/VersionBadge.js';
import { FullscreenButton } from './ui/FullscreenButton.js';
import { TickProfiler } from './sim/TickProfiler.js';
import { RenderBisect } from './render/RenderBisect.js';

// Boot flow: build the menu stack, then either resume whatever was running
// before the last reload, or show the top-level menu.
//
// Persistence contract (all sessionStorage, all survive a same-tab reload):
//   - CampaignState          tracks an in-progress campaign (any phase).
//   - ActiveScenario         tracks a standalone scenario being played.
//   - ActiveCustomBattle     tracks a custom-battle roster pair being played.
//   - ActiveLocalMultiplayer tracks a same-device MP battle being played.
// Only one is ever meaningful at a time — each launcher clears the slots
// it does not own. The main menu is not reachable mid-battle except via
// Menu, which clears every slot.
//
// Menu button:  opens the in-game pause menu. Its Exit-to-Main-Menu action
//               clears both keys and reloads — the previous direct behavior.
// Restart button: reloads without clearing. Boot resumes the same battle.
//
// Settings live in SettingsStore (localStorage), and are applied to the
// scene by a subscribe() wired in startScenario(). The SettingsPanel is a
// single shared instance, opened from both the main menu and the pause menu.
//
// Multiplayer (host-authoritative):
//   The host runs the sim normally and broadcasts a snapshot every tick.
//   The guest builds the same scenario locally, sets simulation.tickEnabled
//   = false, and applies snapshots into its mirror. Guest player orders are
//   forwarded to the host via GuestController.sendOrder(); the host applies
//   them to the guest's units and the next snapshot reflects the change.
//   Deployment is a hidden, timed, simultaneous placement phase (see
//   MPDeploymentPhase). No BattleAI is constructed — both teams are human.

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

// Bottom-left version badge. Mounted once on document.body so it
// survives menu re-renders. Visible while either the top-level menu or
// the in-game pause menu is open. The pause menu is registered as a
// second watched element further down, once it has been constructed.
const versionBadge = new VersionBadge().mount(document.body);

// Bottom-right fullscreen toggle. Mounted once on document.body so it
// survives menu re-renders, exactly like the version badge above. The
// instance is not bound to a name because nothing downstream needs a
// reference to it — it self-manages its DOM and its fullscreenchange
// listener, and lives for the tab's lifetime.
new FullscreenButton();

const canvas = document.getElementById('renderCanvas');
const hudElement = document.getElementById('hud');
const hudToggle = document.getElementById('hudToggle');
const menuButton = document.getElementById('menuButton');
const restartButton = document.getElementById('restartButton');
const helpButton = document.getElementById('helpButton');
const pauseIndicator = document.getElementById('pauseIndicator');
const menuElement = document.getElementById('mainMenu');
const armyBarElement = document.getElementById('armyBar');
const commandBarElement = document.getElementById('commandBar');

let isPaused = false;
let _pausedBeforePauseMenu = false;

// True only for the first startScenario call after a Restart-button
// reload, then consumed. This is how startScenario distinguishes a fresh
// battle launch from a same-battle resume: the Restart button writes a
// sessionStorage flag before reloading, and this is read and cleared once
// on boot. Any subsequent battle in the same session sees false, so a
// second battle launched from the menu after a restart is treated as
// fresh again.
//
// sessionStorage, not a URL param or a global, so the flag is scoped to
// this tab and cannot leak between tabs.
let bootIsRestart = (() => {
  try {
    const flag = sessionStorage.getItem('sa.restartIntent');
    if (flag) {
      sessionStorage.removeItem('sa.restartIntent');
      return true;
    }
  } catch (e) { /* sessionStorage may throw in private mode; degrade to fresh */ }
  return false;
})();

// Active MP pause controller for the current battle, or null in SP. Set
// by startScenario; read by the Space key handler and the render loop.
let currentMPPause = null;

// True while a turn-based same-device battle is running. Space pauses the
// sim in every other mode, but in turn-based local MP the sim is frozen
// and unfrozen by the turn state machine — a manual pause would fight it,
// and the "PAUSED" indicator would lie about why the sim is stopped.
let localTurnBasedActive = false;

// Cleanup hook for the current battle's local-MP controller, or null.
// battleFlow.onResolved reads this to dispose the controller and clear
// the flag; startScenario assigns it for local turn-based battles only.
let currentLocalController = null;

// True from startScenario until the battle resolves or the page exits
// to the main menu. The ESC handler reads this so pressing Escape on the
// main menu does not pop an empty pause overlay with no sim to pause.
let battleActive = false;

// Loop-section timings for the render diag. Populated every frame by
// _recordLoopTimings while the diag is on, drained once per log line.
// Null otherwise — loop() pays one null check per section, nothing else.
let _diagLoopTimings = null;

function _recordLoopTimings(preMs, tickMs, postMs) {
  const arr = _diagLoopTimings;
  if (!arr) return;
  const MAX = 120;
  arr.pre.push(preMs);
  arr.tick.push(tickMs);
  arr.post.push(postMs);
  if (arr.pre.length > MAX) arr.pre.shift();
  if (arr.tick.length > MAX) arr.tick.shift();
  if (arr.post.length > MAX) arr.post.shift();
}

// --- Shared exit path -----------------------------------------------------

function returnToMainMenu() {
  ActiveScenario.clear();
  ActiveCustomBattle.clear();
  ActiveLocalMultiplayer.clear();
  CampaignState.clear();
  battleActive = false;
  window.location.reload();
}

// --- Menu wiring ----------------------------------------------------------

const settingsPanel = new SettingsPanel();

const battleResultView = new BattleResultView();

const unitInfoPanel = new UnitInfoPanel();

const helpPanel = new HelpPanel();

const fpsCounter = new FpsCounter();

const menu = new MainMenu(menuElement, {
  onScenarios: () => scenarioMenu.show(),
  onCampaign: () => campaignFlow.startNewCampaign(),
  onCustomBattle: () => customBattleSetup.show(ActiveCustomBattle.getLastSetup()),
  onSettings: () => settingsPanel.open('main'),
  onMultiplayer: () => {
    _pausedBeforePauseMenu = isPaused;
    isPaused = true;
    pauseIndicator.classList.toggle('hidden', !isPaused);
    mpLobby.open();
  }
});

const scenarioMenu = new ScenarioMenu(menuElement, {
  scenarios: PlayableScenarios,
  onSelect: (scenario) => {
    ActiveCustomBattle.clear();
    // Record the customization when this was a ScenarioMenu resolved
    // copy. Two consequences:
    //   - boot uses "overrides present" to route a Ctrl+R back to this
    //     menu instead of auto-resuming the battle (see boot block),
    //   - the Restart button still resumes the exact customized battle
    //     (its flag bypasses the Ctrl+R reroute).
    // A plain scenario launch (tick off) stores only the id, so
    // auto-resume behavior for it is unchanged.
    if (scenario.customized) {
      ActiveScenario.setCustomized(scenario.id, {
        playerTeamId: scenario.playerTeamId,
        aiTeamIds: scenario.aiTeamIds,
        aiTierByTeamId: scenario.aiTierByTeamId
      });
    } else {
      ActiveScenario.set(scenario.id);
    }
    menuElement.classList.add('hidden');
    startScenario(scenario);
  },
  onBack: () => menu.show()
});

const campaignFlow = new CampaignFlow({
  menuElement,
  mainMenu: menu,
  onStartBattle: (state) => launchCampaignBattle(state),
  unitInfoPanel
});

const customBattleSetup = new CustomBattleSetup(menuElement, {
  onStart: (blueRoster, redRoster, playerTeamId, aiTierByTeamId) => {
    ActiveScenario.clear();
    // aiTierByTeamId is accepted by the persistence layer as a 4th arg;
    // an older ActiveCustomBattle that ignores it degrades gracefully —
    // the tier map still reaches buildCustomScenario below, so the
    // current battle is unaffected and only cross-reload persistence is
    // lost until the store is extended.
    ActiveCustomBattle.set(blueRoster, redRoster, playerTeamId, aiTierByTeamId);
    ActiveCustomBattle.setLastSetup(blueRoster, redRoster, playerTeamId, aiTierByTeamId);
    const scenario = buildCustomScenario(blueRoster, redRoster, playerTeamId, aiTierByTeamId);
    menuElement.classList.add('hidden');
    startScenario(scenario);
  },
  // Reset persists an empty-roster payload (with the current player /
  // AI role) rather than clearing the slot outright. Clearing made
  // reopening Custom Battle hit show(null), whose else-branch hardcodes
  // playerTeamId = 'blue' — silently turning a spectator (both-AI)
  // setup into player-vs-AI on the next visit. Writing the empty-but-
  // role-preserving payload keeps both halves of the button's contract:
  // rosters go away, role survives.
  onReset: (blueRoster, redRoster, playerTeamId, aiTierByTeamId) => {
    ActiveCustomBattle.setLastSetup(
      blueRoster, redRoster, playerTeamId, aiTierByTeamId
    );
  },
  onBack: () => menu.show(),
  unitInfoPanel
});

// MP lobby. Owns the entire pre-battle negotiation: room code, host/join,
// mode + settings + rosters, Ready handshake. When it fires onMatchStart,
// the session and scenario are fully negotiated and main.js just builds
// the battle scene.
const mpLobby = new MPLobby({
  onClose: () => {
    isPaused = _pausedBeforePauseMenu;
    pauseIndicator.classList.toggle('hidden', !isPaused);
  },
  onMatchStart: (info) => startMultiplayerBattle(info),
  onSameDevice: () => localMultiplayerSetup.show()
});
mpLobby.setCustomBuilder(buildCustomScenario);

// Same-device (local) multiplayer. The setup panel uses the same #mainMenu
// root as the other menus. The custom-forces sub-flow is a SEPARATE
// CustomBattleSetup instance whose onStart routes back into
// localMultiplayerSetup instead of launching a battle.
//
// Declaration order: both are `let` / `const` in the same scope and
// cross-reference each other inside callbacks. Callbacks fire after the
// module has finished evaluating, so both bindings are initialized by
// the time any of them runs.
let localMultiplayerSetup = null;

const customBattleSetupForLocalMP = new CustomBattleSetup(menuElement, {
  onStart: (blueRoster, redRoster, playerTeamId) => {
    localMultiplayerSetup.setCustomRosters(blueRoster, redRoster, playerTeamId);
  },
  // Same reasoning as the SP Custom Battle setup's onReset above:
  // persist the post-reset payload so the role survives a reopen.
  onReset: (blueRoster, redRoster, playerTeamId, aiTierByTeamId) => {
    ActiveCustomBattle.setLastSetup(
      blueRoster, redRoster, playerTeamId, aiTierByTeamId
    );
  },
  onBack: () => localMultiplayerSetup.show(),
  unitInfoPanel
});

localMultiplayerSetup = new LocalMultiplayerSetup(menuElement, {
  onStart: (config) => startLocalMultiplayerBattle(config),
  onBack: () => mpLobby.open(),
  onOpenCustomBattle: () => customBattleSetupForLocalMP.show(ActiveCustomBattle.getLastSetup())
});

const pauseMenu = new PauseMenuPanel({
  onExitToMainMenu: () => returnToMainMenu(),
  onClose: () => {
    isPaused = _pausedBeforePauseMenu;
    pauseIndicator.classList.toggle('hidden', !isPaused);
  },
  settingsPanel
});

// Register the pause menu as a second element the version badge follows.
// Effect: the version label also appears during a battle while the
// in-game menu is open, and hides again when the menu is dismissed.
versionBadge.watch(pauseMenu.el);

menuButton.addEventListener('click', () => {
  _pausedBeforePauseMenu = isPaused;
  isPaused = true;
  pauseIndicator.classList.toggle('hidden', !isPaused);
  pauseMenu.open();
});

// Instant coin-toss toggle. Mounted into the top bar next to the Menu
// button but kept HIDDEN by default: it is only relevant to a turn-based
// same-device battle, and showing it in single-player or networked MP
// would just be clutter that does not do anything. startScenario reveals
// it for turn-based local MP and hides it again when the battle resolves.
//
// Writes through SettingsStore so the value survives a reload and so a
// future Settings-panel entry for it, if one is ever added, stays in
// sync automatically.
let instantCoinToggleEl = null;

(function mountInstantCoinToggle() {
  const topBar = document.getElementById('topBar');
  const menuBtn = document.getElementById('menuButton');
  if (!topBar || !menuBtn || !menuBtn.parentNode) return;

  const label = document.createElement('label');
  label.title = 'Skip the coin-toss animation — the result resolves instantly.';
  label.style.cssText = [
    'display:none', 'align-items:center', 'gap:5px',
    'padding:4px 8px', 'margin-left:6px',
    'background:rgba(20,30,45,0.6)',
    'border:1px solid #3a4a5e', 'border-radius:4px',
    'color:#cdd6e2', 'font-family:monospace', 'font-size:11px',
    'letter-spacing:0.6px', 'cursor:pointer', 'user-select:none',
    'pointer-events:auto'
  ].join(';');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!SettingsStore.get().instantCoinToss;
  cb.style.cssText = 'cursor:pointer;margin:0;';
  cb.addEventListener('change', () => {
    SettingsStore.set('instantCoinToss', cb.checked);
  });
  label.appendChild(cb);

  const txt = document.createElement('span');
  txt.textContent = 'Fast coin';
  label.appendChild(txt);

  // Keep in sync if the value is ever flipped outside this checkbox.
  SettingsStore.subscribe(() => {
    cb.checked = !!SettingsStore.get().instantCoinToss;
  });

  menuBtn.parentNode.insertBefore(label, menuBtn.nextSibling);
  instantCoinToggleEl = label;
})();

// Turn-coin indicator. A small P1 / P2 coin face below the Restart
// button showing whose turn it is right now. Set visible and re-tinted
// every frame by the render loop from the local controller's state —
// which means it always agrees with the army bar (they read the same
// activeTeamId), and it naturally hides during interval and coin-toss
// phases where there is no active team.
//
// Position is derived from the Restart button's rect on every visible
// frame, so a top-bar layout change (a wrapped button, a browser
// sidebar) does not leave the coin stranded.
let turnCoinIndicatorEl = null;

(function mountTurnCoinIndicator() {
  const el = document.createElement('div');
  el.title = 'Whose turn it is';
  el.style.cssText = [
    'position:fixed',
    'left:0', 'top:0',
    'z-index:20',
    'width:40px', 'height:40px', 'border-radius:50%',
    'display:none', 'align-items:center', 'justify-content:center',
    'border:2px solid #d0b878',
    'box-shadow:0 4px 12px rgba(0,0,0,0.55), inset 0 0 10px rgba(0,0,0,0.4)',
    'color:#f0e8d0', 'font-weight:700',
    'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
    'font-size:13px', 'letter-spacing:2px',
    'text-shadow:0 1px 2px rgba(0,0,0,0.7)',
    'pointer-events:none', 'user-select:none'
  ].join(';');
  document.body.appendChild(el);
  turnCoinIndicatorEl = el;
})();

restartButton.addEventListener('click', () => {
  // Mark this reload as an intentional Restart so startScenario knows not
  // to reset per-battle toggles the player already set. Consumed (and
  // cleared) on the next boot; see bootIsRestart above.
  try { sessionStorage.setItem('sa.restartIntent', '1'); } catch (e) { /* ignore */ }
  window.location.reload();
});

// "?" help button in the top bar. Opens the standalone HelpPanel — the
// control hints used to be appended to the debug HUD text block, which
// meant they were only reachable while a debug target was active. The
// panel owns its own DOM and is closed by its own button, a backdrop
// click, or Escape (see the capture-phase Escape handler below).
if (helpButton) helpButton.addEventListener('click', () => helpPanel.open());

hudToggle.style.display = 'none';

hudToggle.addEventListener('click', () => {
  hudElement.classList.toggle('hidden');
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    // Turn-based local MP owns the pause state via its turn machine;
    // a Space-driven toggle would fight it and the PAUSED indicator
    // would misreport why the sim stopped. Space is a no-op here.
    if (localTurnBasedActive) return;
    if (currentMPPause) {
      currentMPPause.requestToggle();
      // Indicator visibility is reconciled by the render loop each frame
      // against currentMPPause.isPaused() — no direct toggle here.
    } else {
      isPaused = !isPaused;
      pauseIndicator.classList.toggle('hidden', !isPaused);
    }
  }
});

// Escape opens the in-game menu; a second Escape closes it. Registered in
// the capture phase on document so this runs BEFORE any bubble-phase
// Escape handler a panel installs for itself (UnitInfoPanel does, so
// closing it does not also pop the pause menu).
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;

  // Unit info panel owns Escape while it is open; skip so its own close
  // handler (registered on document during open()) does its job.
  if (unitInfoPanel.isOpen()) return;

  // Settings panel has no Escape handler of its own — close it here.
  if (settingsPanel.isOpen) { settingsPanel.close(); return; }

  // Help panel has no Escape handler of its own — close it here. Runs
  // BEFORE the battleActive gate below so Escape also closes the help
  // panel on the main menu, where battleActive is false.
  if (helpPanel.isOpen) { helpPanel.close(); return; }

  // Nothing to pause outside a battle. Also prevents the menu opening on
  // the main menu, where it would just be an empty overlay over the mode
  // cards.
  if (!battleActive) return;

  // Pause menu already open: Escape closes it. Its onClose restores the
  // pause state that was captured when it opened.
  if (pauseMenu.isOpen) { pauseMenu.close(); return; }

  _pausedBeforePauseMenu = isPaused;
  isPaused = true;
  pauseIndicator.classList.toggle('hidden', !isPaused);
  pauseMenu.open();
}, true);

// --- Scenario launcher ----------------------------------------------------

function launchCampaignBattle(state) {
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
//
// mpOptions, when present, switches startScenario into multiplayer mode:
//   { role: 'host' | 'guest', session: NetSession,
//     playerTeamId: 'blue' | 'red',
//     otherTeamId: 'blue' | 'red',
//     deploymentSeconds: number }
//
// Behaviour differences from single-player:
//   - BattleAI is NOT constructed (both teams are human-driven).
//   - The guest sets simulation.tickEnabled = false so its systems never
//     run; snapshots overwrite every mutable field each tick.
//   - The host broadcasts a snapshot after each successful tick.
//   - Player orders issued on the guest are forwarded to the host via
//     GuestController.sendOrder() instead of being applied locally.
//   - A MPDeploymentPhase replaces the SP DeploymentPhase when
//     deploymentSeconds > 0. Both teams start auto-deployed in a standard
//     line; the player can then rearrange their own team inside their own
//     zone, hidden from the opponent, until both sides Ready or the timer
//     expires.
function startScenario(scenario, onBattleEnded, mpOptions) {
  // A previous battle may have left the timing buffer populated if the
  // diag was toggled off mid-session. Clear it here so a fresh battle
  // (diag off) cannot keep pushing into a stale object.
  _diagLoopTimings = null;
  const mp = mpOptions || null;
  const isGuest = !!(mp && mp.role === 'guest');
  const isHost  = !!(mp && mp.role === 'host');
  const isLocal = !!(mp && mp.role === 'local');

  // Reset the SP pause flag. The Multiplayer button on the main menu
  // sets isPaused = true while the lobby is open, and none of the paths
  // from there into a battle reset it — so a same-device battle started
  // already paused and never ticked. Doing the reset here, at the single
  // entry point every battle launcher funnels through, means no future
  // launcher can forget it. Also clears the previous battle's turn-
  // based flag defensively.
  isPaused = false;
  localTurnBasedActive = false;
  if (currentLocalController) { currentLocalController.dispose(); currentLocalController = null; }
  battleActive = true;

  // The Fast-coin toggle is a turn-based local-MP control. Show it for
  // that mode only; every other battle leaves it hidden.
  const turnBasedLocal = isLocal && !!mp && mp.localMode === 'turnBased';
  if (instantCoinToggleEl) {
    instantCoinToggleEl.style.display = turnBasedLocal ? 'inline-flex' : 'none';
  }

  // Fast coin resets to off at the start of every FRESH turn-based battle
  // — a new game should not inherit the "skip the animation" preference
  // from a previous run. A Restart-button reload is the exception: the
  // player is resuming the same battle, and resetting their toggle would
  // be hostile.
  //
  // The bootIsRestart flag is read ONCE (and consumed), so a second
  // battle launched from the menu within the same session is treated as
  // fresh again. This also means the ordering inside startScenario
  // matters: consume the flag on EVERY call, not only when we happen to
  // act on it, or a single restart would suppress the reset for the rest
  // of the session.
  const isRestartLaunch = bootIsRestart;
  bootIsRestart = false;
  if (turnBasedLocal && !isRestartLaunch) {
    SettingsStore.set('instantCoinToss', false);
  }

  // Clear any leftover MP pause controller from a previous battle.
  if (currentMPPause) { currentMPPause.dispose(); currentMPPause = null; }

  battleResultView.hide();
  unitInfoPanel.close();

  // In MP (networked or same-device) the scenario object must be treated
  // as local-only: we are about to change its playerTeamId and aiTeamIds,
  // and the scenario instances in PlayableScenarios are shared module-
  // level objects. Clone before edit.
  if (mp) {
    scenario = Object.assign({}, scenario, {
      playerTeamId: mp.playerTeamId || scenario.playerTeamId,
      aiTeamIds: []
    });
  }

  const units = scenario.build();

  const sceneSetup = new SceneSetup(canvas, {
    cameraTarget: scenario.cameraTarget || { x: 0, z: 0 },
    cameraYaw: scenario.cameraYaw ?? Math.PI,
    cameraDistance: scenario.cameraDistance ?? 34,
    cameraPitch: scenario.cameraPitch ?? 0.95,
    settings: SettingsStore.get()
  });

  SettingsStore.subscribe(() => {
    sceneSetup.applySettings(SettingsStore.get());
  });

  const battleRenderer = new BattleRenderer(sceneSetup);

  // === FRAME DIAGNOSTIC ================================================
  // Off by default. The block below wraps the renderer's per-frame sync
  // and render calls, keeps a rolling window of timings, and prints a
  // summary every 60 frames. It also installs `window.__diag` for the
  // draw-call census. Left in place but gated by this flag: flip it to
  // true while profiling and every console line, wrapper, and window
  // global appears; leave it false and ordinary play is completely
  // silent. Nothing outside the block reads either the wrappers or the
  // window global, so gating the IIFE on the flag is sufficient.
  const RENDER_DIAG_ENABLED = false;
  if (RENDER_DIAG_ENABLED) (() => {
    if (window.__diag && typeof window.__diag.off === 'function') {
      try { window.__diag.off(); } catch (e) { /* previous renderer gone */ }
    }

    const syncOrig = battleRenderer.syncWithSimulation.bind(battleRenderer);
    const renderOrig = battleRenderer.render.bind(battleRenderer);

    const WINDOW = 120;    // samples kept (~4 s at 30 fps)
    const LOG_EVERY = 60;  // frames between log lines

    const frameStarts = [];
    const syncTimes = [];
    const renderTimes = [];
    let lastStartMs = 0;
    let frameCount = 0;
    _diagLoopTimings = { pre: [], tick: [], post: [] };
    // Incremented whenever SceneSetup actually refreshes the shadow map
    // this frame. Reset to 0 at every log, so the reported rate covers
    // exactly the window between two log lines.
    let shadowUpdateCount = 0;

    const push = (arr, v) => {
      arr.push(v);
      if (arr.length > WINDOW) arr.shift();
    };
    const avg = (arr) => arr.length
      ? arr.reduce((a, b) => a + b, 0) / arr.length
      : 0;
    const p95 = (arr) => {
      if (!arr.length) return 0;
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    };

    battleRenderer.syncWithSimulation = function (...args) {
      const t = performance.now();
      const r = syncOrig(...args);
      push(syncTimes, performance.now() - t);
      return r;
    };

    battleRenderer.render = function (...args) {
      const tStart = performance.now();
      if (lastStartMs > 0) push(frameStarts, tStart - lastStartMs);
      lastStartMs = tStart;

      const shadowBefore = sceneSetup._lastShadowUpdateMs;
      const r = renderOrig(...args);
      if (sceneSetup._lastShadowUpdateMs !== shadowBefore) shadowUpdateCount++;
      push(renderTimes, performance.now() - tStart);

      frameCount++;
      if (frameCount % LOG_EVERY === 0) {
        const info = sceneSetup.renderer.info;

        // One-off scene census on the first log line. Cheap enough not to
        // run every log, but the total mesh/sprite count is the single
        // most useful number for the "is this a draw-call problem"
        // question.
        let meshCount = -1;
        let spriteCount = -1;
        if (frameCount === LOG_EVERY) {
          meshCount = 0;
          spriteCount = 0;
          sceneSetup.scene.traverse((o) => {
            if (o.isMesh) meshCount++;
            else if (o.isSprite) spriteCount++;
          });
        }

        const avgFrame = avg(frameStarts);
        const avgSync = avg(syncTimes);
        const avgRender = avg(renderTimes);
        const other = avgFrame - avgSync - avgRender;

        // Partition of `other` from the loop-section timings. Loop work =
        // pre + tick + post; post = prep + sync + UI + render, so the
        // pre/sync/render portions of post are subtracted to isolate the
        // prep+UI slice. raf = whatever remains of the frame after loop
        // work finishes — the browser's wait for the next rAF slot.
        const lt = _diagLoopTimings;
        const avgPre  = lt && lt.pre.length  ? avg(lt.pre)  : 0;
        const avgTick = lt && lt.tick.length ? avg(lt.tick) : 0;
        const avgPost = lt && lt.post.length ? avg(lt.post) : 0;
        const avgUi   = Math.max(0, avgPost - avgSync - avgRender);
        const loopMs  = avgPre + avgTick + avgPost;
        const rafMs   = Math.max(0, avgFrame - loopMs);
        const fps = avgFrame > 0 ? 1000 / avgFrame : 0;
        const soldierCount = simulation && simulation.getAllSoldiers
          ? simulation.getAllSoldiers().length
          : -1;

        // Unique materials currently attached to anything in the scene.
        // The single clearest signal that the tint cache is working:
        // before it, every soldier owned a body and shield material of
        // its own (hundreds in a big battle). After it, matching tints
        // share one instance, so this should land in the tens.
        const uniqueMats = (() => {
          const s = new Set();
          sceneSetup.scene.traverse((o) => {
            if (!(o.isMesh || o.isSprite || o.isPoints || o.isLine)) return;
            const m = o.material;
            if (!m) return;
            if (Array.isArray(m)) for (const mm of m) s.add(mm);
            else s.add(m);
          });
          return s.size;
        })();

        // LOD tier histogram. A healthy battle should show most soldiers
        // in tier 2-3; if everything is tier 1, LOD is not doing its job
        // and that alone explains a low FPS.
        const tierHisto = [0, 0, 0, 0, 0];
        if (battleRenderer.views) {
          for (const view of battleRenderer.views.values()) {
            const t = view._tier;
            if (t >= 1 && t <= 4) tierHisto[t]++;
          }
        }

        // Shadow-refresh rate over the window. With the adaptive interval
        // in place this holds near 30 Hz when frames are fast and backs
        // off toward 10 Hz as frame time climbs — the opposite of the old
        // behaviour, where slow frames refreshed shadows MORE often
        // relative to the work being done.
        const windowSeconds = (LOG_EVERY * avgFrame) / 1000;
        const shadowHz = windowSeconds > 0
          ? shadowUpdateCount / windowSeconds
          : 0;
        shadowUpdateCount = 0;

        console.log('%c[instancing]', 'color:#8c8', battleRenderer.getInstancingStats());
        if (simulation && simulation.tickProfile) {
          console.log('%c[tick-diag]', 'color:#c8a', simulation.tickProfile.drainReport());
        }

        const census = meshCount >= 0
          ? ` | census mesh=${meshCount} sprite=${spriteCount}`
          : '';

        console.log(
          `%c[diag] fps=${fps.toFixed(1)} ` +
          `frame=${avgFrame.toFixed(1)}ms (p95 ${p95(frameStarts).toFixed(1)})`,
          'color:#8ac;font-weight:bold',
          `| sync=${avgSync.toFixed(1)}ms ` +
          `render=${avgRender.toFixed(1)}ms ` +
          `other=${other.toFixed(1)}ms ` +
          `| pre=${avgPre.toFixed(1)} tick=${avgTick.toFixed(1)} ` +
          `ui=${avgUi.toFixed(1)} raf=${rafMs.toFixed(1)} ` +
          `| calls=${info.render.calls} tris=${info.render.triangles} ` +
          `| geoms=${info.memory.geometries} tex=${info.memory.textures} ` +
          `progs=${info.programs ? info.programs.length : '?'} ` +
          `| mats=${uniqueMats} ` +
          `shadowHz=${shadowHz.toFixed(1)} ` +
          `tiers=${tierHisto[1]}/${tierHisto[2]}/${tierHisto[3]}/${tierHisto[4]} ` +
          `| soldiers=${soldierCount}${census}`
        );
      }

      return r;
    };

    // === Draw-call census ===
    // Wraps three.js's lowest-level per-draw entry point so we count
    // every draw call the renderer issues — main pass and shadow pass
    // alike — keyed by the geometry being drawn. Every builder's
    // geometry is cached and shared, so one entry per shape aggregates
    // every mesh using that shape across the whole battle. The vertex
    // count and bounding-box dimensions of each entry identify which
    // shape it is unambiguously.
    //
    // Usage: run the battle for a few seconds, then from the console:
    //     window.__diag.dumpCensus()
    // Prints a table sorted by descending call count. The top row is
    // the shape eating the most draw calls.
    const _drawCounts = new Map();
    // three.js's WebGLRenderer assigns renderBufferDirect as an INSTANCE
    // property inside its constructor (this.renderBufferDirect = ...), not
    // as a prototype method. Patching the prototype therefore has no
    // effect on the actual call target — the instance's own property
    // shadows it. Patch the instance directly. There is exactly one
    // renderer instance for the page lifetime, so this is stable.
    const _renderer = sceneSetup.renderer;
    const _origRenderBufferDirect = _renderer.renderBufferDirect;
    _renderer.renderBufferDirect = function (
      camera, scene, geometry, material, object, group
    ) {
      _drawCounts.set(geometry.uuid, (_drawCounts.get(geometry.uuid) || 0) + 1);
      return _origRenderBufferDirect.call(
        this, camera, scene, geometry, material, object, group);
    };

    function _dumpDrawCensus() {
      // Metadata for every geometry currently in the scene: vertex
      // count and bounding-box size. Cross-referenced against the
      // draw counters below to produce human-readable rows.
      const meta = new Map();
      sceneSetup.scene.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry;
        if (!g || meta.has(g.uuid)) return;
        const pos = g.attributes.position;
        const verts = pos ? pos.count : 0;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        const size = bb
          ? `${(bb.max.x - bb.min.x).toFixed(2)}x` +
            `${(bb.max.y - bb.min.y).toFixed(2)}x` +
            `${(bb.max.z - bb.min.z).toFixed(2)}`
          : '?';
        meta.set(g.uuid, { verts, size });
      });

      const rows = [];
      let total = 0;
      for (const [uuid, count] of _drawCounts) {
        const m = meta.get(uuid);
        rows.push({
          geom: uuid.slice(0, 8),
          calls: count,
          verts: m ? m.verts : '?',
          bbox: m ? m.size : '?'
        });
        total += count;
      }
      rows.sort((a, b) => b.calls - a.calls);

      console.log(
        `[draw-census] ${rows.length} unique geometries, ` +
        `${total} total draw calls in the sampled window`);
      console.table(rows.slice(0, 30));
      _drawCounts.clear();
    }

    window.__diag = {
      off() {
        battleRenderer.syncWithSimulation = syncOrig;
        battleRenderer.render = renderOrig;
        _renderer.renderBufferDirect = _origRenderBufferDirect;
        _diagLoopTimings = null;
        console.log('[diag] disabled');
      },
      dumpCensus: _dumpDrawCensus,
      bisect: () => new RenderBisect(sceneSetup, battleRenderer).run(),
      frameStarts,
      syncTimes,
      renderTimes
    };

    console.log(
      '%c[diag] frame profiler attached — logs every 60 frames. ' +
      'window.__diag.off() to detach.',
      'color:#8ac'
    );
  })();
  // === END FRAME DIAGNOSTIC ============================================

  AIDebugLog.onCorridorEvent = (evt) => battleRenderer.pushCorridorEvent(evt);
  const orderPreviewView = new OrderPreviewView(sceneSetup.scene);
  const selectionBoxView = new SelectionBoxView(document.body);
  const hudView = new HudView(hudElement);

  const simulation = new BattleSimulation(units, {
    playerTeamId: scenario.playerTeamId
  });

  if (isGuest) simulation.tickEnabled = false;
  if (RENDER_DIAG_ENABLED) simulation.tickProfile = new TickProfiler();

  // AI is constructed only in single-player. In MP (networked or local)
  // both teams are human-driven.
  if (!mp) {
    simulation.battleAI = new BattleAI(simulation.units, scenario.aiTeamIds, {
      valiantDefenceTeamIds: scenario.valiantDefenceTeamIds,
      // Per-team difficulty for Custom Battle; null/undefined for every
      // other scenario shape, in which case BattleAI falls back to the
      // global AITierPreference.
      tierNameByTeamId: scenario.aiTierByTeamId || null
    });
  }

  // --- Same-device controller ---
  // Owns the turn-based state machine (or, in free-pause mode, returns a
  // fixed "both active" state). Constructed before deployment so its
  // beginBattle() hook can be wired into the deployment panel's onStart.
  //
  // Declared with `let` because selectionController is constructed below;
  // onStateChange guards against the (impossible in practice) case of a
  // state change firing before that.
  let localController = null;
  let selectionController = null;
  if (isLocal) {
    localController = new LocalMultiplayerController({
      mode: mp.localMode,
      intervalSeconds: mp.localIntervalSeconds,
      onStateChange: () => {
        if (selectionController) {
          selectionController.controllableTeamIds =
            new Set(localController.getControllableTeamIds());
          selectionController.clearSelection();
        }
      },
      // Turn-based deploy: the controller's End Deploy button drives the
      // deployment phase's own end. Lazy reference so the controller can
      // be constructed before deploymentPhase is assigned below.
      onDeployComplete: () => {
        if (deploymentPhase) deploymentPhase.startBattle();
      }
    });
    // Space handler reads these. localTurnBasedActive gates out the
    // pause toggle; currentLocalController is the disposable handle
    // battleFlow.onResolved uses to tear down the HUD.
    currentLocalController = localController;
    if (mp.localMode === 'turnBased') localTurnBasedActive = true;
  }

  // --- Deployment phase ---
  // SP: standard DeploymentPhase (player drags their team, clicks Start Battle).
  // Local MP: standard DeploymentPhase with BOTH teams marked as player
  //           teams — both players can reposition simultaneously, both
  //           zones are drawn.
  // Networked MP: MPDeploymentPhase (hidden simultaneous placement).
  const deploymentZoneView = new DeploymentZoneView(sceneSetup.scene);

  let deploymentPhase = null;      // SP + local MP — passed to OrderDragController
  let mpDeploymentPhase = null;    // Networked MP only

  // Turn-based local MP handles deployment in two gated sub-phases, each
  // driven by the local controller's own HUD (a per-player End Deploy
  // button). It must NOT create the default DeploymentPanel — that panel
  // would show a single Start Battle button and imply both players go at
  // once. Free-pause local MP and SP still use the panel.
  const localTurnBased = isLocal && mp.localMode === 'turnBased';

  if (!mp || isLocal) {
    const playerTeams = isLocal ? ['blue', 'red'] : [scenario.playerTeamId];

    if (!localTurnBased) {
      // Free-pause local MP shows the red army bar along the top of the
      // screen; push the deployment panel below it so the Start Battle
      // button and its hint are not overlapped. Single-player and
      // networked MP keep the default 16px offset.
      const panelTop = isLocal ? '100px' : undefined;
      // eslint-disable-next-line no-new
      new DeploymentPanel(document.body, {
        top: panelTop,
        hint: isLocal
          ? 'Both players may reposition units inside their zones, then start the battle.'
          : undefined,
        onStart: () => { if (deploymentPhase) deploymentPhase.startBattle(); }
      });
    }

    deploymentPhase = new DeploymentPhase(simulation, {
      playerTeamIds: playerTeams,
      onBattleStart: () => {
        deploymentZoneView.hideAll();
        if (localController) localController.beginBattle();
      }
    });
    simulation.deploymentPhase = deploymentPhase;

    for (const teamId of playerTeams) {
      const zone = deploymentPhase.getZone(teamId);
      if (zone) {
        deploymentZoneView.show(
          teamId,
          zone,
          DeploymentConfig.playerZoneColor,
          DeploymentConfig.zoneFillOpacity,
          DeploymentConfig.zoneOutlineOpacity
        );
      }
    }
  } else {
    // Networked MP deployment (both peers hidden-rearrange). Unchanged
    // from the pre-local-MP implementation.
    const planner = new DeploymentPlanner();
    planner.register(StandardDeployment);

    const myUnits = simulation.units.filter(u => u.teamId === mp.playerTeamId);
    const peerUnits = simulation.units.filter(u => u.teamId === mp.otherTeamId);

    const myPlan = planner.plan(myUnits, peerUnits);
    const peerPlan = planner.plan(peerUnits, myUnits);

    for (const p of myPlan.placements) p.unit.issueInstantMoveOrder(p.x, p.z, p.facing);
    for (const p of peerPlan.placements) p.unit.issueInstantMoveOrder(p.x, p.z, p.facing);

    if (mp.deploymentSeconds > 0) {
      mpDeploymentPhase = new MPDeploymentPhase(simulation, {
        myTeamId: mp.playerTeamId,
        otherTeamId: mp.otherTeamId,
        session: mp.session,
        seconds: mp.deploymentSeconds,
        myZone: myPlan.zone,
        otherZone: peerPlan.zone,
        onComplete: () => {
          deploymentZoneView.hideAll();
          if (mpHost) mpHost.start();
        }
      });
      simulation.deploymentPhase = mpDeploymentPhase;

      if (myPlan.zone) {
        deploymentZoneView.show(
          mp.playerTeamId,
          myPlan.zone,
          DeploymentConfig.playerZoneColor,
          DeploymentConfig.zoneFillOpacity,
          DeploymentConfig.zoneOutlineOpacity
        );
      }
      if (peerPlan.zone) {
        deploymentZoneView.show(
          mp.otherTeamId,
          peerPlan.zone,
          DeploymentConfig.enemyZoneColor,
          DeploymentConfig.zoneFillOpacity,
          DeploymentConfig.zoneOutlineOpacity
        );
      }
    }
  }

  const powerBalanceView = new PowerBalanceView();

  const cameraController = new CameraController(canvas, sceneSetup);

  // Controllable teams: SP and networked MP only allow the local player's
  // team. Local MP allows both, with the controller dynamically gating.
  const initialControllableTeams = isLocal
    ? ['blue', 'red']
    : [scenario.playerTeamId];

  selectionController = new SelectionController(
    canvas,
    sceneSetup,
    simulation.units,
    battleRenderer,
    selectionBoxView,
    initialControllableTeams
  );

  if (localController) {
    selectionController.controllableTeamIds =
      new Set(localController.getControllableTeamIds());
  }

  const orderDragController = new OrderDragController(
    canvas,
    sceneSetup,
    selectionController,
    orderPreviewView,
    deploymentPhase || mpDeploymentPhase
  );

  // --- Multiplayer controllers (networked) ---
  let mpHost = null;
  let mpGuest = null;

  if (isHost) {
    mpHost = new HostController(mp.session, simulation, {
      guestTeamId: mp.otherTeamId
    });
    if (!mpDeploymentPhase) mpHost.start();
  } else if (isGuest) {
    mpGuest = new GuestController(mp.session, simulation, {
      playerTeamId: mp.playerTeamId
    });
    mpGuest.announce();
  }

  // MP pause controller. Constructed after mpHost / mpGuest so it can
  // hook into the same session. Stored on the module-level currentMPPause.
  let mpPause = null;
  if (mp && mp.pauseMode) {
    mpPause = new MPPauseController({
      mode: mp.pauseMode,
      session: mp.session,
      isHost,
      myTeamId: mp.playerTeamId,
      otherTeamId: mp.otherTeamId
    });
    currentMPPause = mpPause;
  }

  // Unified peer-left handler (networked only).
  if (mp && (isHost || isGuest)) {
    const handlePeerLeft = () => {
      if (mpPause) {
        mpPause.dispose();
        if (currentMPPause === mpPause) currentMPPause = null;
        mpPause = null;
      }
      if (mpHost) mpHost.stop();
      if (mpDeploymentPhase) mpDeploymentPhase.abort();
      isPaused = true;
      battleResultView.show('peer-left', { onReturn: returnToMainMenu });
    };
    mp.session.on('peerLeft', handlePeerLeft);
  }

  // MP host/guest badge (networked only).
  let mpBadge = null;
  if (mp && (isHost || isGuest)) {
    mpBadge = document.createElement('div');
    const roleWord = isHost ? 'HOST' : 'GUEST';
    const roleColor = isHost ? '#8fd08f' : '#d0a08f';
    const teamLabel = mp.playerTeamId === 'blue' ? 'Blue' : 'Red';
    mpBadge.style.cssText = [
      'position:fixed', 'top:8px', 'left:8px',
      'z-index:14',
      'padding:4px 10px',
      'background:rgba(20,30,45,0.78)',
      'border:1px solid #3a4a5e', 'border-radius:4px',
      'font-family:monospace', 'font-size:11px',
      'letter-spacing:1px',
      'color:#eef2f8', 'pointer-events:none', 'user-select:none'
    ].join(';');
    mpBadge.innerHTML =
      `You: <b style="color:${roleColor}">${roleWord}</b> · ${teamLabel}`;
    document.body.appendChild(mpBadge);
  }

  // Guest order forwarding (networked only). Unchanged.
  if (isGuest) {
    orderDragController._issueGroupOrder = function (unitsArg, x, z, facing, width, directMarch = false) {
      const explicitFacing = facing !== undefined && facing !== null;
      const ids = unitsArg.map(u => u.id);
      const opts = (directMarch || explicitFacing)
        ? { directMarch: !!directMarch, forceFacing: explicitFacing }
        : undefined;

      if (width) {
        mpGuest.sendOrder('formation', ids, { x, z, facing, width, opts });
      } else {
        mpGuest.sendOrder('move', ids, { x, z, facing, opts });
      }
      return true;
    };

    orderDragController._issueAttackOrder = function (unitsArg, target) {
      mpGuest.sendOrder('attack', unitsArg.map(u => u.id), { targetUnitId: target.id });
      const c = target.getCenter();
      orderPreviewView.flashAttackTarget(c.x, c.z);
    };
  }

  // Debug-inspect wiring.
  selectionController.onDebugSelectionChanged = (unit) => {
    // The first time a debug target is set in this battle, enable
    // battle-wide history logging. This flips two independent flags:
    //   - simulation.debugHistoryEnabled: MoraleSystem attaches a per-
    //     tick morale breakdown to every soldier.
    //   - hudView.enableHistory(): the HUD's registry starts tracking
    //     every unit's field diffs and per-soldier events.
    // Both are idempotent and both STAY ON for the rest of the battle,
    // regardless of whether the debug target is later cleared. This is
    // intentional — the history log is a record of the battle, not of
    // the debug session.
    if (unit) {
      simulation.debugHistoryEnabled = true;
      hudView.enableHistory();
    }
    hudToggle.style.display = unit ? '' : 'none';
    if (!unit) hudElement.classList.add('hidden');
    fpsCounter.setDebugOverride(!!unit);
    const intentInfo = findIntentInfo(simulation.battleAI, unit);
    hudView.setDebugInfo(unit ? { unit, intentInfo } : null);
    battleRenderer.setDebugPathUnit(unit);
    battleRenderer.setDebugCorridorUnit(unit);
    battleRenderer.setDebugModeOn(
      !!unit,
      () => selectionController.selectedUnits
    );
  };

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
  armyBarView.onUnitInfo = (unit, cardEl) => unitInfoPanel.open(unit, cardEl);

  // Local MP: a second army bar for the OTHER team, anchored to the top
  // of the screen. Blue stays on the existing bottom bar (armyBarElement),
  // red gets a new fixed top bar. Created dynamically because it has no
  // purpose outside local MP.
  let armyBarRedView = null;
  let armyBarRedElement = null;
  if (isLocal) {
    // Red army bar layout is driven entirely from a scoped <style> block
    // with !important on the load-bearing properties. #armyBar's own
    // layout comes from style.css, and an id-scoped rule there was
    // beating inline cssText (cards stacked vertically, container grew
    // to fill the screen, read as a black overlay). !important beats any
    // id-scoped stylesheet rule regardless of source order.
    //
    // max-height + overflow-y:hidden is a hard backstop: even if a future
    // .army-card rule forces wrapping, the bar can never grow tall enough
    // to cover the battlefield.
    //
    // Position depends on mode:
    //   free-pause  — top of screen. Both army bars visible at once, red
    //                 on top, blue (from #armyBar) on the bottom.
    //   turn-based  — bottom of screen, same slot as the blue bar. Only
    //                 one bar is ever visible at a time, so they can
    //                 share the position.
    // Background is transparent in both modes: the red bar is chrome over
    // the canvas, not a dimming layer.
    const redTop = localTurnBased ? 'auto' : '0';
    const redBottom = localTurnBased ? '0' : 'auto';
    // No border at all. The earlier bottom border in free-pause read as a
    // stray line across the top of the screen even after the black
    // background was removed. The bar is pure chrome over the canvas.
    const redBorder = 'border: none !important;';

    if (!document.getElementById('armyBarRedStyles')) {
      const st = document.createElement('style');
      st.id = 'armyBarRedStyles';
      st.textContent = [
        '#armyBarRed {',
        '  position: fixed !important;',
        '  top: ' + redTop + ' !important;',
        '  bottom: ' + redBottom + ' !important;',
        '  left: 0 !important;',
        '  right: 0 !important;',
        '  height: auto !important;',
        '  max-height: 25vh !important;',
        '  z-index: 15 !important;',
        '  display: flex !important;',
        '  flex-direction: row !important;',
        '  flex-wrap: nowrap !important;',
        '  align-items: flex-end !important;',
        '  justify-content: center !important;',
        '  gap: 6px !important;',
        '  padding: 6px 8px !important;',
        '  box-sizing: border-box !important;',
        '  overflow-x: auto !important;',
        '  overflow-y: hidden !important;',
        '  background: transparent !important;',
        '  ' + redBorder,
        '  box-shadow: none !important;',
        '  pointer-events: auto !important;',
        '}',
        '#armyBarRed > .army-card {',
        '  flex: 0 0 auto !important;',
        '}'
      ].join('\n');
      document.head.appendChild(st);
    }

    armyBarRedElement = document.createElement('div');
    armyBarRedElement.id = 'armyBarRed';
    document.body.appendChild(armyBarRedElement);

    armyBarRedView = new ArmyBarView(
      armyBarRedElement,
      selectionController,
      'red',
      (unit) => {
        const c = unit.getCenter();
        sceneSetup.panCamera(
          c.x - sceneSetup.cameraTarget.x,
          c.z - sceneSetup.cameraTarget.z
        );
      }
    );
    armyBarRedView.onUnitInfo = (unit, cardEl) => unitInfoPanel.open(unit, cardEl);
  }

  const commandBarView = new CommandBarView(commandBarElement, armyBarElement);

  if (isGuest) {
    commandBarView.onSetFireAtWill = (newState) => {
      const rangedIds = [];
      for (const u of selectionController.selectedUnits) {
        const lead = u.soldiers && u.soldiers[0];
        if (lead && lead.unitTypeDef && isRanged(lead.unitTypeDef)) {
          rangedIds.push(u.id);
        }
      }
      if (rangedIds.length) mpGuest.sendOrder('fireAtWill', rangedIds, { value: newState });
    };
    commandBarView.onStop = () => {
      const ids = Array.from(selectionController.selectedUnits).map(u => u.id);
      if (ids.length) mpGuest.sendOrder('stop', ids, {});
    };
  } else {
    commandBarView.onSetFireAtWill = (newState) => {
      for (const u of selectionController.selectedUnits) {
        const lead = u.soldiers && u.soldiers[0];
        if (lead && lead.unitTypeDef && isRanged(lead.unitTypeDef)) {
          u.fireAtWill = newState;
        }
      }
    };
    commandBarView.onStop = () => {
      for (const u of selectionController.selectedUnits) u.stopOrder();
    };
  }

  const battleFlow = new BattleFlowController({
    simulation,
    playerTeamId: scenario.playerTeamId,
    onResolved: (outcome) => {
      if (mpHost) mpHost.stop();
      if (mpPause) { mpPause.dispose(); if (currentMPPause === mpPause) currentMPPause = null; }
      if (mpBadge && mpBadge.parentNode) mpBadge.parentNode.removeChild(mpBadge);
      if (localController) localController.dispose();
      if (currentLocalController === localController) currentLocalController = null;
      localTurnBasedActive = false;
      battleActive = false;
      if (instantCoinToggleEl) instantCoinToggleEl.style.display = 'none';
      if (turnCoinIndicatorEl) turnCoinIndicatorEl.style.display = 'none';
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

  // Pause-transition tracking, used to fire one-shot cleanups on the
  // frame the effective pause state flips false -> true. Currently used
  // to clear lingering commit flashes, whose fade timer does not advance
  // while paused (update() receives a zero visual delta in that state)
  // and would otherwise sit frozen on screen for the duration of the
  // pause.
  let lastEffectivePaused = false;

  function loop(now) {
    requestAnimationFrame(loop);

    const _tA = _diagLoopTimings ? performance.now() : 0;

    fpsCounter.update(now);

    const frameDelta = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    if (mpPause) mpPause.update(frameDelta);
    if (localController) localController.update(frameDelta);

    // Effective pause state: MP pause controller OR local turn controller
    // OR the SP Space-bar flag. In MP the controller owns it; in SP the
    // local isPaused flag does.
    let effectivePaused;
    if (mpPause) effectivePaused = mpPause.isPaused();
    else effectivePaused = isPaused;
    if (localController && localController.isPaused()) effectivePaused = true;

    const visualDelta = effectivePaused ? 0 : frameDelta;

    // SP "PAUSED" indicator is suppressed in turn-based local MP. The sim
    // is legitimately frozen during every coin toss and every player's
    // turn, but showing "PAUSED" during those phases reads as a stuck
    // game — especially with Space disabled. The local controller's own
    // HUD banner already names the phase.
    const showSPPause = effectivePaused && !localTurnBasedActive;
    pauseIndicator.classList.toggle('hidden', !showSPPause);

    // One-shot cleanup on the frame effective pause flips on. Currently
    // only the commit flashes: they freeze in place while paused (the
    // fade timer only advances on a non-zero visual delta) and read as
    // stuck UI rather than feedback, so they are removed rather than
    // allowed to linger. A flash issued WHILE paused is unaffected —
    // that one was just shown and its fade resumes on unpause.
    if (effectivePaused && !lastEffectivePaused) {
      orderPreviewView.clearFlashes();
    }
    lastEffectivePaused = effectivePaused;

    // Local MP: army bars appear / disappear with the turn cycle. Blue
    // bar is the existing bottom bar; red bar is the added top bar.
    if (localController) {
      const lst = localController.getState();
      armyBarElement.style.display = lst.showBlueBar ? '' : 'none';
      if (armyBarRedElement) {
        armyBarRedElement.style.display = lst.showRedBar ? '' : 'none';
      }

      // Turn-coin indicator below the Restart button. Shown only when a
      // player is actively taking their turn — activeTeamId is null
      // during interval, coin-toss, and post-battle phases, so the coin
      // disappears by itself at those moments.
      if (turnCoinIndicatorEl) {
        if (lst.activeTeamId) {
          const isBlue = lst.activeTeamId === 'blue';
          turnCoinIndicatorEl.textContent = isBlue ? 'P1' : 'P2';
          turnCoinIndicatorEl.style.background = isBlue
            ? 'radial-gradient(circle at 35% 30%, #4a80b8 0%, #1e3a52 100%)'
            : 'radial-gradient(circle at 35% 30%, #b84a4a 0%, #521e1e 100%)';
          turnCoinIndicatorEl.style.display = 'flex';

          // Recompute position each visible frame. getBoundingClientRect
          // on a single small element is cheap, and it keeps the coin
          // centred under the Restart button even if the top bar
          // reflows.
          const r = restartButton.getBoundingClientRect();
          turnCoinIndicatorEl.style.left = (r.left + r.width / 2 - 20) + 'px';
          turnCoinIndicatorEl.style.top = (r.bottom + 6) + 'px';
        } else {
          turnCoinIndicatorEl.style.display = 'none';
        }
      }
    }

    powerBalanceView.show();
    powerBalanceView.update(simulation.units);
    powerBalanceView.tick();

    cameraController.update(frameDelta);
    orderPreviewView.update(visualDelta);

    // Ctrl-held order-destination reveal. For every CONTROLLABLE unit
    // with a pending order (move or attack), draw the same formation
    // ghost markers the drag preview uses, at the unit's CURRENT order
    // destination and current formation width. Reads live state each
    // frame, so the reveal tracks a moving attack target and reflects a
    // fresh order the instant it is issued.
    //
    // Scope is every controllable unit, not just the selected ones —
    // the reveal is a battlefield-wide "what are my army's orders?"
    // overlay. Selected units are tinted blue, unselected pale cyan, so
    // the player can still read at a glance which orders belong to their
    // current selection. Non-controllable (enemy) units are skipped:
    // showing AI order destinations would leak intent.
    //
    // Skipped during a live drag: the drag preview is already showing
    // the pending formation at the drag's own destination, and painting
    // both reads as garbage.
    if (selectionController.ctrlKeyDown &&
        !orderDragController.isOrderDragging) {
      const markers = [];
      for (const u of simulation.units) {
        if (!selectionController.isControllable(u)) continue;
        const dest = u.getOrderDestination(simulation.unitsById);
        if (!dest) continue;
        const isSelected = selectionController.selectedUnits.has(u);
        const slots = u.previewFormationSlots(
          dest.x, dest.z, dest.facing, dest.width
        );
        for (const s of slots) {
          markers.push({
            x: s.x, z: s.z, facing: dest.facing, selected: isSelected
          });
        }
      }
      orderPreviewView.showOrderDestinations(markers);
    } else {
      orderPreviewView.hideOrderDestinations();
    }

    if (mpDeploymentPhase && mpDeploymentPhase.isActive()) {
      mpDeploymentPhase.update(frameDelta);
    }

    const _tB = _diagLoopTimings ? performance.now() : 0;

    let meleeEvents = [];
    let rangedEvents = [];
    if (!effectivePaused && now - lastTickTime >= tickIntervalMs) {
      lastTickTime = now;
      const ticked = battleFlow.step();
      if (ticked) {
        meleeEvents = simulation.combatResolutionSystem.drainEvents();
        rangedEvents = simulation.projectileSystem.drainEvents();

        // Arm the HUD's sim-tick notification. The registry consumes
        // this in the hudView.update() call below and runs its per-unit
        // diffs exactly once per tick — not once per render frame. The
        // arrays are shared read-only with the renderer; no consumer
        // mutates them.
        hudView.notifySimTick(meleeEvents, rangedEvents);

        if (mpHost) mpHost.afterTick();
      }
    }

    const _tC = _diagLoopTimings ? performance.now() : 0;

    let allSoldiers = simulation.getAllSoldiers();
    const hiddenTeam = (mpDeploymentPhase && mpDeploymentPhase.isActive())
      ? mpDeploymentPhase.getHiddenTeamId()
      : null;
    if (hiddenTeam) {
      allSoldiers = allSoldiers.filter(s => s.teamId !== hiddenTeam);
    }
    // allSoldiersById is built lazily below: only the debug HUD reads it.
    const projectiles = simulation.projectileSystem.getActiveProjectiles();

    battleRenderer.syncWithSimulation(
      allSoldiers,
      simulation.unitsById,
      meleeEvents,
      rangedEvents,
      projectiles,
      visualDelta
    );
    // The HUD is only meaningful while a debug target is selected. When
    // hudToggle is hidden (no debug target), skip the whole update — the
    // panel's per-unit registry diffs and text build are not free, and
    // nothing the player can see would change.
    if (hudToggle.style.display !== 'none') {
      const allSoldiersById = new Map(allSoldiers.map(s => [s.id, s]));
      hudView.update(simulation.units, allSoldiersById, selectionController.selectedUnits);
    }
    armyBarView.update(simulation.units);
    if (armyBarRedView) armyBarRedView.update(simulation.units);
    commandBarView.update(selectionController.selectedUnits);
    battleRenderer.render();

    const _tD = _diagLoopTimings ? performance.now() : 0;
    _recordLoopTimings(_tB - _tA, _tC - _tB, _tD - _tC);
  }

  requestAnimationFrame(loop);
}

// --- Same-device launcher -------------------------------------------------

// Called by LocalMultiplayerSetup when the player clicks Start Battle.
// Builds the scenario from either a PlayableScenarios entry or a
// previously configured custom roster, then hands off to startScenario
// with a local role.
function startLocalMultiplayerBattle(config) {
  menuElement.classList.add('hidden');
  ActiveScenario.clear();
  ActiveCustomBattle.clear();
  CampaignState.clear();

  let scenario;
  if (config.customRosters) {
    scenario = buildCustomScenario(
      config.customRosters.blueRoster,
      config.customRosters.redRoster,
      config.customRosters.playerTeamId || 'blue'
    );
  } else {
    scenario = PlayableScenarios.find(s => s.id === config.scenarioId);
    if (!scenario) {
      // Unresolvable force source. Clear the persistence slot so a
      // boot-resume with a stale scenarioId does not loop through this
      // failure on every reload — the slot survives only while it can
      // actually be rebuilt.
      ActiveLocalMultiplayer.clear();
      menu.show();
      return;
    }
  }

  // Persist the config so a hard refresh re-enters local MP with the
  // same forces and mode. Written only AFTER the scenario resolved, so
  // a bad payload cannot survive as a persisted slot. The stored shape
  // is exactly the config LocalMultiplayerSetup builds, which is also
  // what startLocalMultiplayerBattle consumes — so resume flows through
  // the same code path as a fresh launch with no adapter needed.
  ActiveLocalMultiplayer.set({
    mode: config.mode,
    intervalSeconds: config.intervalSeconds,
    scenarioId: config.scenarioId,
    customRosters: config.customRosters
  });

  startScenario(scenario, undefined, {
    role: 'local',
    localMode: config.mode,
    localIntervalSeconds: config.intervalSeconds
  });
}

// --- Multiplayer launcher -------------------------------------------------

function otherTeamId(teamId) {
  if (teamId === 'blue') return 'red';
  if (teamId === 'red') return 'blue';
  return null;
}

// Called by MPLobby once both peers have readied and the match scenario
// has been built on both ends. main.js takes over from here.
function startMultiplayerBattle(info) {
  const {
    session,
    scenario,
    deploymentSeconds,
    pauseMode,
    playerTeamId,
    otherTeamId: peerTeamId
  } = info;

  menuElement.classList.add('hidden');
  ActiveScenario.clear();
  ActiveCustomBattle.clear();
  CampaignState.clear();

  startScenario(scenario, undefined, {
    role: session.role,          // 'host' | 'guest'
    session,
    playerTeamId,
    otherTeamId: peerTeamId,
    deploymentSeconds,
    pauseMode
  });
}

// --- Boot -----------------------------------------------------------------

const campaign = CampaignState.load();

if (campaign && campaign.phase === 'battle') {
  launchCampaignBattle(campaign);
} else if (campaign) {
  campaignFlow.resume(campaign);
} else {
  const localMP = ActiveLocalMultiplayer.load();
  const activeScenarioId = ActiveScenario.get();
  const baseScenario = activeScenarioId
    ? PlayableScenarios.find(s => s.id === activeScenarioId)
    : null;
  // Non-null only when the last launch came from ScenarioMenu's
  // "Custom player setup" path — i.e. a resolved copy whose
  // playerTeamId / aiTeamIds / aiTierByTeamId were overridden from the
  // author-declared defaults. Merged over the base entry so Ctrl+R (and
  // the Restart button) resume the SAME customized battle, not the
  // author default.
  //
  // Without this merge, a both-AI (spectator) launch silently reverted
  // to player-vs-AI on reload: boot looked up the base PlayableScenarios
  // entry, which carries playerTeamId 'blue'. The persisted overrides
  // are what carry the actual role selection across the reload.
  const scenarioOverrides = activeScenarioId
    ? ActiveScenario.getOverrides()
    : null;
  const customBattle = baseScenario ? null : ActiveCustomBattle.load();

  if (localMP) {
    // Hard-refresh resume of a same-device battle. Routed through the
    // normal local launcher rather than duplicated here, so the force
    // source, mode, and interval are resolved through exactly one code
    // path — the same one the setup panel's Start Battle button uses.
    startLocalMultiplayerBattle(localMP);
  } else if (baseScenario && scenarioOverrides) {
    // Customized scenario — merge and launch. Base supplies
    // name/description/camera hints/build(); overrides supply
    // playerTeamId / aiTeamIds / aiTierByTeamId. Both Ctrl+R and the
    // Restart button take this branch identically, matching the plain
    // scenario behaviour below (restarting a battle resumes it).
    startScenario({ ...baseScenario, ...scenarioOverrides });
  } else if (baseScenario) {
    // Plain scenario, either Ctrl+R or Restart — resume as before.
    startScenario(baseScenario);
  } else if (customBattle) {
    // Pass playerTeamId through VERBATIM — do NOT use `?? 'blue'` here.
    // `null` is a meaningful value for this field: it means spectator
    // mode (both teams AI), which is a valid Custom Battle setup. A
    // nullish-coalescing fallback collapses spectator back to blue on
    // every Restart-button reload, silently turning a 2-AI battle into
    // a player-vs-AI one.
    //
    // buildCustomScenario already normalises this argument correctly
    // (blue / red / null), and treats an older save's `undefined` as
    // blue — so passing the raw value through is safe for every payload
    // shape in storage.
    startScenario(buildCustomScenario(
      customBattle.blueRoster,
      customBattle.redRoster,
      customBattle.playerTeamId,
      customBattle.aiTierByTeamId || null
    ));
  } else {
    if (activeScenarioId) ActiveScenario.clear();
    menu.show();
  }
}
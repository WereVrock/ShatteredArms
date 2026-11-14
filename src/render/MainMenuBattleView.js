// ===== MainMenuBattleView.js =====
// Cinematic battle background for the main menu, driven by a REAL
// BattleSimulation running two real Units.
//
// WHAT RUNS
// Every cycle, two Units are built via FormationFactory at full base
// size. A real BattleSimulation ticks at 15 Hz. The heavy unit is
// issued a real attack order against the light unit, and the sim
// resolves the charge, the throw (via CombatResolutionSystem's
// _applyThrow), the knockdown, and the deaths. Nothing is faked.
//
// CANDIDATE SELECTION (auto)
// Heavy candidates are derived by filtering UnitTypes with isCavalry —
// the sim-side gate that actually enables _applyThrow (see
// CombatResolutionSystem: `isChargingCavalry = isCavalry(...) && ...`).
// Types that are mounted for AI purposes but not classed CAVALRY —
// notably the Goblin Warlord's retinue, whose `countsAsCavalry` is an
// AI-only hint — are correctly excluded: they charge but cannot throw.
// The undead flag is randomised per cycle, so skeleton horsemen appear
// roughly half the time (via isUndead on human-race cavalry types).
//
// Light candidates exclude cavalry and spearmen (spearmen brace and
// counter-kill instead of being thrown) and enforce a heavy:light mass
// ratio safely above the sim's own minMassRatioForKnockback.
//
// SPEED BOOST
// The sim's globalSpeedScale (0.6) makes cavalry charge at ~1.48 sim
// units/sec — accurate but visually pedestrian at close camera range.
// Each menu soldier gets a per-instance effectiveMoveSpeed multiplier
// (SPEED_BOOST) that the sim honours naturally: currentSpeed reaches
// ~2.0 at impact (still above the sim-space charge speed threshold of
// 1.08, so throws fire), the walk cycle visibly speeds up, and the
// anchor advances at the boosted speed (my _computeAnchorSpeed
// override reads s.effectiveMoveSpeed, which is the boosted getter).
//
// ANCHOR SPEED
// The sim's MARCH_ANCHOR_SPEED (1.3) caps the live formation anchor;
// reasonable for gameplay, but at 1.3 the formation crawls. For the
// menu's heavy unit the override returns the boosted soldier sim
// speed so the anchor and the soldiers move at the same rate.
//
// PHASE MACHINE
//   FADE_IN (0.5s) -> CHARGE (until first throw, 8s cap)
//   -> IMPACT (0.6s) -> SETTLE (1.5s) -> FADE_OUT (1.5s) -> new cycle
// IMPACT begins the moment a light-team soldier gets
// airborneTicksLeft > 0. Sim ticks are frozen during FADE_OUT so the
// cut to black is clean.
//
// PRE-RUN
// 15 sim ticks (1.0s) are ticked silently before fade-in. At the
// boosted speed that covers ~2.0 units of the 8-unit gap, so when the
// fade completes the viewer sees the charge already underway at full
// speed, with ~1 second of visible charge before impact.
//
// CAMERA / COMPOSITION
// No zoom. Distance and height constant within a cycle, per-cycle
// shot picked from six fixed angles. Aim point is shifted to the
// camera's right by COMPOSITION_OFFSET_FRAC of the visible frame
// width, so action appears left-of-center, clear of the button panel.
import * as THREE from 'three';
import { buildScenery } from './camp/CampScenery.js';
import { disposeObject3D } from './camp/CampGeometry.js';
import { BattleSimulation } from '../sim/BattleSimulation.js';
import { FormationFactory } from '../sim/FormationFactory.js';
import { SoldierView } from './SoldierView.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { SettingsStore } from '../ui/settings/SettingsStore.js';
import { baseSizeFor } from '../scenarios/RosterScaling.js';
import { isCavalry, isSpearmen } from '../config/UnitClasses.js';
import { CombatConfig } from '../config/CombatConfig.js';

const FRAME_MS = 1000 / 30;
const PIXEL_RATIO_CAP = 1.25;
const LIGHT_GAIN = (parseInt(THREE.REVISION, 10) >= 155) ? Math.PI : 1;

const SIM_TICK_INTERVAL = 1 / 15;
const MAX_SIM_TICKS_PER_FRAME = 4;

// 15 ticks = 1 second of pre-run at 15 Hz. Gives the charge a head
// start so it reads as "already underway" at fade-in end.
const PRE_RUN_TICKS = 15;

// Per-soldier effectiveMoveSpeed multiplier. The sim honours this via
// its own effectiveMoveSpeed reads; charge speed, walk-cycle rate, and
// the anchor override all scale with it. 1.35 turns the actual sim
// speed from 1.48 to ~2.0 sim units/sec, comfortably above the charge
// gate (1.08) so throws still fire.
const SPEED_BOOST = 1.35;

// --- phase timing (seconds) ---
const FADE_IN_SEC = 0.5;
const CHARGE_MAX_SEC = 8.0;
const IMPACT_SEC = 0.6;
const SETTLE_SEC = 2.5;
const FADE_OUT_SEC = 1.5;

// --- spawn geometry ---
// 8-unit gap between anchors. With pre-run ~2 units, fade-in ~1 unit,
// and boosted speed ~2/s, the visible charge is about 1s before impact.
const HEAVY_START_X = -3.0;
const LIGHT_START_X = 5.0;
const UNIT_FACING = Math.PI / 2;
const LIGHT_FACING = -Math.PI / 2;
const FORMATION_SPACING = 0.7;

// --- camera shots ---
const CAMERA_SHOTS = Object.freeze([
  { angle:  Math.PI * 0.30, height: 2.8, dist: 14, aimOffsetY: 0.05 },
  { angle:  Math.PI * 0.32, height: 1.2, dist: 12, aimOffsetY: 0.10 },
  { angle:  Math.PI * 0.55, height: 4.5, dist: 16, aimOffsetY: 0.00 },
  { angle:  Math.PI * 0.80, height: 3.2, dist: 15, aimOffsetY: 0.05 },
  { angle:  Math.PI * 0.15, height: 1.8, dist: 13, aimOffsetY: 0.08 },
  { angle: -Math.PI * 0.35, height: 3.0, dist: 14, aimOffsetY: 0.05 }
]);

const COMPOSITION_OFFSET_FRAC = 0.15;
const TARGET_SMOOTH_TAU = 0.7;

// --- FPS auto-disable ---
// If the average render frame rate drops below FPS_AUTO_DISABLE_THRESHOLD
// over a window covering at least FPS_MIN_WINDOW_MS, the animated
// background switches to the still-image fallback and the
// menuBattleView setting is set false so the toggle reflects the state.
// The check is permanently disabled the first time the USER manually
// toggles the setting (see onUserToggle), so the user's explicit
// choice is always respected.
const FPS_AUTO_DISABLE_THRESHOLD = 20;
const FPS_WINDOW_MS = 2000;
const FPS_MIN_WINDOW_MS = 1500;
const FPS_WARMUP_FRAMES = 5;

// --- pools (auto-derived) ---
// HEAVY: any type that can actually throw — isCavalry(typeDef). This
// matches CombatResolutionSystem's own gate, so a new cavalry type is
// auto-included and a mounted-but-not-cavalry type (Warlord retinue)
// is auto-excluded.
const HEAVY_POOL = Object.freeze(
  Object.values(UnitTypes).filter(t => t && t.baseHp > 0 && isCavalry(t))
);

function pickFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickHeavyType() {
  if (HEAVY_POOL.length > 0) return pickFrom(HEAVY_POOL);
  return UnitTypes.horsemen || Object.values(UnitTypes)[0];
}

function pickLightType(heavyType) {
  const heavyMass = (heavyType && heavyType.mass) || 1;
  const minRatio = (CombatConfig.charge.minMassRatioForKnockback || 1.5) * 1.15;
  const candidates = Object.values(UnitTypes).filter(t => {
    if (!t || !(t.baseHp > 0)) return false;
    if (isCavalry(t)) return false;
    if (isSpearmen(t)) return false;
    const lightMass = Math.max(0.3, t.mass || 1);
    return (heavyMass / lightMass) >= minRatio;
  });
  if (candidates.length === 0) return UnitTypes.archer;
  return pickFrom(candidates);
}

function fullSizeFor(typeDef) {
  try {
    const n = baseSizeFor(typeDef);
    if (typeof n === 'number' && n > 0) return n;
  } catch (e) { /* fall through */ }
  return (typeDef && typeDef.preferredRows)
    ? typeDef.preferredRows * 6
    : 8;
}

// Per-soldier speed boost via a cached own-property. Reading via the
// prototype getter each time is fine functionally but wasteful; since
// the base speed is constant per soldier for the menu's short battle,
// caching here is safe. Configurable so a future disposal path could
// restore the prototype behaviour.
function applySpeedBoost(soldier) {
  const boosted = soldier.effectiveMoveSpeed * SPEED_BOOST;
  Object.defineProperty(soldier, 'effectiveMoveSpeed', {
    value: boosted,
    writable: false,
    configurable: true,
    enumerable: false
  });
}

// --- battlefield theme ---
const BATTLEFIELD_THEME = Object.freeze({
  seed: 73,
  fog: { color: 0xa8b4c4, near: 55, far: 320 },
  sky: {
    zenith: 0x2a4a7a,
    mid: 0x6a90c8,
    horizon: 0xa8b4c4,
    glow: 0xffe6b0,
    glowDir: [-0.35, 0.45, -0.85],
    glowPower: 5
  },
  celestial: { color: 0xfff4d0, dir: [-0.35, 0.45, -0.85], size: 18, halo: 0.65 },
  stars: 0,
  lights: {
    hemiSky: 0xbcd4ee,
    hemiGround: 0x4a5a30,
    hemi: 0.85,
    keyColor: 0xfff0d0,
    key: 1.15,
    keyPos: [-20, 25, -47]
  },
  ground: { grassDark: 0x3f5a2a, grassLight: 0x5e7c3c, dirt: 0x7a6240, rock: 0x6a665e },
  mountains: { near: 0x506080, far: 0x7a8ca8, snow: 0xe8eef6 },
  forest: {
    style: 'mixed',
    foliage: [0x2f5428, 0x45702f, 0x5e8a3a],
    trunk: 0x4a3524,
    density: 1.0
  }
});

export class MainMenuBattleView {
  constructor() {
    this._active = false;
    this._parentEl = null;
    this._rafId = null;
    this._lastFrameMs = 0;

    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = [
      'position:absolute', 'inset:0',
      'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:0', 'display:none'
    ].join(';');

    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: false,
      alpha: false
    });
    this._renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP)
    );
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFShadowMap;
    this._renderer.shadowMap.autoUpdate = true;

    this._fadeOverlay = document.createElement('div');
    this._fadeOverlay.style.cssText = [
      'position:absolute', 'inset:0',
      'background:#000',
      'pointer-events:none',
      'z-index:1',
      'opacity:0',
      'display:none'
    ].join(';');
    this._lastFadeOpacity = undefined;

    // Still-image fallback shown when the animated background is
    // disabled in settings. Same layering as the canvas (z-index 0);
    // object-fit:cover so it fills the panel at any aspect ratio
    // without re-rendering on resize. The still is regenerated each
    // time the setting is toggled off (fresh random unit each time).
    this._stillImg = document.createElement('img');
    this._stillImg.alt = '';
    this._stillImg.draggable = false;
    this._stillImg.style.cssText = [
      'position:absolute', 'inset:0',
      'width:100%', 'height:100%',
      'object-fit:cover',
      'pointer-events:none', 'z-index:0', 'display:none'
    ].join(';');

    this._scene = new THREE.Scene();
    const fogColor = new THREE.Color(BATTLEFIELD_THEME.fog.color);
    this._scene.background = fogColor;
    this._scene.fog = new THREE.Fog(
      fogColor, BATTLEFIELD_THEME.fog.near, BATTLEFIELD_THEME.fog.far
    );

    this._camera = new THREE.PerspectiveCamera(42, 1, 0.2, 800);

    this._applyLights();

    this._scenery = buildScenery(BATTLEFIELD_THEME);
    this._scene.add(this._scenery);

    // buildScenery's meshes default to receiveShadow: false, so the
    // ground never displayed the soldiers' shadows even though the sun
    // casts them. Set it on every mesh in the group (harmless on the
    // sky/mountains which either use MeshBasicMaterial or sit outside
    // the shadow frustum).
    this._scenery.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });

    this._simulation = null;
    this._views = [];
    this._viewsBySoldierId = new Map();
    this._lightUnitId = null;
    this._simAccumulator = 0;

    this._phase = 'IDLE';
    this._phaseStartMs = 0;
    this._cycleStartMs = 0;
    this._currentShot = CAMERA_SHOTS[0];

    this._smoothX = null;
    this._smoothZ = null;

    // FPS auto-disable state. _fpsSamples holds {t, fps} pairs for the
    // rolling window; _fpsWarmupRemaining skips the first few renders
    // (shader compile) so their cost does not skew the average;
    // _autoDisablePermanentlyDisabled is set the first time the user
    // manually toggles the setting.
    this._fpsSamples = [];
    this._prevRenderMs = 0;
    this._fpsWarmupRemaining = FPS_WARMUP_FRAMES;
    this._autoDisablePermanentlyDisabled = false;

    // Reset FPS state on tab visibility change. Without this, a
    // backgrounded tab's rAF throttling (1 Hz) would flood the window
    // with sub-1-fps samples and false-trigger the auto-disable.
    this._onVisibilityChange = () => {
      this._fpsSamples.length = 0;
      this._prevRenderMs = 0;
      this._fpsWarmupRemaining = FPS_WARMUP_FRAMES;
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    this._tick = this._tick.bind(this);
    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    this._menuObserver = null;
    this._unsubSettings = SettingsStore.subscribe(() => this.refresh());
  }

  // --- attachment -------------------------------------------------------

  attachTo(parentEl) {
    if (!parentEl) return;
    this._parentEl = parentEl;
    this._ensureAttached();
    this._raiseMenuPanel();
    this._watchMenu();
  }

  detach() {
    if (this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    if (this._fadeOverlay.parentNode) {
      this._fadeOverlay.parentNode.removeChild(this._fadeOverlay);
    }
    if (this._stillImg.parentNode) {
      this._stillImg.parentNode.removeChild(this._stillImg);
    }
    this._unwatchMenu();
    this.hide();
    this._parentEl = null;
  }

  _ensureAttached() {
    if (!this._parentEl) return;
    if (this._canvas.parentNode !== this._parentEl) {
      this._parentEl.insertBefore(this._canvas, this._parentEl.firstChild);
    }
    if (this._fadeOverlay.parentNode !== this._parentEl) {
      if (this._canvas.nextSibling) {
        this._parentEl.insertBefore(this._fadeOverlay, this._canvas.nextSibling);
      } else {
        this._parentEl.appendChild(this._fadeOverlay);
      }
    }
    if (this._stillImg.parentNode !== this._parentEl) {
      if (this._canvas.nextSibling) {
        this._parentEl.insertBefore(this._stillImg, this._canvas.nextSibling);
      } else {
        this._parentEl.appendChild(this._stillImg);
      }
    }
  }

  _raiseMenuPanel() {
    if (!this._parentEl) return;
    const panels = this._parentEl.querySelectorAll(
      '.menu-panel, .menu-brand-panel'
    );
    for (const p of panels) {
      if (p.style.zIndex !== '2') p.style.zIndex = '2';
    }
  }

  // --- visibility -------------------------------------------------------

  refresh() {
    if (!this._parentEl) return;
    const parentHidden = this._parentEl.classList.contains('hidden');
    const onMainMenu = !!this._parentEl.querySelector('.main-menu-panel');
    const enabled = SettingsStore.get().menuBattleView !== false;

    if (!parentHidden && onMainMenu) {
      if (enabled) this.show();
      else this.showStill();
    } else {
      this.hide();
    }
  }

  show() {
    // Reset FPS measurement so each entry to animated mode starts
    // with a fresh warmup — a re-enable after an FPS auto-disable
    // should not inherit the old low-FPS samples.
    this._fpsSamples.length = 0;
    this._prevRenderMs = 0;
    this._fpsWarmupRemaining = FPS_WARMUP_FRAMES;

    // Transitioning from still mode -> restart the animated cycle.
    if (!this._active && this._stillImg.style.display !== 'none') {
      this._stillImg.style.display = 'none';
      this._active = true;
      this._canvas.style.display = 'block';
      this._fadeOverlay.style.display = 'block';
      this._resize();
      this._startNewCycle();
      this._startLoop();
      return;
    }

    if (this._active) return;
    this._active = true;
    this._canvas.style.display = 'block';
    this._fadeOverlay.style.display = 'block';
    this._resize();
    this._startNewCycle();
    this._startLoop();
  }

  // Still-image fallback: called when the animated background is
  // disabled in settings. Renders ONE frame of a random unit at a low
  // angle to the visible canvas, captures it via toDataURL, and shows
  // the <img>. Every call regenerates the image so toggling the
  // setting off gets a fresh unit each time.
  showStill() {
    // Coming from animated mode: stop the loop and clean up.
    if (this._active) {
      this._active = false;
      this._stopLoop();
      this._teardownSim();
    }

    // Already in still mode AND the image is populated: nothing to do.
    if (this._stillImg.style.display === 'block' && this._stillImg.src) {
      return;
    }

    // Hide the fade overlay with inline !important so a stylesheet rule
    // cannot resurrect it, and reset the tracker so a subsequent fade
    // animation starts from a clean state. This is the actual cause of
    // the "black overlay of fading out" symptom: when the player
    // toggled the setting off mid-fade, the fade overlay was still
    // displaying at full opacity and the previous hide logic could not
    // reliably suppress it.
    this._fadeOverlay.style.setProperty('display', 'none', 'important');
    this._fadeOverlay.style.setProperty('opacity', '0', 'important');
    this._lastFadeOpacity = 0;

    // The still renderer toggles the canvas visible for its own
    // duration. Running it BEFORE the still image is shown means the
    // image data is in hand by the time the still is made visible.
    this._renderStill();

    this._stillImg.style.setProperty('display', 'block', 'important');
  }

  hide() {
    if (!this._active && this._stillImg.style.display === 'none') return;
    this._active = false;
    this._canvas.style.display = 'none';
    this._fadeOverlay.style.display = 'none';
    this._stillImg.style.display = 'none';
    this._stopLoop();
    this._teardownSim();
    this._setFadeOpacity(0);
  }

  isVisible() {
    return this._active;
  }

  dispose() {
    if (this._unsubSettings) {
      this._unsubSettings();
      this._unsubSettings = null;
    }
    this._stopLoop();
    this._teardownSim();
    this._unwatchMenu();
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);

    if (this._scenery) {
      disposeObject3D(this._scenery);
      this._scenery = null;
    }
    // Blank the still image so the browser releases the data URL.
    this._stillImg.src = '';
    this._stillImg = null;
    this._renderer.dispose();
    this.detach();
  }

  // --- theme ------------------------------------------------------------

  _applyLights() {
    const l = BATTLEFIELD_THEME.lights;

    this._hemi = new THREE.HemisphereLight(
      l.hemiSky, l.hemiGround, l.hemi * LIGHT_GAIN
    );
    this._scene.add(this._hemi);

    this._sun = new THREE.DirectionalLight(
      l.keyColor, l.key * LIGHT_GAIN
    );
    this._sun.position.set(l.keyPos[0], l.keyPos[1], l.keyPos[2]);
    this._sun.castShadow = true;

    const EXTENT = 20;
    this._sun.shadow.camera.left   = -EXTENT;
    this._sun.shadow.camera.right  =  EXTENT;
    this._sun.shadow.camera.top    =  EXTENT;
    this._sun.shadow.camera.bottom = -EXTENT;
    this._sun.shadow.camera.near = 1;
    this._sun.shadow.camera.far  = 160;
    this._sun.shadow.mapSize.set(1024, 1024);
    this._sun.shadow.bias = -0.0005;
    this._sun.shadow.normalBias = 0.02;

    this._scene.add(this._sun);
    this._scene.add(this._sun.target);
  }

  // --- menu observation -------------------------------------------------

  _watchMenu() {
    if (this._menuObserver) return;
    this._menuObserver = new MutationObserver(() => {
      if (!this._parentEl) return;
      this._ensureAttached();
      this._raiseMenuPanel();
      this.refresh();
    });
    this._menuObserver.observe(this._parentEl, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: false
    });
    this.refresh();
  }

  _unwatchMenu() {
    if (this._menuObserver) {
      this._menuObserver.disconnect();
      this._menuObserver = null;
    }
  }

  // --- cycle ------------------------------------------------------------

  _startNewCycle() {
    this._teardownSim();
    this._buildSim();

    this._cycleStartMs = performance.now();
    this._phase = 'FADE_IN';
    this._phaseStartMs = this._cycleStartMs;
    this._currentShot = CAMERA_SHOTS[
      Math.floor(Math.random() * CAMERA_SHOTS.length)
    ];
    this._smoothX = null;
    this._smoothZ = null;

    // Pre-run the sim so the charge is already at full speed when the
    // viewer sees it. 15 ticks = 1s at 15 Hz — the user's "a second to
    // speed up."
    for (let i = 0; i < PRE_RUN_TICKS; i++) {
      this._simulation.tick();
      this._consumeSimEvents();
    }
  }

  _buildSim() {
    const heavyType = pickHeavyType();
    const lightType = pickLightType(heavyType);

    // Random undead per cycle. Soldier coerces to false for races
    // without supportsUndead (goblins), so skeleton variants only
    // appear on human-race types (horsemen, archer) — which is exactly
    // the intent.
    const heavyIsUndead = Math.random() < 0.5;
    const lightIsUndead = Math.random() < 0.5;

    const heavyCount = fullSizeFor(heavyType);
    const lightCount = fullSizeFor(lightType);

    const heavyUnit = FormationFactory.createUnitWithCount({
      id: 'menu-heavy',
      teamId: 'blue',
      unitTypeDef: heavyType,
      originX: HEAVY_START_X,
      originZ: 0,
      facing: UNIT_FACING,
      count: heavyCount,
      spacing: FORMATION_SPACING,
      isUndead: heavyIsUndead
    });

    const lightUnit = FormationFactory.createUnitWithCount({
      id: 'menu-light',
      teamId: 'red',
      unitTypeDef: lightType,
      originX: LIGHT_START_X,
      originZ: 0,
      facing: LIGHT_FACING,
      count: lightCount,
      spacing: FORMATION_SPACING,
      isUndead: lightIsUndead
    });

    // Speed boost. Applied BEFORE the sim starts ticking so every
    // system (movement, charge detection, anchor speed) sees the
    // boosted value from tick 1.
    for (const unit of [heavyUnit, lightUnit]) {
      for (const soldier of unit.soldiers) {
        applySpeedBoost(soldier);
      }
    }

    // Force the heavy unit to run at max speed from tick 1. The whole
    // point of the menu background is a dramatic charge — RunSystem's
    // normal stamina/order logic would otherwise start the unit walking
    // (or interrupt the run mid-charge when engagement begins). The
    // flag is pinned on the unit AND on every soldier because two
    // separate code paths read it:
    //
    //   - Unit._computeAnchorSpeed (called from Unit.update) reads the
    //     UNIT flag to decide whether to bypass the MARCH_ANCHOR_SPEED
    //     ceiling.
    //   - Gait.speedMult (called from MovementSystem._applyTerrain)
    //     reads the SOLDIER flag to fold the run multiplier into
    //     terrainSpeedMult.
    //
    // Both are pinned with a no-op setter, so any subsequent RunSystem
    // write is silently discarded. Visible result: the block charges
    // at full run speed from the very first frame and never breaks
    // stride. Mounted units have no run-pose leg arrays, so forcing the
    // soldier flag cannot accidentally trigger a run-cycle leg
    // animation on a standing rider.
    heavyUnit.runEnabled = true;
    const forceTrue = () => true;
    const noopSet = () => {};
    Object.defineProperty(heavyUnit, 'gaitRunning', {
      get: forceTrue, set: noopSet, configurable: true
    });
    for (const soldier of heavyUnit.soldiers) {
      Object.defineProperty(soldier, 'gaitRunning', {
        get: forceTrue, set: noopSet, configurable: true
      });
    }

    this._lightUnitId = lightUnit.id;

    this._simulation = new BattleSimulation([heavyUnit, lightUnit], {
      playerTeamId: 'blue'
    });

    heavyUnit.issueAttackOrder(lightUnit);

    // Anchor speed override. Reads actualMoveSpeed — which folds in the
    // speed boost, the run multiplier MovementSystem._applyTerrain
    // stores in terrainSpeedMult, and terrain — instead of raw
    // effectiveMoveSpeed. With the run system active, effectiveMoveSpeed
    // is only the WALK speed: MovementSystem multiplies it by
    // Gait.speedMult to get the real per-tick step. Reading
    // effectiveMoveSpeed here therefore advanced the anchor at walk
    // pace while the soldiers ran at run pace, stretching the block
    // ahead of its slots and producing the visible "broken charge"
    // symptom. Pinning the anchor to actualMoveSpeed keeps slots and
    // soldiers in lockstep at whatever pace the current gait produces.
    //
    // The fallback (never hit on a fresh charge — every follower is
    // marching) returns the boosted walk speed so the anchor still
    // makes progress if every follower happens to be routing.
    heavyUnit._computeAnchorSpeed = function (aliveSoldiers) {
      let minSpeed = Infinity;
      for (const s of aliveSoldiers) {
        if (s.state === 'routing' || s.state === 'shattered') continue;
        const v = s.actualMoveSpeed;
        if (!(v > 0)) continue;
        if (v < minSpeed) minSpeed = v;
      }
      if (isFinite(minSpeed)) {
        return minSpeed * CombatConfig.movement.globalSpeedScale;
      }
      const sample = this.soldiers[0];
      return sample
        ? sample.effectiveMoveSpeed * CombatConfig.movement.globalSpeedScale
        : 2.0;
    };

    for (const unit of [heavyUnit, lightUnit]) {
      for (const soldier of unit.soldiers) {
        const view = new SoldierView(soldier, this._scene);
        view._maybeUpdateLod = () => {};
        view.flag.visible = false;
        this._views.push({ soldier, view });
        this._viewsBySoldierId.set(soldier.id, { soldier, view });
      }
    }
  }

  _teardownSim() {
    for (const entry of this._views) {
      entry.view.dispose(this._scene);
    }
    this._views = [];
    this._viewsBySoldierId.clear();
    this._simulation = null;
    this._simAccumulator = 0;
  }

  // Renders one frame of a random unit at a low angle and captures it
  // via canvas.toDataURL() into the stillImg element.
  //
  // The canvas is made visible for the duration of the render because
  // some browsers pause the WebGL context on a display:none canvas,
  // producing black frames. It is hidden again before this method
  // returns, so there is no visible flash (DOM writes are batched and
  // the browser does not paint mid-call).
  //
  // toDataURL is used instead of readRenderTargetPixels because it
  // goes through the browser's own encoder and works reliably on the
  // visible canvas, whereas readRenderTargetPixels has edge cases on
  // some platforms that return an empty buffer.
  _renderStill() {
    this._teardownSim();

    // Make the canvas visible so the WebGL context is not throttled
    // while we render and capture. Hidden again at the end of this
    // method.
    this._canvas.style.setProperty('display', 'block', 'important');

    // Ensure the canvas has been sized so we render at full resolution.
    this._resize();

    const w = this._renderer.domElement.width;
    const h = this._renderer.domElement.height;
    if (w < 2 || h < 2) {
      this._canvas.style.setProperty('display', 'none', 'important');
      return;
    }

    // Pick a random combat-worthy unit type. Every real type (baseHp>0)
    // qualifies — spearmen, cavalry, archers all read well from a low
    // angle.
    const allTypes = Object.values(UnitTypes).filter(t => t && t.baseHp > 0);
    const typeDef = pickFrom(allTypes) || UnitTypes.horsemen;
    const isUndead = Math.random() < 0.5;
    const teamId = Math.random() < 0.5 ? 'blue' : 'red';
    const count = fullSizeFor(typeDef);

    // Camera azimuth around the unit. The camera orbits at this angle;
    // the unit faces BACK toward the camera, so the shot always reads
    // as "unit facing the viewer" even as both vary.
    //
    // Facing convention (see Soldier.moveFacing / _applyFormationAt):
    // the unit's forward direction is world (sin(facing), cos(facing)).
    // A camera at azimuth az from the unit sits at (sin(az), cos(az))
    // from the unit, so "facing the camera" is facing = az. A random
    // jitter of up to ±FACING_JITTER radians (≈34° → 68° total cone)
    // keeps the unit visibly facing the camera while making each
    // snapshot look different.
    const azimuth = Math.random() * Math.PI * 2;
    const FACING_JITTER = 0.6;
    const facing = azimuth + (Math.random() * 2 - 1) * FACING_JITTER;

    // Build the unit with the chosen facing. Facing is baked into the
    // formation at creation time, so no post-creation rotation is
    // needed.
    const unit = FormationFactory.createUnitWithCount({
      id: 'menu-still',
      teamId,
      unitTypeDef: typeDef,
      originX: 0,
      originZ: 0,
      facing,
      count,
      spacing: FORMATION_SPACING,
      isUndead
    });

    // One-time views. No LOD rebuilds, no rout flags.
    for (const soldier of unit.soldiers) {
      const view = new SoldierView(soldier, this._scene);
      view._maybeUpdateLod = () => {};
      view.flag.visible = false;
      this._views.push({ soldier, view });
    }

    // Camera at low height on the chosen azimuth, aimed slightly above
    // body height so the shot reads as looking up. Radius, height and
    // aim height all carry small random jitter for variety — every
    // snapshot varies in angle AND framing while staying a low-angle
    // hero shot.
    const center = unit.getCenter();
    const CAMERA_RADIUS = 10.5 + Math.random() * 2.0;    // 10.5..12.5
    const CAMERA_HEIGHT = 0.7 + Math.random() * 0.5;     // 0.7..1.2
    const AIM_HEIGHT = 2.0 + Math.random() * 0.3;        // 2.0..2.3
    this._camera.position.set(
      center.x + Math.sin(azimuth) * CAMERA_RADIUS,
      CAMERA_HEIGHT,
      center.z + Math.cos(azimuth) * CAMERA_RADIUS
    );
    this._camera.lookAt(center.x, AIM_HEIGHT, center.z);
    this._camera.updateMatrixWorld();

    // Sun follows the unit so the shadow frustum covers it.
    const sunOffset = BATTLEFIELD_THEME.lights.keyPos;
    this._sun.position.set(
      center.x + sunOffset[0],
      sunOffset[1],
      center.z + sunOffset[2]
    );
    this._sun.target.position.set(center.x, 0, center.z);
    this._sun.target.updateMatrixWorld();

    // Sync every view once. This is the frame the render will draw.
    const unitsById = new Map();
    for (const entry of this._views) {
      entry.view.sync(this._camera.position, unitsById, 0);
    }

    // Render directly to the visible canvas (currently forced visible
    // by the top of this method). toDataURL then encodes the buffer
    // through the browser's own JPEG encoder — more reliable across
    // platforms than readRenderTargetPixels, which some implementations
    // return as an all-zero buffer for offscreen targets.
    this._renderer.render(this._scene, this._camera);
    const dataUrl = this._renderer.domElement.toDataURL('image/jpeg', 0.85);

    this._stillImg.src = dataUrl;

    // Hide the canvas again — showStill() will make the still image
    // visible in its place.
    this._canvas.style.setProperty('display', 'none', 'important');

    // The snapshot is captured — clean up the scene graph.
    this._teardownSim();
  }

  _consumeSimEvents() {
    if (!this._simulation) return;
    const melee = this._simulation.combatResolutionSystem.drainEvents();
    const ranged = this._simulation.projectileSystem.drainEvents();

    for (const evt of melee) {
      if (evt.type === 'attack') {
        const a = this._viewsBySoldierId.get(evt.attackerId);
        if (a) a.view.triggerAttackAnim();
      } else if (evt.type === 'block') {
        const d = this._viewsBySoldierId.get(evt.defenderId);
        if (d) d.view.triggerBlockFlash();
      }
    }
    for (const evt of ranged) {
      if (evt.type === 'block') {
        const d = this._viewsBySoldierId.get(evt.defenderId);
        if (d) d.view.triggerBlockFlash();
      }
    }
  }

  // --- loop -------------------------------------------------------------

  _startLoop() {
    if (this._rafId !== null) return;
    this._lastFrameMs = 0;
    this._rafId = requestAnimationFrame(this._tick);
  }

  _stopLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _tick(now) {
    if (!this._active) {
      this._rafId = null;
      return;
    }
    this._rafId = requestAnimationFrame(this._tick);

    if (now - this._lastFrameMs < FRAME_MS) return;
    const dt = this._lastFrameMs > 0
      ? Math.min(0.1, (now - this._lastFrameMs) / 1000)
      : FRAME_MS / 1000;
    this._lastFrameMs = now;

    this._advancePhase(now);

    if (this._phase !== 'FADE_OUT' && this._simulation) {
      this._simAccumulator += dt;
      let ticks = 0;
      while (this._simAccumulator >= SIM_TICK_INTERVAL &&
             ticks < MAX_SIM_TICKS_PER_FRAME) {
        this._simulation.tick();
        this._simAccumulator -= SIM_TICK_INTERVAL;
        ticks++;
        this._consumeSimEvents();
      }
    }

    this._updateViews(dt);
    this._updateCamera(now, dt);
    this._updateFade(now);

    if (this._phase === 'FADE_OUT' &&
        (now - this._phaseStartMs) / 1000 >= FADE_OUT_SEC) {
      this._startNewCycle();
    }

    this._renderer.render(this._scene, this._camera);

    // FPS measurement. Sample the interval between RENDERS, not rAF
    // calls — the frame throttle in _tick returns early on non-render
    // frames, so measuring rAF interval would just report the browser's
    // refresh rate regardless of actual render cost.
    if (this._prevRenderMs > 0) {
      const intervalMs = now - this._prevRenderMs;
      if (this._fpsWarmupRemaining > 0) {
        this._fpsWarmupRemaining--;
      } else if (intervalMs > 0) {
        this._fpsSamples.push({ t: now, fps: 1000 / intervalMs });
        const cutoff = now - FPS_WINDOW_MS;
        while (this._fpsSamples.length > 0 &&
               this._fpsSamples[0].t < cutoff) {
          this._fpsSamples.shift();
        }
      }
    }
    this._prevRenderMs = now;

    // Auto-disable evaluation. Only runs if the user has never touched
    // the toggle (see onUserToggle), the tab is visible, and the window
    // covers enough time to trust the average.
    if (!this._autoDisablePermanentlyDisabled &&
        !document.hidden &&
        this._fpsSamples.length >= 10 &&
        (now - this._fpsSamples[0].t) >= FPS_MIN_WINDOW_MS) {
      let sum = 0;
      for (const s of this._fpsSamples) sum += s.fps;
      const avg = sum / this._fpsSamples.length;
      if (avg < FPS_AUTO_DISABLE_THRESHOLD) {
        this._autoDisableForFps(avg);
      }
    }
  }

  _advancePhase(now) {
    const phaseElapsed = (now - this._phaseStartMs) / 1000;
    switch (this._phase) {
      case 'FADE_IN':
        if (phaseElapsed >= FADE_IN_SEC) {
          this._phase = 'CHARGE';
          this._phaseStartMs = now;
        }
        break;
      case 'CHARGE':
        if (this._hasAnyThrownLightSoldier()) {
          this._phase = 'IMPACT';
          this._phaseStartMs = now;
        } else if (phaseElapsed >= CHARGE_MAX_SEC) {
          this._phase = 'FADE_OUT';
          this._phaseStartMs = now;
        }
        break;
      case 'IMPACT':
        if (phaseElapsed >= IMPACT_SEC) {
          this._phase = 'SETTLE';
          this._phaseStartMs = now;
        }
        break;
      case 'SETTLE':
        if (phaseElapsed >= SETTLE_SEC) {
          this._phase = 'FADE_OUT';
          this._phaseStartMs = now;
        }
        break;
      case 'FADE_OUT':
        break;
    }
  }

  _hasAnyThrownLightSoldier() {
    if (!this._simulation) return false;
    for (const entry of this._views) {
      if (entry.soldier.airborneTicksLeft > 0 &&
          entry.soldier.unitId === this._lightUnitId) {
        return true;
      }
    }
    return false;
  }

  // Called from the FPS check when the average drops below threshold.
  // Setting menuBattleView to false routes through the SettingsStore
  // subscriber to refresh(), which shows the still-image fallback. The
  // toggle checkbox reflects the new setting automatically.
  _autoDisableForFps(measuredFps) {
    this._fpsSamples.length = 0;
    this._fpsWarmupRemaining = FPS_WARMUP_FRAMES;
    SettingsStore.set('menuBattleView', false);
    console.log(
      `[MainMenuBattleView] auto-disabled (avg ${measuredFps.toFixed(1)} FPS < ` +
      `${FPS_AUTO_DISABLE_THRESHOLD}). Uncheck 'Disable Animation' to ` +
      `re-enable — this will not happen again this session.`
    );
  }

  // Called by main.js when the user manually toggles the setting. Any
  // user toggle action permanently disables FPS auto-disable for the
  // session — the user has expressed a preference, we respect it. The
  // SettingsStore subscriber already routes the show/hide via
  // refresh(), so this method only needs to record the preference and
  // clear the sample window.
  onUserToggle(_enabled) {
    this._autoDisablePermanentlyDisabled = true;
    this._fpsSamples.length = 0;
    this._fpsWarmupRemaining = FPS_WARMUP_FRAMES;
    // Refresh so a toggle whose value happened to be already-set still
    // re-evaluates state (harmless when subscriber already ran).
    this.refresh();
  }

  _updateFade(now) {
    const elapsed = (now - this._phaseStartMs) / 1000;
    let opacity = 0;
    if (this._phase === 'FADE_IN') {
      opacity = Math.max(0, 1 - elapsed / FADE_IN_SEC);
    } else if (this._phase === 'FADE_OUT') {
      opacity = Math.min(1, elapsed / FADE_OUT_SEC);
    }
    this._setFadeOpacity(opacity);
  }

  _setFadeOpacity(opacity) {
    const rounded = Math.round(opacity * 1000) / 1000;
    if (this._lastFadeOpacity === rounded) return;
    this._lastFadeOpacity = rounded;
    this._fadeOverlay.style.opacity = rounded.toFixed(3);
  }

  // --- camera -----------------------------------------------------------

  _updateCamera(now, dt) {
    const shot = this._currentShot;

    let sumX = 0, sumZ = 0, n = 0;
    for (const entry of this._views) {
      if (!entry.soldier.isAlive()) continue;
      sumX += entry.soldier.pos.x;
      sumZ += entry.soldier.pos.z;
      n++;
    }
    const rawX = n > 0 ? sumX / n : 0;
    const rawZ = n > 0 ? sumZ / n : 0;

    if (this._smoothX === null) {
      this._smoothX = rawX;
      this._smoothZ = rawZ;
    } else {
      const k = 1 - Math.exp(-dt / TARGET_SMOOTH_TAU);
      this._smoothX += (rawX - this._smoothX) * k;
      this._smoothZ += (rawZ - this._smoothZ) * k;
    }

    const aspect = this._camera.aspect || 1;
    const fovRad = (this._camera.fov * Math.PI) / 180;
    const visibleHeight = 2 * shot.dist * Math.tan(fovRad / 2);
    const visibleWidth = visibleHeight * aspect;

    const aimY = 1.2 + shot.aimOffsetY * visibleHeight;
    const horizontalOffset = COMPOSITION_OFFSET_FRAC * visibleWidth;
    const rightX = Math.cos(shot.angle);
    const rightZ = -Math.sin(shot.angle);

    const cycleElapsed = (now - this._cycleStartMs) / 1000;
    const driftX = Math.sin(cycleElapsed * 0.4) * 0.25;
    const driftZ = Math.cos(cycleElapsed * 0.3) * 0.25;

    const targetX = this._smoothX + rightX * horizontalOffset + driftX;
    const targetZ = this._smoothZ + rightZ * horizontalOffset + driftZ;

    this._camera.position.set(
      targetX + Math.sin(shot.angle) * shot.dist,
      shot.height,
      targetZ + Math.cos(shot.angle) * shot.dist
    );
    this._camera.lookAt(targetX, aimY, targetZ);

    const sunOffset = BATTLEFIELD_THEME.lights.keyPos;
    this._sun.position.set(
      this._smoothX + sunOffset[0],
      sunOffset[1],
      this._smoothZ + sunOffset[2]
    );
    this._sun.target.position.set(this._smoothX, 0, this._smoothZ);
    this._sun.target.updateMatrixWorld();
  }

  // --- view sync --------------------------------------------------------

  _updateViews(dt) {
    const cameraPos = this._camera.position;
    const unitsById = new Map();
    for (const entry of this._views) {
      entry.view.sync(cameraPos, unitsById, dt);
      // Hide the white rout flag. Menu battles are a demo — a routing
      // soldier would show a flag that reads as a bug. Forced every
      // frame because SoldierView.sync re-enables it while routing.
      entry.view.flag.visible = false;
    }
  }

  // --- sizing -----------------------------------------------------------

  _onResize() {
    if (!this._active) return;
    this._resize();
  }

  _resize() {
    let w = window.innerWidth;
    let h = window.innerHeight;
    const parent = this._canvas.parentNode;
    if (parent && parent.clientWidth > 0 && parent.clientHeight > 0) {
      w = parent.clientWidth;
      h = parent.clientHeight;
    }
    if (w === 0 || h === 0) return;
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }
}
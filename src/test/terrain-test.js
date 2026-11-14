// ===== terrain-test.js =====
// Standalone test page: generates every biome, captures 4 views each,
// shows them in a 2x2 grid inside each tile, and starts generating
// automatically on page load. A Stop button interrupts a running pass.
//
// Per-biome ambience (fog, sky colour, ambient particles) is applied
// the same way SceneSetup.applyBiomeVisuals + BattleRenderer._syncWeather
// do in-game. Fog near/far are computed PER VIEW from the camera
// distance so a bird's-eye overview sees the whole map, and a closeup
// has depth — the same behaviour as SceneSetup._updateViewRange does
// for the live camera.
//
// SCENERY BOOST
// Biome scenery (camps, graveyards, etc.) is authored at a very low
// density so it lands as an occasional landmark in a real battle. In
// this 600x600 test region a site shows up roughly once per 4-6 biomes,
// which the 4-view capture would mostly miss. The "Scenery 20×" header
// button toggles a runtime density multiplier via
// setSceneryDensityMultiplier(); when on, every biome regenerates and
// any site the harness can see appears in the shots. Turned off again
// restores the authored density exactly.
//
// LIGHTBOX
// Any captured screenshot can be clicked to open it at full resolution
// in a fullscreen overlay. Click anywhere or press Esc to close.

import * as THREE from 'three';
import { TerrainGenerator } from '../sim/TerrainGenerator.js';
import { TerrainView } from '../render/TerrainView.js';
import { WeatherParticles } from '../render/WeatherParticles.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { Biomes } from '../config/BiomeConfig.js';
import { BiomeVisuals } from '../config/BiomeVisuals.js';
import { setSceneryDensityMultiplier } from '../config/BiomeSceneryConfig.js';

const BIOME_ORDER = [
  'grassland', 'woodland', 'marsh', 'highland', 'arid',
  'ruins', 'river', 'steppes', 'jungle', 'wasteland', 'oasis', 'seaside',
  'volcanic'
];

const RENDER_W = 1000;
const RENDER_H = 750;
// 300-unit half-extent (600x600 world units). Large enough that the
// camera (at 316 units from target) sits INSIDE the terrain and the
// visible area is filled with obstacles/trees instead of the bare base
// plane. The old ±200 was small enough that the camera at 280 was
// outside the terrain — the overview shot showed a tiny terrain square
// floating in a sea of empty grass texture, which is the "empty
// boundaries" complaint.
//
// Cell count at 300 half-extent: 300x300 = 90,000 cells vs 40,000 at
// ±200. Generation is ~2.25x slower but still under 2s per biome.
const REGION = { minX: -300, maxX: 300, minZ: -300, maxZ: 300 };
const PRESET = 'normal';

const BASE_SKY = 0x87a8c9;

// Camera poses. Overview is a lower, further-out shot so the horizon
// (and therefore the sky) is visible at the top of the frame instead of
// a wall of terrain. The three closeups look north from three anchors.
// Camera poses. The overview sits INSIDE the ±300 terrain and looks
// across it — no "beyond terrain" void. Closeups are spread across the
// full Z-range of the enlarged terrain so all three see real obstacles
// instead of the empty border.
const VIEWS = [
  {
    key: 'overview', label: 'Overview',
    target: { x: 0, y: 20, z: 0 },
    camera: { x: 200, y: 160, z: 200 }
  },
  {
    key: 'south', label: 'South',
    target: { x: 0, y: 3, z: -180 },
    camera: { x: 0, y: 28, z: -250 }
  },
  {
    key: 'center', label: 'Center',
    target: { x: 0, y: 3, z: 0 },
    camera: { x: 0, y: 28, z: -80 }
  },
  {
    key: 'north', label: 'North',
    target: { x: 0, y: 3, z: 180 },
    camera: { x: 0, y: 28, z: 100 }
  }
];

// Multiplier applied while "Scenery 20×" mode is on. 20x is enough to
// push grassland's 0.15 sites / 10k cells up to 3.0 — visibly present
// in the overview shot without saturating the map with camps.
const SCENERY_BOOST = 20;

// ----- Shared renderer / scene / camera --------------------------------
const canvas = document.getElementById('renderCanvas');
canvas.width = RENDER_W;
canvas.height = RENDER_H;

const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, preserveDrawingBuffer: true
});
renderer.setSize(RENDER_W, RENDER_H, false);
renderer.setPixelRatio(1);
renderer.setClearColor(0x1a1a1a);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BASE_SKY);
scene.fog = new THREE.Fog(BASE_SKY, 200, 800);

const ambient = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffffff, 1.15);
sun.position.set(250, 450, 200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -400;
sun.shadow.camera.right = 400;
sun.shadow.camera.top = 400;
sun.shadow.camera.bottom = -400;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 1600;
sun.shadow.bias = -0.0005;
scene.add(sun);
scene.add(sun.target);

const camera = new THREE.PerspectiveCamera(55, RENDER_W / RENDER_H, 0.5, 2500);
camera.position.set(280, 180, 280);
camera.lookAt(0, 40, 0);

const groundMaterial = new THREE.MeshLambertMaterial({ color: 0x3f5528, map: null });
// (B) Base plane beneath and around the terrain. Sized larger than the
// terrain region so the plane is visible beyond the edge; coloured per
// biome by applyBiomeLook so the visual "ground" extends past the
// terrain mesh into the fog. Without this the space beyond the terrain
// showed the sky background — the "empty boundary" look.
const basePlaneGeo = new THREE.PlaneGeometry(2000, 2000, 1, 1);
basePlaneGeo.rotateX(-Math.PI / 2);
const basePlaneMat = new THREE.MeshLambertMaterial({ color: 0x3f5528 });
const basePlane = new THREE.Mesh(basePlaneGeo, basePlaneMat);
basePlane.position.y = -0.2;
basePlane.receiveShadow = true;
scene.add(basePlane);

const fakeSceneSetup = { scene, ground: { material: groundMaterial } };

const particles = new WeatherParticles(scene);

// ----- DOM references --------------------------------------------------
const gridEl = document.getElementById('grid');
const generateAllBtn = document.getElementById('generateAllBtn');
const stopBtn = document.getElementById('stopBtn');
const testModeBtn = document.getElementById('testModeBtn');
const statusEl = document.getElementById('status');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');

// ----- Tile state ------------------------------------------------------
const tileState = new Map();
let _aborted = false;

// Scenery boost flag. Off by default so the page opens on the authored
// densities; the header button toggles it and re-renders everything.
let _sceneryBoost = false;

// Pushes the current boost state into the config layer AND into the
// button's visual state. Called on boot (to force the multiplier back
// to 1 if a hot reload left it dirty) and on every toggle.
function applySceneryBoost() {
  setSceneryDensityMultiplier(_sceneryBoost ? SCENERY_BOOST : 1);
  testModeBtn.classList.toggle('active', _sceneryBoost);
  testModeBtn.textContent = _sceneryBoost ? 'Scenery 20× ON' : 'Scenery 20×';
}

// Sky + fog colour + particle kind. Fog near/far are set per-view in
// captureFromView, so this only touches the COLOUR half of fog.
function applyBiomeLook(biomeId) {
  const v = biomeId ? BiomeVisuals[biomeId] : null;
  const skyColor = (v && v.sky !== undefined) ? v.sky : BASE_SKY;
  scene.background = new THREE.Color(skyColor);
  if (scene.fog) {
    const fogColor = (v && v.fog && v.fog.color !== undefined)
      ? v.fog.color : skyColor;
    scene.fog.color = new THREE.Color(fogColor);
  }
  // Base plane tint matches the biome's grass colour so the empty space
  // past the terrain edge reads as "ground continuing", not sky showing
  // through. Uses the grass override when present; falls back to the
  // default green for grassland.
  const gc = v && v.ground && v.ground.grass;
  if (gc && gc.color) {
    basePlaneMat.color.setRGB(gc.color[0] / 255, gc.color[1] / 255, gc.color[2] / 255);
  } else {
    basePlaneMat.color.setHex(0x3f5528);
  }
  const kind = (v && v.particles) ? v.particles : null;
  particles.setKind(kind, 120);
  particles.update(0.1, { x: 0, z: 0 });
}

// Fog distance scaled to THIS view's camera-to-target distance.
//   near = 1.2 x dist x biomeScale   (target fully clear)
//   far  = 4.0 x dist x biomeScale   (haze fades to sky)
// biomeScale = clamp(0.003 / density, 0.55, 1.5). Dense biomes
// (jungle/marsh, density 0.0035) get 0.86; light biomes (seaside,
// density 0.0012) hit the 1.5 ceiling. So a dense-fog biome on an
// overview still shows the whole battlefield, and a closeup in a
// clear biome barely has haze.
function updateFogForView(view, biomeId) {
  if (!scene.fog) return;
  const v = biomeId ? BiomeVisuals[biomeId] : null;
  const density = (v && v.fog && typeof v.fog.density === 'number')
    ? v.fog.density : 0.002;
  const scale = Math.max(0.85, Math.min(1.4, 0.003 / density));

  // Fog is anchored to the FAR CORNER of the terrain (±REGION plus a
  // small margin), not to camera-to-target distance. The terrain edge
  // therefore always sits inside the clear window and the base plane
  // beyond it fades to the background colour. Without this anchoring
  // an overview zoomed the fog wall past the base plane and the plane
  // stayed visible — the "empty boundaries" bug.
  const margin = 10;
  const cx = view.camera.x;
  const cy = view.camera.y;
  const cz = view.camera.z;
  let maxD2 = 0;
  for (const px of [REGION.minX - margin, REGION.maxX + margin]) {
    for (const pz of [REGION.minZ - margin, REGION.maxZ + margin]) {
      const dx = px - cx;
      const dy = 5 - cy;
      const dz = pz - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > maxD2) maxD2 = d2;
    }
  }
  const farCornerDist = Math.sqrt(maxD2);

  scene.fog.near = farCornerDist * 0.6 * scale;
  scene.fog.far  = farCornerDist * 1.15 * scale;
}

function captureFromView(view, biomeId) {
  updateFogForView(view, biomeId);
  camera.position.set(view.camera.x, view.camera.y, view.camera.z);
  camera.lookAt(view.target.x, view.target.y, view.target.z);
  renderer.render(scene, camera);
  return canvas.toDataURL('image/png');
}

async function captureAllViews(biomeId, seed) {
  await new Promise(r => requestAnimationFrame(r));
  if (_aborted) return null;

  const t0 = performance.now();
  const terrain = TerrainGenerator.generate({
    seed, preset: PRESET,
    bounds: CombatConfig.mapBounds,
    region: REGION,
    biome: biomeId,
    ruinType: 'random'
  });
  const t1 = performance.now();
  if (_aborted) return null;

  applyBiomeLook(terrain.dominantBiome);

  const view = new TerrainView(fakeSceneSetup, terrain);
  const urls = [];
  for (const viewDef of VIEWS) {
    if (_aborted) break;
    urls.push(captureFromView(viewDef, terrain.dominantBiome));
  }
  view.dispose();
  const t2 = performance.now();

  if (urls.length === VIEWS.length) {
    // eslint-disable-next-line no-console
    console.log(
      `%c[terrain-test] ${biomeId} seed=${seed} boost=${_sceneryBoost ? SCENERY_BOOST + 'x' : 'off'} ` +
      `gen=${(t1 - t0).toFixed(0)}ms ` +
      `4x render+cap=${(t2 - t1).toFixed(0)}ms ` +
      `total=${(t2 - t0).toFixed(0)}ms`,
      'color:#8c8;font-weight:bold'
    );
  }

  return urls.length === VIEWS.length ? urls : null;
}

function buildTile(biomeId) {
  const def = Biomes[biomeId];
  const tile = document.createElement('div');
  tile.className = 'tile';

  const header = document.createElement('div');
  header.className = 'tile-header';

  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = def.displayName;
  header.appendChild(name);

  const seedLabel = document.createElement('span');
  seedLabel.className = 'tile-seed';
  seedLabel.textContent = 'seed ?';
  header.appendChild(seedLabel);

  const regen = document.createElement('button');
  regen.className = 'regen-btn';
  regen.title = 'Regenerate this biome';
  regen.textContent = '↻';
  header.appendChild(regen);

  tile.appendChild(header);

  const imageGrid = document.createElement('div');
  imageGrid.className = 'tile-image-grid';

  const cells = [];
  for (const viewDef of VIEWS) {
    const cell = document.createElement('div');
    cell.className = 'tile-cell';

    const img = document.createElement('img');
    img.alt = `${def.displayName} ${viewDef.label}`;
    img.style.display = 'none';
    cell.appendChild(img);

    const label = document.createElement('div');
    label.className = 'tile-cell-label';
    label.textContent = viewDef.label;
    cell.appendChild(label);

    const loading = document.createElement('div');
    loading.className = 'tile-loading';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    loading.appendChild(spinner);
    const loadingText = document.createElement('div');
    loadingText.textContent = 'Pending';
    loading.appendChild(loadingText);
    cell.appendChild(loading);

    imageGrid.appendChild(cell);
    cells.push({ img, loading, loadingText });
  }

  tile.appendChild(imageGrid);
  gridEl.appendChild(tile);

  const state = {
    seed: 1, tileEl: tile, cells, regen, seedLabel, generating: false
  };
  tileState.set(biomeId, state);
  return state;
}

async function renderTile(biomeId) {
  const state = tileState.get(biomeId);
  if (!state || state.generating) return;
  if (_aborted) return;

  state.generating = true;
  state.regen.disabled = true;
  state.seedLabel.textContent = `seed ${state.seed}`;
  state.tileEl.classList.remove('error');

  for (const c of state.cells) {
    c.loading.classList.remove('hidden');
    c.loadingText.textContent = 'Generating…';
    c.img.style.display = 'none';
  }

  try {
    const urls = await captureAllViews(biomeId, state.seed);
    if (!urls) {
      for (const c of state.cells) {
        c.loadingText.textContent = 'Stopped';
      }
      return;
    }
    for (let i = 0; i < state.cells.length; i++) {
      const c = state.cells[i];
      c.img.src = urls[i];
      c.img.style.display = 'block';
      c.loading.classList.add('hidden');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[terrain-test] ${biomeId} failed:`, err);
    for (const c of state.cells) {
      c.loadingText.textContent = `Error: ${err.message}`;
    }
    state.tileEl.classList.add('error');
  } finally {
    state.generating = false;
    state.regen.disabled = false;
  }
}

function parseSeedInput() {
  const raw = document.getElementById('seedInput').value;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function setStatus(text) {
  statusEl.textContent = text;
}

// One toggle point for every header button that shouldn't fire while a
// generation pass is running. Stop gets the inverse: it is ONLY useful
// mid-generation.
function setGenerating(on) {
  generateAllBtn.disabled = on;
  stopBtn.disabled = !on;
  testModeBtn.disabled = on;
}

async function generateAll() {
  _aborted = false;
  const baseSeed = parseSeedInput();
  setGenerating(true);

  for (let i = 0; i < BIOME_ORDER.length; i++) {
    if (_aborted) break;
    const biomeId = BIOME_ORDER[i];
    const state = tileState.get(biomeId);
    state.seed = baseSeed;
    setStatus(`Generating ${i + 1}/${BIOME_ORDER.length}: ${Biomes[biomeId].displayName}…`);
    await renderTile(biomeId);
  }

  setGenerating(false);

  if (_aborted) {
    setStatus('Stopped.');
  } else {
    const boostLabel = _sceneryBoost ? ` [scenery ${SCENERY_BOOST}×]` : '';
    setStatus(`Done. ${BIOME_ORDER.length} biomes, ${BIOME_ORDER.length * VIEWS.length} shots${boostLabel}.`);
  }
}

function regenerateOne(biomeId) {
  if (_aborted) return;
  const state = tileState.get(biomeId);
  if (!state) return;
  state.seed += 1;
  renderTile(biomeId);
}

// ----- Lightbox ---------------------------------------------------------

function openLightbox(src) {
  lightboxImg.src = src;
  lightbox.classList.add('active');
}

function closeLightbox() {
  lightbox.classList.remove('active');
  // Clear the src so the previous full-size image is released from
  // memory on the next paint rather than held until the next open.
  lightboxImg.src = '';
}

function wireLightbox() {
  // Event delegation on the tile grid — every captured screenshot has
  // cursor: zoom-in, and clicking one opens the enlarged view. Guarded
  // against clicks on the loading overlay (image is display:none while
  // pending) and on the tile header (regen button, seed label).
  gridEl.addEventListener('click', (e) => {
    const img = e.target.closest('.tile-cell img');
    if (!img) return;
    if (img.style.display === 'none') return;
    if (!img.src) return;
    openLightbox(img.src);
  });

  // Click anywhere on the overlay (image or backdrop) closes it. The
  // image is a child of the overlay so the same handler catches both.
  lightbox.addEventListener('click', closeLightbox);

  // Escape as the keyboard equivalent.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox.classList.contains('active')) {
      closeLightbox();
    }
  });
}

// ----- Boot -------------------------------------------------------------

function boot() {
  for (const biomeId of BIOME_ORDER) {
    const state = buildTile(biomeId);
    state.regen.addEventListener('click', () => regenerateOne(biomeId));
  }

  generateAllBtn.addEventListener('click', generateAll);

  stopBtn.addEventListener('click', () => {
    _aborted = true;
    setStatus('Stopping…');
  });

  testModeBtn.addEventListener('click', () => {
    _sceneryBoost = !_sceneryBoost;
    applySceneryBoost();
    // Regenerate immediately at the new density so the effect is
    // visible without the user having to click Generate All again.
    generateAll();
  });

  wireLightbox();

  // Reset the multiplier to 1 on boot — a hot reload during a boosted
  // session would otherwise leak the 20x into the next page load.
  applySceneryBoost();

  setStatus('Auto-generating on load…');
  requestAnimationFrame(() => generateAll());
}

boot();
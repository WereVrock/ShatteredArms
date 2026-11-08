// ===== CampaignCampView.js =====
// Background 3D battle camp for the campaign screens.
//
// LIVES INSIDE #mainMenu, NOT ON BODY. The canvas is parented to #mainMenu
// at position:absolute; inset:0; z-index:0, and the caller raises the
// .menu-panel to z-index:1 (see CampaignFlow._attachCampToMenu). The camp
// therefore paints over #mainMenu's background but under the panel.
//
// TWO MODES (SettingsStore.campView3d, toggled by CampViewToggle):
//   animated  the scene is rendered at ~30 fps (flames, smoke, banners and
//             wisps move, the camera sways slowly);
//   still     the scene is rendered ONCE into a JPEG snapshot shown in an
//             <img>; no render loop runs. The snapshot is retaken only
//             when the faction or the window size changes.
//
// The camera distance is solved from the window size so the two camp
// clusters land in the free bands beside the menu panel (CampCameraRig).
//
// Cost: one WebGLRenderer, no MSAA, pixel ratio capped, no shadows, static
// geometry merged into a few draw calls, and no RAF loop while hidden.

import * as THREE from 'three';
import { buildCamp } from './CampProps.js';
import { CampCameraRig } from './camp/CampCameraRig.js';

const FRAME_MS = 1000 / 30;
const PIXEL_RATIO_CAP = 1.25;
const STILL_TIME = 3.2;
const SNAPSHOT_QUALITY = 0.9;
const RESIZE_DEBOUNCE_MS = 120;

// Lights were tuned for the legacy lighting model. From r155 three no
// longer multiplies light intensity by PI, so compensate.
const LIGHT_GAIN = (parseInt(THREE.REVISION, 10) >= 155) ? Math.PI : 1;

export class CampaignCampView {
  constructor() {
    this._faction = null;
    this._build = null;
    this._visible = false;
    this._animated = true;
    this._rafId = null;
    this._lastFrameMs = 0;
    this._stillDirty = true;
    this._resizeTimer = null;
    this._w = 0;
    this._h = 0;

    const layer = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'pointer-events:none',
      'z-index:0',
      'display:none'
    ].join(';');

    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = layer;

    this._img = document.createElement('img');
    this._img.alt = '';
    this._img.draggable = false;
    this._img.style.cssText = layer + ';object-fit:cover';

    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: false,
      alpha: false
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));

    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(44, 1, 0.2, 1200);
    this._rig = new CampCameraRig(this._camera);

    this._hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8 * LIGHT_GAIN);
    this._key = new THREE.DirectionalLight(0xffffff, 1.0 * LIGHT_GAIN);
    this._scene.add(this._hemi);
    this._scene.add(this._key);

    this._tickBound = (now) => this._tick(now);
    this._onResize = () => this._handleResize();
    window.addEventListener('resize', this._onResize);

    console.info('[camp] CampaignCampView created');
  }

  // --- attachment -------------------------------------------------------
  //
  // The caller re-inserts the camp whenever the host element has been
  // cleared. Both layers are inserted; only one is displayed at a time.

  attachTo(parentEl) {
    if (!parentEl) return;
    parentEl.insertBefore(this._img, parentEl.firstChild);
    parentEl.insertBefore(this._canvas, parentEl.firstChild);
    if (!this._visible) return;
    if (this._animated) {
      this._syncSize();
    } else {
      const t = this._targetSize();
      if (this._stillDirty || t.w !== this._w || t.h !== this._h) this._renderStill();
    }
  }

  detach() {
    if (this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    if (this._img.parentNode) this._img.parentNode.removeChild(this._img);
  }

  getCanvas() { return this._canvas; }
  isVisible() { return this._visible; }

  // --- content ----------------------------------------------------------

  setFaction(factionId) {
    if (factionId === this._faction && this._build) return;
    this._faction = factionId;
    if (this._build) {
      this._scene.remove(this._build.group);
      this._build.dispose();
    }
    this._build = buildCamp(factionId);
    this._scene.add(this._build.group);
    this._applyTheme(this._build.theme);
    this._stillDirty = true;
    console.info(`[camp] faction set to "${factionId}"`);
    if (this._visible) this._applyMode();
  }

  setAnimated(on) {
    const next = !!on;
    if (next === this._animated) return;
    this._animated = next;
    if (this._visible) this._applyMode();
  }

  _applyTheme(theme) {
    const fogColor = new THREE.Color(theme.fog.color);
    this._scene.background = fogColor;
    this._scene.fog = new THREE.Fog(fogColor, theme.fog.near, theme.fog.far);

    const l = theme.lights;
    this._hemi.color.set(l.hemiSky);
    this._hemi.groundColor.set(l.hemiGround);
    this._hemi.intensity = l.hemi * LIGHT_GAIN;
    this._key.color.set(l.keyColor);
    this._key.intensity = l.key * LIGHT_GAIN;
    this._key.position.set(l.keyPos[0], l.keyPos[1], l.keyPos[2]);
  }

  // --- visibility / loop ------------------------------------------------

  show() {
    if (this._visible) return;
    this._visible = true;
    this._applyMode();
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this._stopLoop();
    if (this._resizeTimer) { clearTimeout(this._resizeTimer); this._resizeTimer = null; }
    this._canvas.style.display = 'none';
    this._img.style.display = 'none';
  }

  dispose() {
    this.hide();
    window.removeEventListener('resize', this._onResize);
    if (this._build) {
      this._scene.remove(this._build.group);
      this._build.dispose();
      this._build = null;
    }
    this._renderer.dispose();
    this.detach();
    console.info('[camp] CampaignCampView disposed');
  }

  // --- diagnostics ------------------------------------------------------

  getDiagnostics() {
    const rect = this._canvas.getBoundingClientRect();
    return {
      visible: this._visible,
      animated: this._animated,
      faction: this._faction,
      canvasInDom: !!this._canvas.parentNode,
      parentId: this._canvas.parentNode ? this._canvas.parentNode.id : null,
      canvasRect: { w: rect.width, h: rect.height },
      bufferSize: { w: this._canvas.width, h: this._canvas.height },
      pixelRatio: this._renderer.getPixelRatio(),
      stillReady: !!this._img.src && !this._stillDirty,
      cameraDistance: this._rig.distance
    };
  }

  // --- internals --------------------------------------------------------

  _applyMode() {
    if (!this._visible) return;
    if (this._animated) {
      this._img.style.display = 'none';
      this._canvas.style.display = 'block';
      this._syncSize();
      this._startLoop();
    } else {
      this._stopLoop();
      const t = this._targetSize();
      if (this._stillDirty || t.w !== this._w || t.h !== this._h) this._renderStill();
      this._canvas.style.display = 'none';
      this._img.style.display = 'block';
    }
  }

  _targetSize() {
    let w = window.innerWidth;
    let h = window.innerHeight;
    const parent = this._canvas.parentNode;
    if (parent && parent.clientWidth > 0 && parent.clientHeight > 0) {
      w = parent.clientWidth;
      h = parent.clientHeight;
    }
    return { w, h };
  }

  // Resizes renderer and camera rig when the target size changed.
  _syncSize() {
    const { w, h } = this._targetSize();
    if (w === 0 || h === 0 || (w === this._w && h === this._h)) return false;
    this._w = w;
    this._h = h;
    this._renderer.setSize(w, h, false);
    this._rig.configure(w, h);
    return true;
  }

  // Renders one frame and stores it as a JPEG for the still mode.
  _renderStill() {
    if (!this._build) return;
    this._syncSize();
    this._build.update(STILL_TIME);
    this._rig.update(STILL_TIME, false);
    this._renderer.render(this._scene, this._camera);
    try {
      this._img.src = this._canvas.toDataURL('image/jpeg', SNAPSHOT_QUALITY);
    } catch (e) {
      console.warn('[camp] snapshot failed', e);
    }
    this._stillDirty = false;
  }

  _handleResize() {
    if (!this._visible) return;
    if (this._animated) {
      if (this._syncSize()) this._renderLive(performance.now());
      return;
    }
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this._resizeTimer = null;
      if (this._visible && !this._animated) this._renderStill();
    }, RESIZE_DEBOUNCE_MS);
  }

  _startLoop() {
    if (this._rafId !== null) return;
    this._lastFrameMs = 0;
    this._rafId = requestAnimationFrame(this._tickBound);
  }

  _stopLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _tick(now) {
    if (!this._visible || !this._animated) { this._rafId = null; return; }
    this._rafId = requestAnimationFrame(this._tickBound);
    if (now - this._lastFrameMs < FRAME_MS) return;
    this._lastFrameMs = now;
    this._syncSize();
    this._renderLive(now);
  }

  _renderLive(nowMs) {
    if (!this._build) return;
    const t = nowMs / 1000;
    this._build.update(t);
    this._rig.update(t, true);
    this._renderer.render(this._scene, this._camera);
  }
}
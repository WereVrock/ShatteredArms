// Renders one small PNG per distinct (unitTypeDef, bodyVariant) pair so the
// army bar can show a composite unit icon (weapon + optional shield / horse
// head / skull — see UnitIconComposer).
//
// Rendering path:
//   1. Build a fresh scratch THREE.Scene containing only the composed icon.
//   2. Render into an offscreen WebGLRenderTarget at 2x the final size.
//   3. Read the pixels back, flip vertically (WebGL origin is bottom-left,
//      canvas origin is top-left), and downsample 2x into a canvas.
//   4. Export the canvas as a PNG data URL.
//
// Supersampling (render at 256, output 128) is used instead of MSAA on the
// render target because three.js r160's readRenderTargetPixels warns and
// returns early on multisampled targets. Bilinear downsampling in the canvas
// gives the same anti-aliasing benefit without touching that unsupported path.
//
// The main renderer is reused — the capture runs once, synchronously, before
// the first requestAnimationFrame tick — and its render target, clear colour,
// clear alpha, and autoClear flag are saved and restored around the loop so
// the live view is never affected.
//
// RESOURCE OWNERSHIP
// ------------------------------------------------------------------
// All geometries and materials used by a composed icon come from MeshCache
// (see src/render/mesh/MeshCache.js), which is shared with the live soldier
// models. The captured icon therefore must NOT be disposed after use —
// disposing would rip shared resources out from under the running game.
// The icon group is simply removed from the scratch scene; the cache owns
// the underlying GPU resources for the lifetime of the page.
//
// UnitType lookup note: Unit itself does not carry a unitTypeDef — only its
// Soldiers do. All soldiers in a Unit share one definition (see
// FormationFactory), so the type is read from the first soldier.
import * as THREE from 'three';
import { UnitIconComposer } from './UnitIconComposer.js';

const RENDER_SIZE = 256;
const THUMB_SIZE = 128;

// Frame half-extent in world units. The composed icon is laid out within a
// 2.1-unit square (see UnitIconComposer layout constants), and the camera
// frustum matches so the content fills the frame.
const VIEW_HALF = 1.05;
const CAMERA_DISTANCE = 10;

export class UnitThumbnailCapture {
  constructor(sceneSetup) {
    this.sceneSetup = sceneSetup;
  }

  // Renders one thumbnail per distinct (unitTypeDef, undead) pair on the
  // given team's units.
  //
  // @returns {Map<Object, Map<string, string>>}
  //   Outer key: the unitTypeDef object (reference identity — every soldier
  //   and unit of one type shares the same definition object).
  //   Inner key: body variant string, 'blob' or 'skeleton'.
  //   Value: a PNG data URL.
  captureForTeam(units, teamId) {
    const result = new Map();
    if (!units || units.length === 0) return result;

    const renderer = this.sceneSetup.renderer;
    const scene = this._buildScene();
    const camera = this._buildCamera();
    const target = this._buildRenderTarget();

    const prevTarget = renderer.getRenderTarget();
    const prevClearColor = new THREE.Color();
    renderer.getClearColor(prevClearColor);
    const prevClearAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;

    // Transparent background: the icon composites onto the card's own
    // backing rather than a baked-in box. scene.background is left null so
    // three.js falls back to the renderer's clear colour.
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;

    const pixels = new Uint8Array(RENDER_SIZE * RENDER_SIZE * 4);

    for (const unit of units) {
      if (unit.teamId !== teamId) continue;

      const unitTypeDef = this._unitTypeOf(unit);
      if (!unitTypeDef) continue;

      const bodyVariant = unit.isUndead ? 'skeleton' : 'blob';
      let inner = result.get(unitTypeDef);
      if (inner && inner.has(bodyVariant)) continue;
      if (!inner) {
        inner = new Map();
        result.set(unitTypeDef, inner);
      }

      const icon = UnitIconComposer.compose(unitTypeDef, unit.isUndead);
      scene.add(icon);

      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, RENDER_SIZE, RENDER_SIZE, pixels);
      renderer.setRenderTarget(prevTarget);

      inner.set(bodyVariant, this._pixelsToDataUrl(pixels));

      // Detach from the scratch scene; do NOT dispose. Every geometry and
      // material in the icon is owned by MeshCache and shared with the live
      // soldier models — disposing here would break every soldier of this
      // unit type for the rest of the session.
      scene.remove(icon);
    }

    renderer.setClearColor(prevClearColor, prevClearAlpha);
    renderer.autoClear = prevAutoClear;
    target.dispose();

    return result;
  }

  // The unit's shared UnitType. All soldiers in a unit are built from one
  // definition, so the first soldier's is the unit's. Returns null on an
  // empty unit so the caller can skip cleanly rather than throwing.
  _unitTypeOf(unit) {
    const lead = unit.soldiers && unit.soldiers[0];
    return lead ? lead.unitTypeDef : null;
  }

  _buildScene() {
    const scene = new THREE.Scene();
    scene.background = null;

    // Frontal rig: the icon is a flat composition facing the camera, so a
    // strong ambient plus a single key from the front-upper-right is all
    // that's needed. A small back-left fill keeps the shield's rim and the
    // horse head's underside from going to black.
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));

    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(2, 3, 5);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-3, -2, 3);
    scene.add(fill);

    return scene;
  }

  // Straight-on orthographic camera looking down -Z. Every element in the
  // composition is pre-oriented to face this direction (see UnitIconComposer),
  // so no camera tilt is needed and each shape shows its best silhouette.
  _buildCamera() {
    const cam = new THREE.OrthographicCamera(
      -VIEW_HALF, VIEW_HALF,
      VIEW_HALF, -VIEW_HALF,
      0.1, 60
    );
    cam.position.set(0, 0, CAMERA_DISTANCE);
    cam.lookAt(0, 0, 0);
    return cam;
  }

  _buildRenderTarget() {
    // No `samples` — readRenderTargetPixels on a multisampled target is not
    // supported in three.js r160 (warns and returns). Anti-aliasing comes
    // from the 2x supersample + bilinear downsample below.
    return new THREE.WebGLRenderTarget(RENDER_SIZE, RENDER_SIZE, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat
    });
  }

  // WebGL reads back bottom-up; canvas ImageData is top-down. Flip rows while
  // copying, then downsample into the final canvas so the result is not
  // upside down and is anti-aliased by the browser's bilinear filter.
  _pixelsToDataUrl(pixels) {
    const src = document.createElement('canvas');
    src.width = RENDER_SIZE;
    src.height = RENDER_SIZE;

    const srcCtx = src.getContext('2d');
    const imageData = srcCtx.createImageData(RENDER_SIZE, RENDER_SIZE);
    const dst = imageData.data;
    const rowBytes = RENDER_SIZE * 4;

    for (let y = 0; y < RENDER_SIZE; y++) {
      const srcRow = (RENDER_SIZE - 1 - y) * rowBytes;
      const dstRow = y * rowBytes;
      dst.set(pixels.subarray(srcRow, srcRow + rowBytes), dstRow);
    }
    srcCtx.putImageData(imageData, 0, 0);

    const out = document.createElement('canvas');
    out.width = THUMB_SIZE;
    out.height = THUMB_SIZE;

    const outCtx = out.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(src, 0, 0, THUMB_SIZE, THUMB_SIZE);

    return out.toDataURL('image/png');
  }
}
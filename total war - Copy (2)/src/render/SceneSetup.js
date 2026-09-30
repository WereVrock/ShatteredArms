// ===== SceneSetup.js =====
import * as THREE from 'three';
import { GrassField } from './GrassField.js';
import { CombatConfig } from '../config/CombatConfig.js';

// Fog / sky colour. Used for scene.background and scene.fog — one constant
// so the two can never drift.
const SKY_COLOR = 0x87a8c9;

// Dense fog (the "fog on" state). Near is where fog starts, far is where it
// is fully opaque. The far value is tuned so the ground plane's actual edge
// is fully hidden from any camera position the player can reach, while the
// field-boundary strips stay clearly visible.
const FOG_NEAR = 40;
const FOG_FAR_ON = 200;

// "Fog off" keeps the fog object in the scene — setting scene.fog to null
// would force a shader recompile on every material in the scene, which is a
// visible hitch. Instead the far plane is pushed so far out that the fog
// factor is effectively zero at any distance the player can see.
const FOG_FAR_OFF = 1e6;

// Sun offset from the camera target. Used by the directional light (which
// casts shadows).
const SUN_OFFSET = new THREE.Vector3(40, 55, 25);

// Extra world units of grass beyond the field boundary on each side, so the
// boundary strips sit on grass rather than right at the edge of the scatter.
const GRASS_MARGIN = 20;

// World-space width of the field-boundary strips. 0.5 is roughly 10x the
// "1 pixel at battle zoom" a LineSegments would give — visible from the
// default camera distance without being obtrusive.
const FIELD_EDGE_THICKNESS = 0.5;

// Builds the base 3D scene: camera, lights, ground, grass, field boundary.
// No game logic.
// Accepts optional initial camera params so callers can start the view
// focused on their own army (e.g. behind the player's units).
//
// The playable field boundary is read from CombatConfig.mapBounds — the
// SAME box RoutingExtractionSystem uses to decide when a routing soldier
// has left the field. That is the only real map edge in the sim, so the
// visual boundary indicator and the actual rule-driven boundary can never
// drift apart.
//
// Settings: the constructor accepts an optional `settings` object (the
// shape returned by SettingsStore.get()) and applies it immediately. Call
// applySettings() again at any time to change shadows, ground texture,
// grass, field boundary, or fog live. This class knows nothing about
// SettingsStore — main.js wires the two together with a subscribe() call
// so any panel anywhere can flip a setting and the scene reacts.
export class SceneSetup {
  constructor(canvas, options = {}) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    // Shadows: PCFSoftShadowMap gives a soft penumbra at the resolution set
    // below. If the shadow pass becomes the bottleneck at high soldier
    // counts, switch to THREE.PCFShadowMap and/or drop mapSize to 1024.
    //
    // shadowMap.enabled is set ONCE here and never toggled at runtime.
    // Toggling it forces a full material recompile, which causes a visible
    // hitch. Runtime shadow on/off goes through sun.castShadow instead —
    // see applySettings.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_COLOR);

    // Boundary fog. Same colour as the background, so a fully-fogged ground
    // plane fades into the sky at the horizon and the field's hard rectangle
    // edge is never visible. The far plane is toggled by applySettings.
    this.scene.fog = new THREE.Fog(SKY_COLOR, FOG_NEAR, FOG_FAR_ON);

    // Camera far plane at 300 comfortably contains the ground plane's
    // 600-unit extent plus soldier silhouettes at the far edge.
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);

    // Camera rig: target point on the ground + distance/angle, so controls can orbit it.
    const target = options.cameraTarget || { x: 0, z: 0 };
    this.cameraTarget = { x: target.x, z: target.z };
    this.cameraDistance = options.cameraDistance ?? 14;
    this.cameraYaw = options.cameraYaw ?? 0;
    this.cameraPitch = options.cameraPitch ?? 0.9; // radians above horizontal; ~51deg gives a real 3D read

    this.sun = null;
    this.ground = null;
    this.grassField = null;
    this.fieldEdge = null;
    // Built lazily on first use so a user with groundTexture:false from the
    // start never pays for the canvas generation.
    this._groundTexture = null;

    this._addLights();
    this._addGround();

    // Grass fills the actual map bounds plus a margin on every side. Square
    // scatter across that rectangle means the boundary strips sit on grass
    // all the way to their corners.
    this.grassField = new GrassField(this.scene, {
      count: 5000,
      bounds: CombatConfig.mapBounds,
      margin: GRASS_MARGIN
    });

    // Bright strips at the map bounds, marking where the field ends.
    this._addFieldEdge();

    if (options.settings) {
      this.applySettings(options.settings);
    } else {
      // No settings supplied — default to everything on, matching DEFAULTS
      // in SettingsStore. Callers who pass settings explicitly skip this.
      this.applySettings({
        shadows: true,
        groundTexture: true,
        grass: true,
        fieldEdge: true,
        fog: true
      });
    }

    this._updateCameraTransform();
    this._handleResize();
    window.addEventListener('resize', () => this._handleResize());
  }

  // Applies a settings object. Safe to call repeatedly. Unknown keys are
  // ignored, so a caller may pass the whole SettingsStore object without
  // filtering.
  applySettings(settings) {
    const shadowsOn = !!settings.shadows;
    const textureOn = !!settings.groundTexture;
    const grassOn = !!settings.grass;
    const fogOn = !!settings.fog;

    if (this.sun) {
      // Toggling castShadow is the cheap runtime lever — three.js simply
      // skips the shadow render pass when it's false, with no material
      // recompile.
      this.sun.castShadow = shadowsOn;
    }

    if (this.scene.fog) {
      // Fog near stays constant; only far moves. FOG_FAR_OFF is so large
      // that the fog factor is ~0 at any visible distance, which reads as
      // "no fog" without removing the fog object (and triggering a shader
      // recompile on every material in the scene).
      this.scene.fog.far = fogOn ? FOG_FAR_ON : FOG_FAR_OFF;
    }

    if (this.grassField) {
      this.grassField.setVisible(grassOn);
    }

    if (this.fieldEdge) {
      this.fieldEdge.visible = !!settings.fieldEdge;
    }

    if (this.ground) {
      const mat = this.ground.material;
      if (textureOn) {
        mat.map = this._ensureGroundTexture();
        // White base so the map shows its own colours unfiltered.
        mat.color.setHex(0xffffff);
      } else {
        mat.map = null;
        // Flat grass green when the texture is off — matches the texture's
        // base fill so toggling reads as "remove detail", not "change biome".
        mat.color.setHex(0x3f5528);
      }
      // Swapping map null<->texture changes the shader program, so the
      // material must be told to recompile. This is a one-off hitch on
      // toggle, not a per-frame cost.
      mat.needsUpdate = true;
    }
  }

  _addLights() {
    // Hemisphere light: sky-tinted light from above, ground-tinted bounce
    // from below. Reads as natural ambient variation rather than a flat
    // gray wash — cheaper and prettier than ambient + a second directional.
    const hemi = new THREE.HemisphereLight(0xbcd4ee, 0x4a5a30, 0.9);
    hemi.position.set(0, 20, 0);
    this.scene.add(hemi);

    // The sun: warm-tinted directional light with shadows. Its offset from
    // the camera target comes from SUN_OFFSET.
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.15);
    sun.castShadow = true;

    // Orthographic shadow frustum, sized to cover the battle area around
    // the camera target. 90x90 world units at 2048² gives ~22 texels per
    // unit — enough to resolve soldier silhouettes at battle zoom without
    // being expensive. The frustum follows the camera target every frame
    // (see _updateCameraTransform) so a scrolling battlefield stays lit.
    const SHADOW_EXTENT = 45;
    sun.shadow.camera.left   = -SHADOW_EXTENT;
    sun.shadow.camera.right  =  SHADOW_EXTENT;
    sun.shadow.camera.top    =  SHADOW_EXTENT;
    sun.shadow.camera.bottom = -SHADOW_EXTENT;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far  = 160;
    sun.shadow.mapSize.set(2048, 2048);

    // normalBias handles the ground-plane acne; the tiny negative bias
    // keeps contact shadows tight without visible peter-panning under
    // soldier feet.
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;

    // Position + target are set in _updateCameraTransform so the frustum
    // stays centered on the camera target. Both are added to the scene so
    // three.js updates their world matrices during the render pass.
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  _addGround() {
    // Enlarged far past the playable field so the ground plane's actual
    // edge is always beyond the fog wall — the field reads as extending
    // into the distance rather than ending at a visible rectangle.
    // Segment count stays at 64x64: vertex-level Lambert shading on a
    // plane this size is imperceptibly different at higher counts, and
    // the texture masks any residual vertex gradient.
    const GROUND_EXTENT = 600;
    const geo = new THREE.PlaneGeometry(GROUND_EXTENT, GROUND_EXTENT, 64, 64);
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: null
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;
  }

  // Bright strips at CombatConfig.mapBounds — the same box
  // RoutingExtractionSystem uses to decide when a routing soldier has left
  // the field. This is the actual, rule-driven map edge, not a decorative
  // approximation.
  //
  // Rendered as four flat ground-level quads, NOT a LineSegments.
  // LineBasicMaterial.linewidth is ignored on most WebGL platforms, so a
  // "line" is always 1 pixel wide regardless of what you set — at battle
  // zoom on a 600-unit ground plane, 1 pixel is effectively invisible.
  // Ground quads of a real world-space width read clearly from any camera
  // distance.
  //
  // depthWrite is off so the strips do not z-fight the ground plane. A
  // small Y offset (0.06) lifts them above the ground; render order places
  // them under the unit selection rings but above the ground decals.
  _addFieldEdge() {
    const b = CombatConfig.mapBounds;
    const y = 0.06;
    const thickness = FIELD_EDGE_THICKNESS;

    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;

    const group = new THREE.Group();

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd060,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    // Front and back edges run along the X axis (varying X, fixed Z).
    for (const z of [b.minZ, b.maxZ]) {
      const geo = new THREE.PlaneGeometry(w, thickness);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, y, z);
      mesh.renderOrder = 996;
      group.add(mesh);
    }

    // Left and right edges run along the Z axis (varying Z, fixed X).
    for (const x of [b.minX, b.maxX]) {
      const geo = new THREE.PlaneGeometry(thickness, d);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, y, cz);
      mesh.renderOrder = 996;
      group.add(mesh);
    }

    // The whole group is only a handful of units; culling it as one unit
    // would drop the far edges when only the near ones are visible. Disable
    // frustum culling so every edge renders whenever any part is on-screen.
    group.frustumCulled = false;
    this.scene.add(group);
    this.fieldEdge = group;
  }

  // Lazily builds the ground texture on first request. Cached for the
  // lifetime of the scene.
  _ensureGroundTexture() {
    if (this._groundTexture) return this._groundTexture;
    this._groundTexture = this._createGroundTexture();
    return this._groundTexture;
  }

  // Procedural ground texture: a mottled grass field drawn once to a
  // canvas. No external asset, no network fetch.
  //
  // Tileable by construction: every drawn circle is stamped at nine offsets
  // (one per combination of -SIZE / 0 / +SIZE on each axis), so any circle
  // crossing an edge reappears on the opposite edge. The canvas clips the
  // out-of-bounds copies, so only the ones that actually wrap paint. This
  // removes the visible seam that a naive random-scatter texture produces
  // when it repeats.
  //
  // Seeded so the texture is identical every page load — easier to reason
  // about when tuning, and no risk of a "lucky roll" changing the look.
_createGroundTexture() {
    const SIZE = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');

    // Base grass colour — matches the flat fill used when the texture is
    // off, so toggling reads as "remove detail" rather than "change biome".
    ctx.fillStyle = '#3f5528';
    ctx.fillRect(0, 0, SIZE, SIZE);

    const rng = this._mulberry32(0xC0FFEE);

    // Pre-baked mottling sprites.
    //
    // The previous build drew each of 5500 patches as a fresh arc()+fill()
    // pair, at a per-patch colour interpolated between two greens. That is
    // a path build, a tessellation, and a generic rasteriser fill per
    // patch — and it was multiplied by nine because every patch was stamped
    // at all nine wraparound offsets whether or not the copy touched the
    // canvas. Roughly 49,500 arc+fill calls, most of which the canvas
    // clipped away.
    //
    // Here the patch SHAPE and a quantised patch COLOUR are baked once into
    // a small sprite canvas, and every patch is a single drawImage blit.
    // drawImage of a cached bitmap skips the path machinery entirely, and
    // the colour quantisation — 16 evenly-spaced shades along the exact
    // same linear gradient the original per-patch lerp used — is invisible
    // at alpha 0.28 with this much overlap.
    const MOTTLE_SHADES = 16;
    const MOTTLE_MAX_RADIUS = 52;   // original max was 8 + 1.0 * 44
    const sprites = [];
    {
      const spriteSize = MOTTLE_MAX_RADIUS * 2;
      const r0 = 0x36, g0 = 0x48, b0 = 0x22;
      const r1 = 0x5c, g1 = 0x72, b1 = 0x38;
      for (let i = 0; i < MOTTLE_SHADES; i++) {
        const t = i / (MOTTLE_SHADES - 1);
        const rr = Math.round(r0 + (r1 - r0) * t);
        const gg = Math.round(g0 + (g1 - g0) * t);
        const bb = Math.round(b0 + (b1 - b0) * t);
        const c = document.createElement('canvas');
        c.width = spriteSize;
        c.height = spriteSize;
        const cx = c.getContext('2d');
        cx.fillStyle = `rgb(${rr}, ${gg}, ${bb})`;
        cx.beginPath();
        cx.arc(MOTTLE_MAX_RADIUS, MOTTLE_MAX_RADIUS, MOTTLE_MAX_RADIUS, 0, Math.PI * 2);
        cx.fill();
        sprites.push(c);
      }
    }

    // Returns the set of axis offsets a circle at `coord` with radius `r`
    // needs so its wraparound copies land on the opposite edge. r is always
    // < SIZE/2 here, so a circle can straddle at most one pair of edges per
    // axis — either fully inside (one offset, 0), or crossing the low edge
    // (plus a copy offset by +SIZE), or crossing the high edge (plus a copy
    // offset by -SIZE). Never both.
    const edgeOffsets = (coord, r) => {
      const out = [0];
      if (coord - r < 0) out.push(SIZE);
      else if (coord + r > SIZE) out.push(-SIZE);
      return out;
    };

    const stampPatch = (sprite, x, y, r) => {
      const d = r * 2;
      for (const ox of edgeOffsets(x, r)) {
        for (const oy of edgeOffsets(y, r)) {
          ctx.drawImage(sprite, x + ox - r, y + oy - r, d, d);
        }
      }
    };

    // Mottling pass. Same patch count and radius distribution as before,
    // same alpha, same colour gradient — just sampled through the sprite
    // lookup instead of rebuilt per patch.
    ctx.globalAlpha = 0.28;
    const patches = 5500;
    for (let i = 0; i < patches; i++) {
      const x = rng() * SIZE;
      const y = rng() * SIZE;
      const r = 8 + rng() * 44;
      const t = rng();
      let shade = (t * MOTTLE_SHADES) | 0;
      if (shade >= MOTTLE_SHADES) shade = MOTTLE_SHADES - 1;
      stampPatch(sprites[shade], x, y, r);
    }
    ctx.globalAlpha = 1;

    // Fine single-pixel speckle so the texture still has texture at close
    // zoom instead of reading as smooth blobs. Single pixels cannot cross
    // an edge, so no wraparound is needed here — the pixel is either fully
    // inside or fully outside.
    //
    // Written via ImageData rather than 24,000 fillRect(x, y, 1, 1) calls.
    // Each fillRect pays full canvas-API overhead for a single pixel; the
    // compositing here is three multiplies per touched pixel in a tight
    // loop, and the whole pass collapses to one getImageData/putImageData
    // round-trip on the full 1024² buffer.
    const speckles = 24000;
    const img = ctx.getImageData(0, 0, SIZE, SIZE);
    const data = img.data;
    const A = 0.35;
    const INV = 1 - A;
    for (let i = 0; i < speckles; i++) {
      const x = (rng() * SIZE) | 0;
      const y = (rng() * SIZE) | 0;
      const v = rng();
      const rr = 0x2a + v * 0x30;
      const gg = 0x3a + v * 0x40;
      const bb = 0x1a + v * 0x20;
      const idx = (y * SIZE + x) * 4;
      data[idx]     = data[idx]     * INV + rr * A;
      data[idx + 1] = data[idx + 1] * INV + gg * A;
      data[idx + 2] = data[idx + 2] * INV + bb * A;
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // 8 tiles across the 600-unit ground plane → each tile is 75 world
    // units. The seam fix means tiling is not visible regardless.
    tex.repeat.set(8, 8);
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // Guarded because colorSpace was renamed in three.js r152. Older
    // builds simply leave the texture in the default space, which is fine
    // for a hand-authored colour map.
    if (THREE.SRGBColorSpace !== undefined) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    return tex;
  }

  // Small deterministic PRNG (mulberry32) so the ground texture is stable
  // across page loads.
  _mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  _updateCameraTransform() {
    const horizDist = this.cameraDistance * Math.cos(this.cameraPitch);
    const height = this.cameraDistance * Math.sin(this.cameraPitch);

    this.camera.position.set(
      this.cameraTarget.x + horizDist * Math.sin(this.cameraYaw),
      height,
      this.cameraTarget.z + horizDist * Math.cos(this.cameraYaw)
    );
    this.camera.lookAt(this.cameraTarget.x, 0, this.cameraTarget.z);

    // Keep the sun's shadow frustum centered on the camera target so a
    // scrolling battlefield stays lit and shadowed. Both the sun and its
    // target move by the same delta, so the light direction — and therefore
    // the shadow direction — is unchanged; only the frustum shifts.
    if (this.sun) {
      this.sun.position.set(
        this.cameraTarget.x + SUN_OFFSET.x,
        SUN_OFFSET.y,
        this.cameraTarget.z + SUN_OFFSET.z
      );
      this.sun.target.position.set(this.cameraTarget.x, 0, this.cameraTarget.z);
      this.sun.target.updateMatrixWorld();
    }
  }

  panCamera(dx, dz) {
    this.cameraTarget.x += dx;
    this.cameraTarget.z += dz;
    this._updateCameraTransform();
  }

  orbitCamera(dYaw, dPitch) {
    this.cameraYaw += dYaw;
    this.cameraPitch = Math.max(0.35, Math.min(1.4, this.cameraPitch + dPitch));
    this._updateCameraTransform();
  }

  zoomCamera(amount) {
    this.cameraDistance = Math.max(4, Math.min(120, this.cameraDistance + amount));
    this._updateCameraTransform();
  }

  _handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
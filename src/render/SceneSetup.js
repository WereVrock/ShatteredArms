// ===== SceneSetup.js =====
import * as THREE from 'three';
import { GrassField } from './GrassField.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { viewRangeFor, clampZoom, zoomStepScale } from './ViewRange.js';
import { ActiveTerrain } from '../session/ActiveTerrain.js';
import { BiomeVisuals } from '../config/BiomeVisuals.js';
import { BiomeTint, DEFAULT_TREE_TINT } from '../config/BiomeTint.js';

// Fog / sky colour. Used for scene.background and scene.fog — one constant
// so the two can never drift.
const SKY_COLOR = 0x87a8c9;

// Shadow map re-render rate. See SceneSetup.render(): the map updates at
// most this often, regardless of render framerate. Soldiers move a fraction
// of a soldier-width per frame, so a 30 Hz shadow map is visually
// indistinguishable from a 60 Hz one while halving the shadow pass cost.
// Lower to 20 if the shadow pass is still heavy; raise to 60 to disable the
// throttle.
const SHADOW_UPDATE_HZ = 30;

// When frames are slow the shadow pass must back off, not repeat every
// frame: it re-draws every caster. The interval grows to twice the
// smoothed frame time, capped here (10 Hz).
const SHADOW_MAX_INTERVAL_MS = 100;

// Shadow map resolution per quality tier, exposed via settings.shadowQuality.
// Each step down halves texel count on each axis (quarter the area and fill
// cost): 2048² → 1024² → 512². 'medium' (1024²) is the default — 512² is
// noticeably chunkier on soldier silhouettes but still readable at battle
// zoom, and is the right floor for integrated graphics.
const SHADOW_MAP_SIZES = { high: 2048, medium: 1024, low: 512 };

// Default tier used when settings.shadowQuality is absent or unrecognised.
const SHADOW_QUALITY_DEFAULT = 'medium';

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

// Ground plane size. Must stay well beyond the map bounds plus the farthest
// camera reach, so the plane's edge is never visible.
const GROUND_EXTENT = 6000;

// Extra world units the orbiting camera's world POSITION may extend past
// CombatConfig.mapBounds on each side. The camera target is already
// clamped to mapBounds in _updateCameraTransform, but the physical camera
// floats behind the target by horizDist (up to cameraDistance at low
// pitch), so at a corner the camera would otherwise sit tens of units
// past the boundary. The overscan allows normal corner orbits to be
// unobstructed while keeping the camera from wandering into the terrain
// buffer that now extends 600 units past the playable field (see
// TerrainConfig.region.minHalfExtent).
//
// 80 comfortably covers the max horizDist for the default camera ranges
// (cameraDistance 30-80, pitch 0.35-1.4 => horizDist 25-75) with a
// small margin. Raise it if the max zoom range is expanded; lower it
// to make the boundary feel stricter.
const CAMERA_BOUNDS_OVERSCAN = 80;

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

    // MSAA can only be chosen when the WebGL context is created, so the
    // Graphics setting takes effect on the next battle start (Restart).
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !!(options.settings && options.settings.antialias)
    });
    // Cap the device pixel ratio at 1.5 so a 4K/high-DPR display does not
    // silently quadruple fill cost. applySettings may further scale this
    // by the user's renderScale setting; _appliedPixelRatio tracks the
    // last value pushed to the renderer so a redundant applySettings call
    // does not churn the WebGL context.
    const initialPixelRatio = Math.min(window.devicePixelRatio, 1.5);
    this.renderer.setPixelRatio(initialPixelRatio);
    this._appliedPixelRatio = initialPixelRatio;

    // Shadows: PCFShadowMap, NOT PCFSoftShadowMap. PCFSoft costs roughly
    // 2.5x the taps per fragment for a penumbra that is invisible at battle
    // zoom. The shadow pass was the frame-time bottleneck; this was the
    // single largest win available.
    //
    // shadowMap.enabled/type are set ONCE here and never toggled at runtime.
    // Toggling them forces a full material recompile, which causes a visible
    // hitch. Runtime shadow on/off goes through sun.castShadow instead —
    // see applySettings.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // Shadow map re-render throttle. autoUpdate is off; the map is only
    // refreshed on frames where render() explicitly sets needsUpdate — see
    // SHADOW_UPDATE_HZ and render() below. _lastShadowUpdateMs is seeded to
    // -Infinity so the very first frame always updates.
    this.renderer.shadowMap.autoUpdate = false;
    this._lastShadowUpdateMs = -Infinity;
    // True while the shadow map may not match the scene. The throttled
    // refresh in render() only runs while this is set.
    this._shadowStale = true;
    // Current map-size tier. Null means "not yet applied"; applySettings
    // uses this to detect a tier change and reallocate the shadow target.
    this._shadowQuality = null;

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

    // Multiplier applied to fog.far when a biome fog density is active.
    // Clamped to [0.85, 1.4] in applyBiomeVisuals — the tight window
    // keeps fog from ever cutting into the map (0.85 floor) while still
    // letting clear biomes push the fog wall further out (1.4 ceiling).
    this._biomeFogScale = 1.0;

    // Currently-active biome. Set by applyBiomeVisuals; read by
    // _refreshGroundMaterial, _tintSkirt and applySettings so a
    // settings-toggle never wipes the biome's base-plane tint.
    this._currentBiomeId = null;

    // Skirt (decorative tree/rock ring around the map). Built lazily
    // in applyTerrain so we know the region extent at build time.
    this._skirtGroup = null;
    this._skirtTrees = null;
    this._skirtRocks = null;
    this._skirtPositions = null;

    // Terrain region from the last applyTerrain call. Used by
    // _updateViewRange to anchor fog to the actual generated terrain
    // extent (which extends past CombatConfig.mapBounds) instead of
    // the playable bounds. Null until a terrain is applied.
    this._terrainRegion = null;

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
      count: 18000,
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
    // Shadows on/off and their resolution tier are ONE setting, not two.
    // 'none' means off; any other value means on at that tier. This is the
    // only place the two concerns are joined — every other reader can
    // treat shadowQuality as a plain three-or-four-value enum.
    const shadowsOn = settings.shadowQuality !== 'none';
    this._shadowStale = true;
    const quality = SHADOW_MAP_SIZES[settings.shadowQuality]
      ? settings.shadowQuality
      : SHADOW_QUALITY_DEFAULT;

    const textureOn = !!settings.groundTexture;
    const grassOn = !!settings.grass;
    const fogOn = !!settings.fog;

    // Render scale. Applied on top of the device pixel ratio (itself
    // capped at 1.5 in the constructor). three.js's setPixelRatio
    // internally re-runs setSize with the current canvas CSS dimensions,
    // so the backing store is resized while the on-screen size stays put
    // — exactly what a resolution scale should do. Skipped when unchanged
    // so a redundant applySettings call does not churn the context.
    const scale = parseFloat(settings.renderScale) || 1;
    const targetPixelRatio = Math.min(window.devicePixelRatio, 1.5) * scale;
    if (targetPixelRatio !== this._appliedPixelRatio) {
      this.renderer.setPixelRatio(targetPixelRatio);
      this._appliedPixelRatio = targetPixelRatio;
    }

    if (this.sun) {
      // Toggling castShadow is the cheap runtime lever — three.js simply
      // skips the shadow render pass when it's false, with no material
      // recompile.
      this.sun.castShadow = shadowsOn;

      // Map reallocation only when shadows are ON and the tier actually
      // changed. A tier of 'none' turns the pass off but leaves the map
      // allocated at the last real size, so toggling back on is instant
      // and restores the player's last choice.
      if (shadowsOn && quality !== this._shadowQuality) {
        const size = SHADOW_MAP_SIZES[quality];
        this.sun.shadow.mapSize.set(size, size);
        if (this.sun.shadow.map) {
          this.sun.shadow.map.dispose();
          this.sun.shadow.map = null;
        }
        this._shadowQuality = quality;
      }
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

    // Base plane material is refreshed by a dedicated helper because the
    // biome tint and the texture setting both contribute to it. applySettings
    // records the settings object so the helper can read textureOn on a
    // biome change without a second argument.
    this._lastSettings = settings;
    this._refreshGroundMaterial();
  }

  // Reapplies the base plane's texture/colour from the current texture
  // setting AND the current biome. Called from applySettings (settings
  // toggle) and applyBiomeVisuals (biome change) so the two can never
  // disagree: with a biome grass override, the plane is solid biome
  // colour; without one, it follows the texture setting.
  _refreshGroundMaterial() {
    if (!this.ground) return;
    const settings = this._lastSettings || {};
    const textureOn = !!settings.groundTexture;
    const biomeId = this._currentBiomeId;
    const hasOverride = this._hasBiomeGrassOverride(biomeId);
    const mat = this.ground.material;

    if (hasOverride) {
      // Biome-specific base colour. Texture is dropped because
      // textureColor * biomeColor reads as muddy brown on any biome
      // whose tint differs from the texture's green — a solid biome
      // colour, mostly hidden behind the skirt + fog, is cleaner.
      mat.map = null;
      mat.color.setHex(this._biomeGrassColorHex(biomeId));
    } else if (textureOn) {
      mat.map = this._ensureGroundTexture();
      mat.color.setHex(0xffffff);
    } else {
      mat.map = null;
      mat.color.setHex(0x3f5528);
    }
    mat.needsUpdate = true;
  }

  _hasBiomeGrassOverride(biomeId) {
    if (!biomeId) return false;
    const v = BiomeVisuals[biomeId];
    return !!(v && v.ground && v.ground.grass && v.ground.grass.color);
  }

  _biomeGrassColorHex(biomeId) {
    const v = biomeId ? BiomeVisuals[biomeId] : null;
    const gc = v && v.ground && v.ground.grass;
    if (gc && gc.color) {
      return (gc.color[0] << 16) | (gc.color[1] << 8) | gc.color[2];
    }
    return 0x3f5528;
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
    // GROUND_EXTENT is a module-level constant (see top of file).
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
// Bright strips at CombatConfig.mapBounds — the same box
  // RoutingExtractionSystem uses to decide when a routing soldier has left
  // the field. This is the actual, rule-driven map edge, not a decorative
  // approximation.
  //
  // Each side is a subdivided strip (SEGMENTS quads along its length) whose
  // vertices sample the terrain height at their own world XZ. On the
  // elevated terrain mesh the flat-quad version that preceded this was
  // buried inside every hill above 0.06 units — the strips visibly
  // disappeared into hillsides and reappeared on flat ground. Per-vertex
  // sampling makes the strips hug the surface instead.
  //
  // The material draws through terrain (depthTest: false) so the boundary
  // is always readable from any camera angle. Combined with the terrain-
  // following Y values, it reads as a contour line on the landscape, not a
  // UI element floating above it.
  //
  // Vertical Y values are updated by _updateFieldEdgeHeights whenever a new
  // terrain is set (SceneSetup.applyTerrain) — this method only builds the
  // geometry and does not itself sample terrain.
// Bright strips at CombatConfig.mapBounds, projected onto the terrain.
  // Each side is a subdivided strip whose vertices are lifted to the
  // terrain height at their own world XZ, so the boundary climbs hills
  // and drops into valleys instead of being buried by them.
  //
  // depthTest: false + renderOrder 996 keeps the boundary visible from
  // every camera angle, even behind a hill between the camera and the
  // strip — same HUD choice as RangeCircleView makes for the range ring.
  //
  // Terrain sampling is deferred to first render (see _addBoundaryStrip's
  // onBeforeRender). The active terrain does not exist when this runs —
  // it is set later via ActiveTerrain.set() — so we cannot sample here.
  _addFieldEdge() {
    const b = CombatConfig.mapBounds;
    const thickness = FIELD_EDGE_THICKNESS;
    const SEGMENTS = 64;

    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd060,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide
    });

    this._fieldEdgeStrips = [];
    // undefined = never sampled. First onBeforeRender sets this and samples;
    // subsequent calls skip until ActiveTerrain changes (new battle).
    this._fieldEdgeSampledTerrain = undefined;

    for (const z of [b.minZ, b.maxZ]) {
      this._addBoundaryStrip(group, mat, 'x', b.minX, b.maxX, z, SEGMENTS, thickness);
    }
    for (const x of [b.minX, b.maxX]) {
      this._addBoundaryStrip(group, mat, 'z', b.minZ, b.maxZ, x, SEGMENTS, thickness);
    }

    group.frustumCulled = false;
    this.scene.add(group);
    this.fieldEdge = group;
  }

// One boundary edge as a subdivided strip. `axis === 'x'` means the
  // strip runs along X (fixed Z = `fixed`); `axis === 'z'` means it runs
  // along Z (fixed X = `fixed`). Initial Y values are flat; the terrain
  // projection happens in onBeforeRender.
  _addBoundaryStrip(parent, material, axis, from, to, fixed, segments, thickness) {
    const halfT = thickness / 2;
    const vertCount = (segments + 1) * 2;
    const positions = new Float32Array(vertCount * 3);
    const indices = new Uint16Array(segments * 6);

    for (let i = 0; i < segments; i++) {
      const base = i * 6;
      const i0 = i * 2, o0 = i * 2 + 1, i1 = (i + 1) * 2, o1 = (i + 1) * 2 + 1;
      indices[base + 0] = i0; indices[base + 1] = o0; indices[base + 2] = i1;
      indices[base + 3] = i1; indices[base + 4] = o0; indices[base + 5] = o1;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const mesh = new THREE.Mesh(geo, material);
    mesh.renderOrder = 996;
    mesh.frustumCulled = false;

    // Lazy terrain projection. Fires on first draw, samples the active
    // terrain per vertex, and no-ops afterwards until ActiveTerrain
    // changes. No external wiring needed — BattleTerrainSetup does not
    // have to know about the field boundary at all.
    mesh.onBeforeRender = () => {
      const t = ActiveTerrain.get();
      if (t === this._fieldEdgeSampledTerrain) return;
      this._fieldEdgeSampledTerrain = t;
      this._refreshFieldEdgeHeights();
    };

    parent.add(mesh);
    this._fieldEdgeStrips.push({ mesh, axis, from, to, fixed, segments, thickness: halfT });
  }

// Re-samples terrain height at every vertex of every boundary strip and
  // writes the new Y. Called once per battle when the active terrain
  // becomes available (see _addBoundaryStrip's onBeforeRender). Null
  // terrain leaves all Y values at the flat 0.06 baseline.
  _refreshFieldEdgeHeights() {
    const LIFT = 0.06;
    const terrain = this._fieldEdgeSampledTerrain;

    for (const s of this._fieldEdgeStrips) {
      const pos = s.mesh.geometry.attributes.position.array;
      for (let i = 0; i <= s.segments; i++) {
        const t = i / s.segments;
        const along = s.from + (s.to - s.from) * t;
        let innerX, innerZ, outerX, outerZ;
        if (s.axis === 'x') {
          innerX = along; innerZ = s.fixed + s.thickness;
          outerX = along; outerZ = s.fixed - s.thickness;
        } else {
          innerX = s.fixed + s.thickness; innerZ = along;
          outerX = s.fixed - s.thickness; outerZ = along;
        }
        const p = i * 2 * 3;
        pos[p + 0] = innerX;
        pos[p + 1] = (terrain ? terrain.heightAt(innerX, innerZ) : 0) + LIFT;
        pos[p + 2] = innerZ;
        pos[p + 3] = outerX;
        pos[p + 4] = (terrain ? terrain.heightAt(outerX, outerZ) : 0) + LIFT;
        pos[p + 5] = outerZ;
      }
      s.mesh.geometry.attributes.position.needsUpdate = true;
    }
  }

// (A) Decorative skirt: a ring of simple trees and rocks just OUTSIDE
  // the generated terrain region. Fills the empty space between the
  // terrain's hard edge and the fog wall with silhouettes, so the
  // player never sees a sharp "map ends here" line.
  //
  // Built once per SceneSetup (which is once per battle) on the first
  // applyTerrain call, because the terrain region defines where the
  // skirt starts. Skirt meshes use plain Lampert materials with per-
  // instance colours so a biome change only re-tints a small array,
  // not rebuilds the mesh.
  _ensureSkirt(terrain) {
    if (this._skirtGroup) return;

    const region = (terrain && terrain.region) ? terrain.region : CombatConfig.mapBounds;
    const INNER = 15;   // gap between terrain edge and skirt tree line
    const OUTER = 120;  // width of the skirt band
    const TREE_COUNT = 640;
    const ROCK_COUNT = 160;

    const treeGeo = new THREE.ConeGeometry(1.2, 6, 5);
    treeGeo.translate(0, 3, 0);   // pivot at base
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);

    const treeMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    const rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });

    const trees = new THREE.InstancedMesh(treeGeo, treeMat, TREE_COUNT);
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCK_COUNT);
    trees.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TREE_COUNT * 3), 3);
    rocks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ROCK_COUNT * 3), 3);
    trees.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    rocks.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    trees.frustumCulled = false;
    rocks.frustumCulled = false;
    trees.castShadow = false; trees.receiveShadow = false;
    rocks.castShadow = false; rocks.receiveShadow = false;

    // Seeded RNG for determinism across reloads.
    let seed = 0x5EEDF00D;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const dummy = new THREE.Object3D();
    const positions = [];

    const perSide = Math.ceil((TREE_COUNT + ROCK_COUNT) / 4);
    let treeIdx = 0;
    let rockIdx = 0;
    for (let i = 0; i < perSide * 4; i++) {
      if (treeIdx >= TREE_COUNT && rockIdx >= ROCK_COUNT) break;

      const sideIdx = i % 4;
      const offset = rng() * (OUTER - INNER);
      let x, z;
      if (sideIdx === 0) {           // z+ edge
        x = region.minX + rng() * (region.maxX - region.minX);
        z = region.maxZ + INNER + offset;
      } else if (sideIdx === 1) {    // z- edge
        x = region.minX + rng() * (region.maxX - region.minX);
        z = region.minZ - INNER - offset;
      } else if (sideIdx === 2) {    // x+ edge
        z = region.minZ + rng() * (region.maxZ - region.minZ);
        x = region.maxX + INNER + offset;
      } else {                        // x- edge
        z = region.minZ + rng() * (region.maxZ - region.minZ);
        x = region.minX - INNER - offset;
      }

      const isTree = (i % 3 !== 0) && treeIdx < TREE_COUNT;
      if (isTree) {
        const s = 0.7 + rng() * 0.6;
        dummy.position.set(x, 0, z);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        dummy.scale.set(s, s * (0.9 + rng() * 0.4), s);
        dummy.updateMatrix();
        trees.setMatrixAt(treeIdx, dummy.matrix);
        positions.push({ mesh: trees, index: treeIdx, isTree: true });
        treeIdx++;
      } else if (rockIdx < ROCK_COUNT) {
        const s = 0.8 + rng() * 1.2;
        dummy.position.set(x, 0.3, z);
        dummy.rotation.set(rng() * 0.5, rng() * Math.PI * 2, rng() * 0.5);
        dummy.scale.set(s, s * 0.7, s);
        dummy.updateMatrix();
        rocks.setMatrixAt(rockIdx, dummy.matrix);
        positions.push({ mesh: rocks, index: rockIdx, isTree: false });
        rockIdx++;
      }
    }
    trees.count = treeIdx;
    rocks.count = rockIdx;
    trees.instanceMatrix.needsUpdate = true;
    rocks.instanceMatrix.needsUpdate = true;

    const group = new THREE.Group();
    group.add(trees);
    group.add(rocks);
    this.scene.add(group);

    this._skirtGroup = group;
    this._skirtTrees = trees;
    this._skirtRocks = rocks;
    this._skirtPositions = positions;

    // Default colour until applyBiomeVisuals fires.
    this._tintSkirt(null);
  }

  // Tint the skirt trees/rocks for the given biome. Per-instance colour
  // is written through InstancedBufferAttribute; a biome change updates
  // every instance in one pass. Cheap — 800 instances total.
  _tintSkirt(biomeId) {
    if (!this._skirtPositions) return;

    let treeColor;
    const v = biomeId ? BiomeVisuals[biomeId] : null;
    const gc = v && v.ground && v.ground.grass;
    if (gc && gc.color) {
      treeColor = [gc.color[0] * 0.65, gc.color[1] * 0.65, gc.color[2] * 0.65];
    } else {
      const tint = (biomeId && BiomeTint[biomeId])
        ? BiomeTint[biomeId].tree : DEFAULT_TREE_TINT;
      const c = new THREE.Color();
      c.setHSL(tint.hue, tint.sat, tint.lit);
      treeColor = [c.r * 255, c.g * 255, c.b * 255];
    }
    const rockColor = [0x6a, 0x62, 0x5a];

    const col = new THREE.Color();
    for (const p of this._skirtPositions) {
      const c = p.isTree ? treeColor : rockColor;
      col.setRGB(c[0] / 255, c[1] / 255, c[2] / 255);
      p.mesh.setColorAt(p.index, col);
    }
    if (this._skirtTrees.instanceColor) this._skirtTrees.instanceColor.needsUpdate = true;
    if (this._skirtRocks.instanceColor) this._skirtRocks.instanceColor.needsUpdate = true;
  }

// Called whenever a battle's terrain becomes active. Updates both the
  // grass scatter (hides tufts on mud/water, lifts the rest onto hills) and
  // the field boundary strips (lifts each vertex to the terrain height
  // under it). Idempotent; safe to call again for a different battle.
  //
  // Replaces the direct sceneSetup.grassField.applyTerrain(terrain) call
  // previously made by BattleTerrainSetup — the boundary needs the same
  // update, and routing both through one method keeps the two in lockstep.
  applyTerrain(terrain) {
    if (terrain && terrain.region) {
      this._terrainRegion = {
        minX: terrain.region.minX, maxX: terrain.region.maxX,
        minZ: terrain.region.minZ, maxZ: terrain.region.maxZ
      };
    } else {
      this._terrainRegion = null;
    }
    if (this.grassField) this.grassField.applyTerrain(terrain);
    this._updateFieldEdgeHeights(terrain);
    // Skirt is DISABLED. TerrainConfig.region.minHalfExtent was raised so
    // the terrain itself extends 120 units past CombatConfig.mapBounds —
    // the same generation passes (height, ground, features, obstacles)
    // fill the space that the decorative skirt used to fake. The methods
    // (_ensureSkirt / _tintSkirt) are kept so this can be re-enabled
    // cheaply if the extension ever needs to be reverted.
    // this._ensureSkirt(terrain);
    // Apply per-biome fog, sky, base-plane tint. Reads terrain.dominantBiome
    // (set by TerrainGenerator) so a battle's ambient layer keys off the
    // biome that owns most of its cells.
    this.applyBiomeVisuals(terrain ? terrain.dominantBiome : null);
  }

  // Per-biome fog + sky. Null resets both to the defaults used before any
  // terrain exists. Called from applyTerrain, so a Restart or a new
  // battle automatically picks up the new biome's ambience.
  applyBiomeVisuals(biomeId) {
    this._currentBiomeId = biomeId;
    const v = biomeId ? BiomeVisuals[biomeId] : null;

    // Sky (scene background colour).
    const skyColor = (v && v.sky !== undefined) ? v.sky : SKY_COLOR;
    this.scene.background = new THREE.Color(skyColor);

    // Fog: colour matches the biome's fog override, else follows sky.
    if (this.scene.fog) {
      const fogColor = (v && v.fog && v.fog.color !== undefined)
        ? v.fog.color
        : skyColor;
      this.scene.fog.color = new THREE.Color(fogColor);
    }

    // Fog scale. Baseline density 0.003 = scale 1.0. Denser fog -> smaller
    // scale -> shorter fog distance. Clamped to a NARROW window so the fog
    // can never cut into the map itself:
    //   floor 0.85  — map far edge always clear
    //   ceiling 1.4 — clear biomes still fade at a plausible horizon
    // _updateViewRange rebuilds fog.near/.far from this scale each frame.
    if (v && v.fog && typeof v.fog.density === 'number' && v.fog.density > 0) {
      this._biomeFogScale = Math.max(0.85, Math.min(1.4, 0.003 / v.fog.density));
    } else {
      this._biomeFogScale = 1.0;
    }

    // Base plane (B) — tint to the biome's grass colour, or fall back to
    // the texture setting when this biome has no override (grassland).
    this._refreshGroundMaterial();

    // Skirt (A) — tint the tree/rock ring to match the biome.
    this._tintSkirt(biomeId);
  }

  // Re-samples terrain height at every vertex of every field-edge strip and
  // writes the new Y. Called from applyTerrain. Null terrain resets every
  // vertex to the flat 0.06 baseline (used during scene construction,
  // before any terrain exists).
// Re-samples terrain height at every vertex of every field-edge strip
  // and writes the new Y. Called from applyTerrain on every battle start.
  //
  // The strips are produced by _addBoundaryStrip, so their geometry lives
  // on `strip.mesh.geometry` — NOT `strip.geometry`. An earlier draft of
  // this method assumed the older inline-strip shape and crashed with
  // "Cannot read properties of undefined (reading 'attributes')" the
  // moment applyTerrain ran. The `s.mesh?.geometry` guard below prevents
  // the same class of bug if the strip shape ever changes again.
  //
  // Accepts an optional terrain argument. When omitted, falls back to
  // ActiveTerrain.get() so callers do not have to pass it explicitly.
  _updateFieldEdgeHeights(terrain) {
    if (!this._fieldEdgeStrips) return;
    const t = terrain !== undefined ? terrain : ActiveTerrain.get();
    const LIFT = 0.06;

    for (const s of this._fieldEdgeStrips) {
      const geo = s.mesh && s.mesh.geometry;
      if (!geo || !geo.attributes || !geo.attributes.position) continue;
      const pos = geo.attributes.position.array;

      for (let i = 0; i <= s.segments; i++) {
        const u = i / s.segments;
        const along = s.from + (s.to - s.from) * u;
        let innerX, innerZ, outerX, outerZ;
        if (s.axis === 'x') {
          innerX = along; innerZ = s.fixed + s.thickness;
          outerX = along; outerZ = s.fixed - s.thickness;
        } else {
          innerX = s.fixed + s.thickness; innerZ = along;
          outerX = s.fixed - s.thickness; outerZ = along;
        }
        const p = i * 2 * 3;
        pos[p + 0] = innerX;
        pos[p + 1] = (t ? t.heightAt(innerX, innerZ) : 0) + LIFT;
        pos[p + 2] = innerZ;
        pos[p + 3] = outerX;
        pos[p + 4] = (t ? t.heightAt(outerX, outerZ) : 0) + LIFT;
        pos[p + 5] = outerZ;
      }
      geo.attributes.position.needsUpdate = true;
    }
  }

// One boundary strip, subdivided into `segments` quads along its length.
  // Axis 'x' means the strip runs along X (at fixed Z = `fixed`); axis 'z'
  // means it runs along Z (at fixed X = `fixed`). `from` / `to` are the
  // endpoints along the run axis. All Y values start at the flat ground
  // height; they are overwritten per-vertex by _updateFieldEdgeHeights when
  // terrain arrives.
  _buildEdgeStrip(axis, from, to, fixed, segments, thickness) {
    const vertCount = (segments + 1) * 2;
    const positions = new Float32Array(vertCount * 3);
    const indices = new Uint16Array(segments * 6);
    const halfT = thickness / 2;

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const along = from + (to - from) * t;
      let innerX, innerZ, outerX, outerZ;
      if (axis === 'x') {
        innerX = along; innerZ = fixed + halfT;
        outerX = along; outerZ = fixed - halfT;
      } else {
        innerX = fixed + halfT; innerZ = along;
        outerX = fixed - halfT; outerZ = along;
      }
      const p = i * 2 * 3;
      positions[p]     = innerX;
      positions[p + 1] = 0.06;
      positions[p + 2] = innerZ;
      positions[p + 3] = outerX;
      positions[p + 4] = 0.06;
      positions[p + 5] = outerZ;
    }

    for (let i = 0; i < segments; i++) {
      const base = i * 6;
      const i0 = i * 2;
      const o0 = i * 2 + 1;
      const i1 = (i + 1) * 2;
      const o1 = (i + 1) * 2 + 1;
      indices[base + 0] = i0;
      indices[base + 1] = o0;
      indices[base + 2] = i1;
      indices[base + 3] = i1;
      indices[base + 4] = o0;
      indices[base + 5] = o1;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    return { geometry: geo, axis, from, to, fixed, segments, thickness };
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
    tex.repeat.set(GROUND_EXTENT / 75, GROUND_EXTENT / 75);
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
    // Clamp the target to CombatConfig.mapBounds. The camera orbits the
    // target, so clamping the target is what stops the player panning
    // past the edge of the playable field. Terrain generation extends
    // 120 units past the bounds, so the moment the target hits the
    // boundary the camera still sees fully-detailed terrain all the
    // way out to the fog wall — no visible "edge of the world".
    //
    // Clamping here (not in panCamera) means every path that touches
    // cameraTarget is covered: pan, initial scene construction, and
    // any future direct assignment.
    const mb = CombatConfig.mapBounds;
    if (this.cameraTarget.x < mb.minX) this.cameraTarget.x = mb.minX;
    else if (this.cameraTarget.x > mb.maxX) this.cameraTarget.x = mb.maxX;
    if (this.cameraTarget.z < mb.minZ) this.cameraTarget.z = mb.minZ;
    else if (this.cameraTarget.z > mb.maxZ) this.cameraTarget.z = mb.maxZ;

    const tx = this.cameraTarget.x;
    const tz = this.cameraTarget.z;
    // Ground height under the target, lightly averaged so panning over
    // bumps does not make the view jitter.
    const gy = (ActiveTerrain.heightAt(tx, tz) * 2 +
      ActiveTerrain.heightAt(tx + 5, tz) + ActiveTerrain.heightAt(tx - 5, tz) +
      ActiveTerrain.heightAt(tx, tz + 5) + ActiveTerrain.heightAt(tx, tz - 5)) / 6;

    const horizDist = this.cameraDistance * Math.cos(this.cameraPitch);
    const height = this.cameraDistance * Math.sin(this.cameraPitch);

    this.camera.position.set(
      tx + horizDist * Math.sin(this.cameraYaw),
      gy + height,
      tz + horizDist * Math.cos(this.cameraYaw)
    );

    // Limit the physical camera POSITION to mapBounds + a small overscan.
    // The camera target is already clamped above, but the camera itself
    // floats behind the target by horizDist along the orbit direction,
    // so at a corner the camera can sit tens of units past the playable
    // boundary. Capping it here keeps the player's camera inside the
    // mental model of "the map", independent of zoom level or orbit
    // angle. CAMERA_BOUNDS_OVERSCAN (see top of file) is generous enough
    // that ordinary corner orbits at any default zoom are unaffected.
    //
    // The clamp runs BEFORE camera.lookAt so the view is derived from
    // the clamped position — otherwise the camera would briefly point
    // at the target from an unclamped pose, then "snap" once the clamp
    // was applied on the next frame.
    const camMinX = mb.minX - CAMERA_BOUNDS_OVERSCAN;
    const camMaxX = mb.maxX + CAMERA_BOUNDS_OVERSCAN;
    const camMinZ = mb.minZ - CAMERA_BOUNDS_OVERSCAN;
    const camMaxZ = mb.maxZ + CAMERA_BOUNDS_OVERSCAN;
    if (this.camera.position.x < camMinX) this.camera.position.x = camMinX;
    else if (this.camera.position.x > camMaxX) this.camera.position.x = camMaxX;
    if (this.camera.position.z < camMinZ) this.camera.position.z = camMinZ;
    else if (this.camera.position.z > camMaxZ) this.camera.position.z = camMaxZ;

    this.camera.lookAt(tx, gy, tz);

    // Keep the sun's shadow frustum centered on the camera target so a
    // scrolling battlefield stays lit and shadowed. Both the sun and its
    // target move by the same delta, so the light direction is unchanged.
    if (this.sun) {
      this.sun.position.set(
        tx + SUN_OFFSET.x,
        gy + SUN_OFFSET.y,
        tz + SUN_OFFSET.z
      );
      this.sun.target.position.set(tx, gy, tz);
      this.sun.target.updateMatrixWorld();
    }

    this._updateViewRange();
  }

  panCamera(dx, dz) {
    this.cameraTarget.x += dx;
    this.cameraTarget.z += dz;
    this._updateCameraTransform();

    // Sun position is derived from cameraTarget (see
    // _updateCameraTransform above), so a pan moves the sun. Without
    // this refresh, the shadow map is only updated on the regular
    // ~30 Hz throttle — and for 1-3 frames after each pan the shadow
    // is baked with the OLD sun position while the body is drawn with
    // the NEW camera pose. That reads as "the body shifts while its
    // shadow stays put" during a pan, exactly like a body-shadow
    // desync. During pause this is the ONLY shadow-refresh trigger,
    // because visualDelta is 0 so the forceShadowUpdate path in
    // BattleRenderer.syncWithSimulation never fires.
    //
    // Resetting _lastShadowUpdateMs alongside needsUpdate prevents the
    // regular throttle from ALSO firing the following frame (which
    // would double the refresh rate during continuous pan). Net cost:
    // exactly one shadow render per pan frame, which is what the body
    // needs to stay visually in sync with its shadow.
    if (this.renderer) {
      this.renderer.shadowMap.needsUpdate = true;
      this._lastShadowUpdateMs = performance.now();
    }
  }

  orbitCamera(dYaw, dPitch) {
    this.cameraYaw += dYaw;
    this.cameraPitch = Math.max(0.35, Math.min(1.4, this.cameraPitch + dPitch));
    this._updateCameraTransform();
  }

zoomCamera(amount) {
    this.cameraDistance = clampZoom(
      this.cameraDistance + amount * zoomStepScale(this.cameraDistance)
    );
    this._updateCameraTransform();
  }

// Scales the camera's near/far planes and the fog range with the zoom
  // distance (see ViewRange.js). Idempotent and cheap: the projection matrix
  // is only rebuilt when near/far actually change, and fog.far is only
  // rewritten while fog is ON - applySettings parks fog.far at FOG_FAR_OFF
  // for "fog off", which is recognised here and left alone.
  _updateViewRange() {
    const r = viewRangeFor(this.cameraDistance);
    const cam = this.camera;
    if (cam.near !== r.near || cam.far !== r.far) {
      cam.near = r.near;
      cam.far = r.far;
      cam.updateProjectionMatrix();
    }

    const fog = this.scene.fog;
    if (fog && fog.far < FOG_FAR_OFF * 0.5) {
      const s = this._biomeFogScale || 1.0;

      // (C) Aggressive OUTER fog. Compute the distance from the camera to
      // the far corner of the playable map, then place the fog wall just
      // past it. Guarantees: the whole map is always inside the clear
      // window; the empty base plane beyond it always fades out.
      //
      // Without this, fog was scaled from the camera's distance to the
      // TARGET — which is a zoom control, not a "how far is the map edge"
      // measure. Zooming out pushed the fog wall past the base plane
      // entirely, so the ground beyond the map stayed visible: the
      // "empty boundaries" bug.
      // Anchor fog to the ACTUAL terrain region — which extends past
      // mapBounds by minHalfExtent (see BattleTerrainBuilder.regionFor).
      // Falls back to mapBounds when no terrain has been applied yet.
      // Without this, the fog wall sat at mapBounds while terrain ran
      // past it, so the extended terrain stayed visible all the way to
      // its hard edge.
      const b = this._terrainRegion || CombatConfig.mapBounds;
      const cam = this.camera.position;
      const corners = [
        { x: b.minX, z: b.minZ },
        { x: b.minX, z: b.maxZ },
        { x: b.maxX, z: b.minZ },
        { x: b.maxX, z: b.maxZ }
      ];
      let maxD2 = 0;
      for (const c of corners) {
        const dx = c.x - cam.x;
        const dy = 5 - cam.y;
        const dz = c.z - cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > maxD2) maxD2 = d2;
      }
      const farCornerDist = Math.sqrt(maxD2);

      fog.near = farCornerDist * 0.6 * s;
      fog.far = farCornerDist * 1.15 * s;
    }
  }

// Called when the casters' world matrices may have changed. The next
  // throttled refresh in render() then re-renders the shadow map.
  markShadowsStale() {
    this._shadowStale = true;
  }

  _handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

// Force a shadow-map refresh on the next render, bypassing the throttle.
  //
  // The throttle alone is correct for stationary soldiers, but wrong for
  // moving ones: the sim tick and the throttle timer are independent
  // clocks (both ~30 Hz but not phase-locked), so on a tick frame the
  // soldier's body is drawn at its new position while the shadow map
  // still holds the previous tick's pose. For 1-2 frames the body is
  // visibly offset from its own shadow — the "body flickers / body
  // appears behind its shadow" artifact.
  //
  // BattleRenderer calls this on every frame the sim has actually
  // advanced, so body and shadow always agree whenever soldier
  // positions change. When paused or stationary, no call is made and
  // the regular throttle takes over (shadow updates at ~30 Hz but
  // positions do not change, so no mismatch is possible).
  //
  // Resetting _lastShadowUpdateMs keeps the regular throttle from ALSO
  // firing the following frame, so the effective refresh rate stays at
  // the sim tick rate rather than doubling.
  forceShadowUpdate() {
    this.renderer.shadowMap.needsUpdate = true;
    this._lastShadowUpdateMs = performance.now();
  }

render() {
    // applySettings resets fog.far; re-derive it from the zoom distance
    // before drawing so a fog toggle never leaves a stale range behind.
    this._updateViewRange();

    // Throttled shadow map refresh. autoUpdate is off (see constructor), so
    // the map only re-renders on frames where needsUpdate is set - three.js
    // clears the flag after that one render. Soldiers move a fraction of a
    // soldier-width per frame, so a 30 Hz map is visually identical to a
    // 60 Hz one while halving the shadow pass cost.
    const now = performance.now();
    if (this._lastRenderMs !== undefined) {
      const dt = Math.min(200, now - this._lastRenderMs);
      this._frameMsEma = this._frameMsEma === undefined
        ? dt
        : this._frameMsEma + (dt - this._frameMsEma) * 0.1;
    }
    this._lastRenderMs = now;
    const minIntervalMs = Math.min(
      SHADOW_MAX_INTERVAL_MS,
      Math.max(1000 / SHADOW_UPDATE_HZ, (this._frameMsEma || 0) * 2)
    );
    if (this._shadowStale && now - this._lastShadowUpdateMs >= minIntervalMs) {
      this._shadowStale = false;
      this.renderer.shadowMap.needsUpdate = true;
      this._lastShadowUpdateMs = now;
    }

    this.renderer.render(this.scene, this.camera);
  }
}
// ===== SoldierInstancer.js =====
// Collapses every soldier's model parts into a handful of InstancedMesh
// draw calls.
//
// HOW IT WORKS
// SoldierView keeps building and animating its normal per-soldier mesh
// tree. When instancing is on, those trees are detached from the scene
// (so the renderer never draws or matrix-updates them) and this class
// walks them once per frame instead:
//   - computes each node's world matrix itself (skipping hidden subtrees),
//   - drops soldiers outside the camera frustum,
//   - writes every visible mesh into a bucket keyed by
//     (geometry, material "look", casts-shadow).
// Each bucket is one InstancedMesh, so draw calls (main pass AND shadow
// pass) scale with the number of distinct shapes, not soldiers.
//
// A material "look" is everything about a material EXCEPT its colour
// (type, side, vertexColors, map, ...). Colour travels per instance
// (instanceColor), so HP / shield tinting no longer splits buckets.
// The bucket material is a white clone; white x instance colour equals the
// original material colour, so the result is pixel-identical.
//
// WALK-POSE LEGS
// A foot soldier's legs are one mesh whose geometry is swapped between 17
// pre-baked poses. Bucketing by geometry would give every pose its own
// bucket (17 per body variant and tier). Instead such a mesh carries a
// `legRig` in userData: the instancer expands it into its 4 parts
// (thigh/shin, left/right) using the same pose matrices the baked
// geometries were built from, so the parts of every pose share one thigh
// geometry and one shin geometry. Pixel-identical, ~17x fewer buckets.
//
// Geometry and material are read from the mesh every frame, so tint
// material swaps, LOD rebuilds and visibility flips done by SoldierView
// need no cooperation from this class.
//
// Not supported (none exist in the codebase): array materials. Such a mesh
// would not draw while instancing is on.
import * as THREE from 'three';
import { computeLegPoseParts } from './SoldierModelComposer.js';

const INITIAL_CAPACITY = 32;

// Soldier bounding sphere used for frustum culling. Cavalry with a 2.4
// long lance is the widest soldier; 5 also leaves a margin so shadows of
// just-off-screen soldiers do not pop in.
const CULL_RADIUS = 15;
const CULL_CENTER_Y = 1;

const IDENTITY = new THREE.Matrix4();
const HIDDEN_LOOK = Object.freeze({ hidden: true });

// Scratch matrix for expanded leg parts.
const _legWorld = new THREE.Matrix4();

// Marks the first `floats` entries of an attribute dirty. Uses the partial
// upload API when the installed three.js has it, falls back to the older
// updateRange object, and otherwise uploads the whole buffer.
function touchAttribute(attr, floats) {
  if (typeof attr.addUpdateRange === 'function') {
    if (typeof attr.clearUpdateRanges === 'function') attr.clearUpdateRanges();
    attr.addUpdateRange(0, floats);
  } else if (attr.updateRange) {
    attr.updateRange.offset = 0;
    attr.updateRange.count = floats;
  }
  attr.needsUpdate = true;
}

export class SoldierInstancer {
  constructor(scene, enabled = true) {
    this.scene = scene;
    this.enabled = !!enabled;

    // Diagnostic switches, driven by RenderBisect only.
    this.debugHidden = false;
    this.debugNoCast = false;

    // geometry -> Map<number (lookId*2 + cast), bucket>
    this._buckets = new Map();
    // Flat list of every bucket, for the per-frame reset / finalize loops.
    this._all = [];

    // material -> look. Materials are few (tinted materials are shared),
    // so the look string is computed once per material.
    this._looks = new WeakMap();
    this._lookByKey = new Map();
    this._nextLookId = 1;

    this._frustum = new THREE.Frustum();
    this._projView = new THREE.Matrix4();
    this._sphere = new THREE.Sphere();

    this._drawnSoldiers = 0;
    this._culledSoldiers = 0;

    this._cpuMsSum = 0;
    this._cpuFrames = 0;
  }

  // Called for every newly created SoldierView. SoldierView adds its own
  // group to the scene in its constructor; when instancing is on that group
  // must come back out.
  adopt(view) {
    if (this.enabled) this.scene.remove(view.group);
  }

  // Switches between instanced and classic rendering at runtime.
  setEnabled(on, views) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;

    for (const view of views) {
      if (on) this.scene.remove(view.group);
      else this.scene.add(view.group);
    }

    if (!on) {
      for (let i = 0; i < this._all.length; i++) {
        const b = this._all[i];
        b.n = 0;
        b.mesh.count = 0;
        b.mesh.visible = false;
      }
    }
  }

  // Rebuilds every bucket from the current soldier poses. Must run after
  // all SoldierView.sync calls and before the renderer draws.
  //
  //   views        iterable of SoldierView
  //   camera       the main camera
  //   shadowCenter { x, z } the point shadow range is measured from
  //   shadowRange  world units; Infinity (or <= 0) = every soldier casts
  update(views, camera, shadowCenter, shadowRange) {
    if (!this.enabled) return;

    const t0 = performance.now();

    camera.updateMatrixWorld();
    this._projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projView);

    const all = this._all;
    for (let i = 0; i < all.length; i++) all[i].n = 0;

    const useRange = shadowRange > 0 && isFinite(shadowRange);
    const range2 = shadowRange * shadowRange;
    const sx = shadowCenter.x;
    const sz = shadowCenter.z;

    const sphere = this._sphere;
    sphere.radius = CULL_RADIUS;

    let drawn = 0;
    let culled = 0;

    for (const view of views) {
      const group = view.group;
      if (!group.visible) continue;

      const p = group.position;
      sphere.center.set(p.x, CULL_CENTER_Y, p.z);
      // Hysteresis on the per-soldier frustum-cull decision.
      //
      // The raw intersectsSphere check flips frame-to-frame for a
      // soldier whose bounding sphere sits right on the frustum
      // boundary — which is exactly what a soldier at the screen edge
      // is during a camera pan. Floating-point precision and the fact
      // that the frustum planes are recomputed every frame make the
      // boolean genuinely unstable there: visible -> culled -> visible
      // -> culled, one flip per frame.
      //
      // Each flip removes the soldier from its instanced bucket for
      // that frame, so the body is not drawn. The shadow map, though,
      // is refreshed on a ~30 Hz throttle (see SceneSetup.render), so
      // on the flip frames the previous shadow is still in the map.
      // Net effect: "the body briefly disappears while its shadow
      // stays where it was" — the flicker this patch removes.
      //
      // Fix: a wider radius for the currently-visible case. A soldier
      // that was visible last frame has to be well outside the frustum
      // (2.5x the normal cull radius) before it is dropped this frame.
      // A soldier that was culled re-enters as soon as it touches the
      // normal radius, so recovery is immediate. The boundary therefore
      // has a proper dead band and cannot flip per frame.
      //
      // The per-view flag needs no initialisation: undefined !== false,
      // so a fresh view starts on the "visible" branch (normal-radius
      // cull) — the safe default.
      sphere.radius = (view._cullVisible === false)
        ? CULL_RADIUS
        : CULL_RADIUS * 2.5;
      const inFrustum = this._frustum.intersectsSphere(sphere);
      sphere.radius = CULL_RADIUS;
      if (!inFrustum) {
        view._cullVisible = false;
        culled++;
        continue;
      }
      view._cullVisible = true;

      let cast = true;
      if (useRange) {
        const dx = p.x - sx;
        const dz = p.z - sz;
        cast = dx * dx + dz * dz <= range2;
      }

      this._walk(group, IDENTITY, cast);
      drawn++;
    }

    // Buckets created during the walk were appended to _all; the loop
    // above is finished, so iterating here is safe.
    for (let i = 0; i < all.length; i++) this._finalize(all[i]);

    this._drawnSoldiers = drawn;
    this._culledSoldiers = culled;

    this._cpuMsSum += performance.now() - t0;
    this._cpuFrames++;
  }

  // One-line summary for the frame diagnostic. Also resets the CPU timer.
  describe() {
    let active = 0;
    let instances = 0;
    for (const b of this._all) {
      if (b.n > 0) {
        active++;
        instances += b.n;
      }
    }
    const cpu = this._cpuFrames > 0 ? this._cpuMsSum / this._cpuFrames : 0;
    this._cpuMsSum = 0;
    this._cpuFrames = 0;

    return `enabled=${this.enabled} buckets=${active}/${this._all.length} ` +
      `parts=${instances} soldiers=${this._drawnSoldiers} culled=${this._culledSoldiers} ` +
      `cpu=${cpu.toFixed(2)}ms`;
  }

  dispose() {
    for (const b of this._all) {
      this.scene.remove(b.mesh);
      b.mesh.dispose();
    }
    for (const look of this._lookByKey.values()) look.material.dispose();
    this._all.length = 0;
    this._buckets.clear();
    this._lookByKey.clear();
  }

  // --- traversal ----------------------------------------------------------

  // Computes world matrices top-down and emits every visible mesh. Hidden
  // subtrees are skipped entirely (their matrices are not needed).
  _walk(node, parentWorld, soldierCast) {
    if (node.matrixAutoUpdate) node.updateMatrix();
    node.matrixWorld.multiplyMatrices(parentWorld, node.matrix);

    if (node.isMesh) this._emit(node, soldierCast);

    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.visible) this._walk(child, node.matrixWorld, soldierCast);
    }
  }

  _emit(mesh, soldierCast) {
    const material = mesh.material;
    if (!material) return;

    const rig = mesh.userData.legRig;
    if (rig) {
      this._emitLegs(mesh, rig, material, soldierCast);
      return;
    }

    const geometry = mesh.geometry;
    if (!geometry) return;
    this._emitPart(geometry, material, mesh.matrixWorld,
      soldierCast && mesh.castShadow === true);
  }

  // Expands a walk-pose leg mesh into its thigh / shin parts for the pose
  // SoldierView last selected. The per-pose local matrices are computed
  // once per rig (shared by every soldier of the same variant and tier).
  _emitLegs(mesh, rig, material, soldierCast) {
    const idx = mesh.userData.poseIdx | 0;
    let parts = rig.local[idx];
    if (!parts) {
      parts = computeLegPoseParts(
        rig.left, rig.right,
        idx === 0 ? -1 : (idx - 1) / rig.poseCount
      );
      rig.local[idx] = parts;
    }

    const cast = soldierCast && mesh.castShadow === true;
    for (let i = 0; i < parts.length; i++) {
      _legWorld.multiplyMatrices(mesh.matrixWorld, parts[i].matrix);
      this._emitPart(parts[i].geometry, material, _legWorld, cast);
    }
  }

  _emitPart(geometry, material, matrix, cast) {
    if (material.visible === false) return;

    let look = this._looks.get(material);
    if (!look) look = this._registerLook(material);
    if (look.hidden) return;

    const bucket = this._bucketFor(geometry, look, cast);

    if (bucket.n >= bucket.cap) this._grow(bucket);

    const i = bucket.n++;
    matrix.toArray(bucket.matArr, i * 16);

    const c = material.color;
    const o = i * 3;
    bucket.colArr[o] = c.r;
    bucket.colArr[o + 1] = c.g;
    bucket.colArr[o + 2] = c.b;
  }

  // --- looks and buckets --------------------------------------------------

  _registerLook(material) {
    if (Array.isArray(material)) {
      this._looks.set(material, HIDDEN_LOOK);
      return HIDDEN_LOOK;
    }

    const key = [
      material.type,
      material.side,
      material.vertexColors ? 1 : 0,
      material.map ? material.map.uuid : '',
      material.transparent ? 1 : 0,
      material.opacity,
      material.alphaTest,
      material.flatShading ? 1 : 0,
      material.fog ? 1 : 0,
      material.emissive ? material.emissive.getHex() : 0
    ].join('|');

    let look = this._lookByKey.get(key);
    if (!look) {
      const clone = material.clone();
      clone.color.setHex(0xffffff);
      look = { hidden: false, id: this._nextLookId++, material: clone };
      this._lookByKey.set(key, look);
    }
    this._looks.set(material, look);
    return look;
  }

  _bucketFor(geometry, look, cast) {
    let perGeometry = this._buckets.get(geometry);
    if (!perGeometry) {
      perGeometry = new Map();
      this._buckets.set(geometry, perGeometry);
    }

    const key = look.id * 2 + (cast ? 1 : 0);
    let bucket = perGeometry.get(key);
    if (!bucket) {
      const mesh = this._buildMesh(geometry, look, cast, INITIAL_CAPACITY);
      this.scene.add(mesh);
      bucket = {
        geometry,
        look,
        cast,
        mesh,
        cap: INITIAL_CAPACITY,
        n: 0,
        matArr: mesh.instanceMatrix.array,
        colArr: mesh.instanceColor.array
      };
      perGeometry.set(key, bucket);
      this._all.push(bucket);
    }
    return bucket;
  }

  _buildMesh(geometry, look, cast, capacity) {
    const mesh = new THREE.InstancedMesh(geometry, look.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    colors.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = colors;

    mesh.castShadow = cast;
    mesh.receiveShadow = false;
    // Instance positions change every frame; the CPU cull above replaces
    // three.js's per-object cull.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    // Picking never touches scene geometry (see BattleRenderer).
    mesh.raycast = () => {};
    mesh.count = 0;
    mesh.visible = false;
    return mesh;
  }

  // Doubles a bucket's capacity. The InstancedMesh is replaced (not just
  // its arrays) so the old GPU buffers are released through dispose().
  _grow(bucket) {
    const next = this._buildMesh(bucket.geometry, bucket.look, bucket.cast, bucket.cap * 2);
    next.instanceMatrix.array.set(bucket.matArr);
    next.instanceColor.array.set(bucket.colArr);

    this.scene.remove(bucket.mesh);
    bucket.mesh.dispose();
    this.scene.add(next);

    bucket.mesh = next;
    bucket.cap *= 2;
    bucket.matArr = next.instanceMatrix.array;
    bucket.colArr = next.instanceColor.array;
  }

  _finalize(bucket) {
    const mesh = bucket.mesh;
    if (bucket.n === 0 || this.debugHidden) {
      mesh.count = 0;
      mesh.visible = false;
      return;
    }
    mesh.castShadow = bucket.cast && !this.debugNoCast;
    mesh.visible = true;
    mesh.count = bucket.n;
    touchAttribute(mesh.instanceMatrix, bucket.n * 16);
    touchAttribute(mesh.instanceColor, bucket.n * 3);
  }
}
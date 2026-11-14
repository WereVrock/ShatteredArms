import * as THREE from 'three';
import { ObstacleKind, TerrainConfig } from '../config/TerrainConfig.js';
import { BiomeList } from '../config/BiomeConfig.js';
import { BiomeTint, DEFAULT_TREE_TINT } from '../config/BiomeTint.js';
import { BiomeVisuals } from '../config/BiomeVisuals.js';
import { RuinModels } from '../config/RuinConfig.js';
import { hash2 } from '../sim/TerrainNoise.js';
import { buildSceneryGeometry } from './BiomeSceneryBuilder.js';
import { MergedMesh } from './camp/CampGeometry.js';

// Biome of the cell an obstacle sits in. Terrain stores biomeGrid as a
// Uint8Array indexed the same way as types. Null when the terrain
// pre-dates the grid (old saved battle).
function biomeAtCell(terrain, x, z) {
  if (!terrain.biomeGrid) return null;
  const i = terrain.cellIndexAt(x, z);
  if (i < 0) return null;
  return BiomeList[terrain.biomeGrid[i]];
}

// How far trunks, rocks and walls sink into the ground so slopes never
// leave a gap under them.
const SINK = 0.15;

// Spatial bucket size (world units) for obstacle instanced meshes.
// Previously each obstacle kind was ONE InstancedMesh with
// frustumCulled = false — with the 5x buffer (±1000) that meant every
// tree, rock, ruin and camp prop was submitted to BOTH the camera pass
// and the shadow pass every frame, regardless of visibility. Chunking
// each kind into ~256-unit buckets gives three.js a tight bounding
// sphere per bucket, so frustum culling finally works — both against
// the main camera and the shadow camera. A typical battle camera now
// submits ~10-20% of the total instance work instead of 100%.
//
// Smaller = finer culling (better FPS), more draw calls.
// Larger = coarser culling, fewer draw calls.
// 256 keeps both manageable at the 5x buffer extent.
const OBSTACLE_CHUNK_SIZE = 256;

// Instanced trees, rocks, walls, columns, bushes, cacti and palms standing
// on the heightfield. Every obstacle kind is split into spatial buckets
// (see OBSTACLE_CHUNK_SIZE) so off-screen instances are frustum-culled.
export class TerrainObstacleView {
  constructor(parent, terrain) {
    this.terrain = terrain;
    this._parent = parent;
    this._meshes = [];
    this._disposables = [];

    this._buildTrees();
    this._buildRocks();
    this._buildWalls();
    this._buildColumns();
    this._buildBushes();
    this._buildCacti();
    this._buildPalms();
    this._buildRuins();
    this._buildScenery();

    // Cache per-mesh bucket centers for the optional distance-culling
    // optimization. Runs once per battle; no per-frame cost.
    this._collectBucketCenters();
  }

  // Snapshot each registered mesh's bounding-sphere centre so
  // updateVisibility can decide per-frame whether the bucket is close
  // enough to render. The bounding sphere was computed at build time
  // (see the computeBoundingSphere calls in each _buildX method).
  _collectBucketCenters() {
    this._bucketEntries = [];
    for (const mesh of this._meshes) {
      if (!mesh.boundingSphere) mesh.computeBoundingSphere();
      if (!mesh.boundingSphere) continue;
      const c = mesh.boundingSphere.center;
      this._bucketEntries.push({ mesh, cx: c.x, cz: c.z });
    }
  }

  // Optional distance culling, driven by the cullDistantObstacles
  // setting. When cameraTarget is null, every bucket is visible (the
  // default — full quality). When a point is supplied, buckets whose
  // center is more than CULL_DISTANCE world units away are hidden.
  // Cheap: one squared-distance test per mesh.
  //
  // CULL_DISTANCE is generous — the battlefield around the camera
  // target is never touched, only the far ring (usually fog-covered),
  // where the visual cost of distant obstacles is lowest.
  updateVisibility(cameraTarget) {
    if (!this._bucketEntries) return;
    if (!cameraTarget) {
      for (const entry of this._bucketEntries) {
        if (!entry.mesh.visible) entry.mesh.visible = true;
      }
      return;
    }
    const CULL_DISTANCE = 400;
    const limitSq = CULL_DISTANCE * CULL_DISTANCE;
    const cx = cameraTarget.x;
    const cz = cameraTarget.z;
    for (const entry of this._bucketEntries) {
      const dx = entry.cx - cx;
      const dz = entry.cz - cz;
      entry.mesh.visible = (dx * dx + dz * dz) < limitSq;
    }
  }

  _of(kind) { return this.terrain.obstacles.filter(o => o.kind === kind); }

  // Groups obstacles by spatial bucket. Returns a Map from a stable key
  // to the list of obstacles in that bucket. Insertion order is
  // preserved (obstacles pushed in terrain.obstacles order), so per-
  // instance RNG (hash2 on index) stays deterministic across rebuilds.
  _bucketBySpatial(obstacles) {
    const bs = OBSTACLE_CHUNK_SIZE;
    const map = new Map();
    for (const o of obstacles) {
      const bx = Math.floor(o.x / bs);
      const bz = Math.floor(o.z / bs);
      const key = bx + ',' + bz;
      let list = map.get(key);
      if (!list) { list = []; map.set(key, list); }
      list.push(o);
    }
    return map;
  }

  // Runs makeMeshFn(list) once per non-empty spatial bucket. Each call
  // is expected to create its own InstancedMesh (or several, for multi-
  // part obstacles like trees) and register them via _parent.add +
  // _meshes.push. The helper only handles bucketing.
  _bucketedMeshes(obstacles, makeMeshFn) {
    const buckets = this._bucketBySpatial(obstacles);
    for (const list of buckets.values()) {
      makeMeshFn(list);
    }
  }

  // Registers a freshly created InstancedMesh with the view: adds it to
  // the scene graph, tracks it for disposal, and applies shadow flags.
  // frustumCulled stays at its default (true) — this is the whole point
  // of chunking.
  _registerMesh(mesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this._parent.add(mesh);
    this._meshes.push(mesh);
    return mesh;
  }

  _buildTrees() {
    const trees = this._of(ObstacleKind.TREE);
    if (!trees.length) return;
    const buckets = { standard: [], dead: [], pine: [], round: [] };
    for (const o of trees) {
      let v = o.variant;
      if (!v) {
        // Backward compat for pre-variant saved terrain.
        const biome = biomeAtCell(this.terrain, o.x, o.z);
        const style = (biome && BiomeVisuals[biome.id] &&
          BiomeVisuals[biome.id].treeStyle) || 'standard';
        v = (style === 'dead') ? 'dead' : 'standard';
      }
      if (buckets[v]) buckets[v].push(o);
      else buckets.standard.push(o);
    }
    if (buckets.standard.length) this._buildStandardTrees(buckets.standard);
    if (buckets.dead.length)     this._buildDeadTrees(buckets.dead);
    if (buckets.pine.length)     this._buildPineTrees(buckets.pine);
    if (buckets.round.length)    this._buildRoundTrees(buckets.round);
  }

  _buildStandardTrees(trees) {
    const t = this.terrain;

    const trunkGeo = new THREE.CylinderGeometry(0.10, 0.17, 1, 6);
    trunkGeo.translate(0, 0.5, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a4630 });
    const crownGeo = new THREE.IcosahedronGeometry(1, 0);
    const crownMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this._disposables.push(trunkGeo, trunkMat, crownGeo, crownMat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(trees, (list) => {
      const trunks = this._registerMesh(
        new THREE.InstancedMesh(trunkGeo, trunkMat, list.length));
      const crowns = this._registerMesh(
        new THREE.InstancedMesh(crownGeo, crownMat, list.length));

      list.forEach((o, i) => {
        const s = o.scale;
        const h = t.heightAt(o.x, o.z);
        const rot = hash2(i, 1, 9) * Math.PI * 2;
        const trunkH = TerrainConfig.tree.trunkHeight * s;

        d.position.set(o.x, h - SINK, o.z);
        d.rotation.set(0, rot, 0);
        d.scale.set(s, trunkH + SINK, s);
        d.updateMatrix();
        trunks.setMatrixAt(i, d.matrix);

        d.position.set(o.x, h + trunkH + 0.9 * s, o.z);
        d.rotation.set(0, rot, 0);
        d.scale.set(1.35 * s, 1.15 * s, 1.35 * s);
        d.updateMatrix();
        crowns.setMatrixAt(i, d.matrix);

        const biome = biomeAtCell(t, o.x, o.z);
        const tint = (biome && BiomeTint[biome.id])
          ? BiomeTint[biome.id].tree
          : DEFAULT_TREE_TINT;
        col.setHSL(
          tint.hue + hash2(i, 2, 9) * tint.hueRange,
          tint.sat,
          tint.lit + hash2(i, 3, 9) * tint.litRange
        );
        crowns.setColorAt(i, col);
      });

      trunks.instanceMatrix.needsUpdate = true;
      crowns.instanceMatrix.needsUpdate = true;
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
      trunks.computeBoundingSphere();
      crowns.computeBoundingSphere();
    });
  }

  // Dead tree — the campaign screen's recursive skeleton baked into a
  // single BufferGeometry, one variant per seeded RNG stream. Three
  // variants are pre-baked; each variant is chunked separately.
  _buildDeadTrees(dead) {
    const t = this.terrain;
    const VARIANTS = 3;

    const buckets = Array.from({ length: VARIANTS }, () => []);
    dead.forEach((o, i) => buckets[i % VARIANTS].push(o));

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    for (let v = 0; v < VARIANTS; v++) {
      const list = buckets[v];
      if (list.length === 0) continue;

      const geo = this._buildDeadTreeVariant(v);
      const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        vertexColors: true
      });
      this._disposables.push(geo, mat);

      this._bucketedMeshes(list, (bucketList) => {
        const mesh = this._registerMesh(
          new THREE.InstancedMesh(geo, mat, bucketList.length));

        bucketList.forEach((o, i) => {
          const h = t.heightAt(o.x, o.z);
          const rot = hash2(i, 1, 9) * Math.PI * 2;
          d.position.set(o.x, h - SINK, o.z);
          d.rotation.set(0, rot, 0);
          d.scale.setScalar(o.scale);
          d.updateMatrix();
          mesh.setMatrixAt(i, d.matrix);

          const shade = 0.85 + hash2(i, 50, 9) * 0.30;
          col.setScalar(shade);
          mesh.setColorAt(i, col);
        });

        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
      });
    }
  }

  // Bakes one dead-tree variant into a single BufferGeometry. Faithful
  // copy of CampScenery.deadTree.
  _buildDeadTreeVariant(seedIndex) {
    const mm = new MergedMesh();
    let a = (0xD00D + seedIndex * 7919) >>> 0;
    const rng = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const limb = (from, dir, len, r, depth) => {
      const to = [
        from[0] + dir[0] * len,
        from[1] + dir[1] * len,
        from[2] + dir[2] * len
      ];
      mm.strut(from, to, r, 0x2e2822, 5, r * 0.6);
      if (depth <= 0) return;
      const n = depth > 1 ? 2 : (rng() < 0.5 ? 1 : 2);
      for (let i = 0; i < n; i++) {
        const d = [
          dir[0] + (rng() - 0.5) * 1.2,
          dir[1] * 0.8 + 0.25,
          dir[2] + (rng() - 0.5) * 1.2
        ];
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        limb(
          to,
          [d[0] / l, d[1] / l, d[2] / l],
          len * 0.72, r * 0.62, depth - 1
        );
      }
    };
    limb([0, 0, 0], [(rng() - 0.5) * 0.2, 1, (rng() - 0.5) * 0.2], 2.4, 0.26, 3);

    const mesh = mm.build();
    mesh.material.dispose();
    return mesh.geometry;
  }

  _buildPineTrees(pines) {
    const t = this.terrain;

    const trunkGeo = new THREE.CylinderGeometry(0.20, 0.14, 1.8, 5);
    trunkGeo.translate(0, 0.9, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a4630 });
    this._disposables.push(trunkGeo, trunkMat);

    const layers = [
      { r: 1.6, h: 2.5, y: 1.1 },
      { r: 1.2, h: 2.2, y: 2.5 },
      { r: 0.8, h: 1.9, y: 3.8 }
    ];
    const coneGeos = layers.map(spec => {
      const g = new THREE.ConeGeometry(spec.r, spec.h, 6, 1, true);
      g.translate(0, spec.y + spec.h / 2, 0);
      this._disposables.push(g);
      return g;
    });
    const coneMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this._disposables.push(coneMat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(pines, (list) => {
      const trunks = this._registerMesh(
        new THREE.InstancedMesh(trunkGeo, trunkMat, list.length));
      const cones = coneGeos.map(g =>
        this._registerMesh(new THREE.InstancedMesh(g, coneMat, list.length)));

      list.forEach((o, i) => {
        const scale = o.scale;
        const h = t.heightAt(o.x, o.z);
        const rot = hash2(i, 1, 9) * Math.PI * 2;

        d.position.set(o.x, h - SINK, o.z);
        d.rotation.set(0, rot, 0);
        d.scale.setScalar(scale);
        d.updateMatrix();
        trunks.setMatrixAt(i, d.matrix);
        for (const m of cones) m.setMatrixAt(i, d.matrix);

        const biome = biomeAtCell(t, o.x, o.z);
        const tint = (biome && BiomeTint[biome.id])
          ? BiomeTint[biome.id].tree : DEFAULT_TREE_TINT;
        col.setHSL(
          tint.hue + hash2(i, 2, 9) * tint.hueRange,
          tint.sat,
          tint.lit + hash2(i, 3, 9) * tint.litRange
        );
        for (const m of cones) m.setColorAt(i, col);
      });

      trunks.instanceMatrix.needsUpdate = true;
      trunks.computeBoundingSphere();
      for (const m of cones) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.computeBoundingSphere();
      }
    });
  }

  _buildRoundTrees(rounds) {
    const t = this.terrain;

    const trunkGeo = new THREE.CylinderGeometry(0.26, 0.18, 2.4, 5);
    trunkGeo.translate(0, 1.2, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a4630 });
    this._disposables.push(trunkGeo, trunkMat);

    const crownGeos = [];
    {
      const g = new THREE.IcosahedronGeometry(1.7, 0);
      g.scale(1, 0.85, 1);
      g.translate(0, 3.3, 0);
      crownGeos.push(g);
    }
    {
      const g = new THREE.IcosahedronGeometry(1.1, 0);
      g.translate(0.9, 2.7, 0.3);
      crownGeos.push(g);
    }
    {
      const g = new THREE.IcosahedronGeometry(1.2, 0);
      g.translate(-0.8, 2.9, -0.5);
      crownGeos.push(g);
    }
    const crownMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this._disposables.push(...crownGeos, crownMat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(rounds, (list) => {
      const trunks = this._registerMesh(
        new THREE.InstancedMesh(trunkGeo, trunkMat, list.length));
      const crowns = crownGeos.map(g =>
        this._registerMesh(new THREE.InstancedMesh(g, crownMat, list.length)));

      list.forEach((o, i) => {
        const scale = o.scale;
        const h = t.heightAt(o.x, o.z);
        const rot = hash2(i, 1, 9) * Math.PI * 2;

        d.position.set(o.x, h - SINK, o.z);
        d.rotation.set(0, rot, 0);
        d.scale.setScalar(scale);
        d.updateMatrix();
        trunks.setMatrixAt(i, d.matrix);
        for (const m of crowns) m.setMatrixAt(i, d.matrix);

        const biome = biomeAtCell(t, o.x, o.z);
        const tint = (biome && BiomeTint[biome.id])
          ? BiomeTint[biome.id].tree : DEFAULT_TREE_TINT;
        col.setHSL(
          tint.hue + hash2(i, 2, 9) * tint.hueRange,
          tint.sat,
          tint.lit + hash2(i, 3, 9) * tint.litRange
        );
        for (let j = 0; j < 3; j++) {
          const c = col.clone();
          c.offsetHSL(
            (hash2(i, 10 + j, 9) - 0.5) * 0.04,
            0,
            (hash2(i, 20 + j, 9) - 0.5) * 0.06
          );
          crowns[j].setColorAt(i, c);
        }
      });

      trunks.instanceMatrix.needsUpdate = true;
      trunks.computeBoundingSphere();
      for (const m of crowns) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.computeBoundingSphere();
      }
    });
  }

  _buildRocks() {
    const rocks = this._of(ObstacleKind.ROCK);
    if (!rocks.length) return;
    const t = this.terrain;

    const geo = new THREE.IcosahedronGeometry(1, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const k = 1 + (hash2(Math.round(x * 100), Math.round(y * 100), Math.round(z * 100)) - 0.5) * 0.35;
      pos.setXYZ(i, x * k, y * k, z * k);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this._disposables.push(geo, mat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(rocks, (list) => {
      const mesh = this._registerMesh(
        new THREE.InstancedMesh(geo, mat, list.length));

      list.forEach((o, i) => {
        d.position.set(o.x, t.heightAt(o.x, o.z) + o.r * 0.3 - SINK * 0.5, o.z);
        d.rotation.set(hash2(i, 4, 7) * 0.4, o.rot, hash2(i, 5, 7) * 0.4);
        d.scale.set(o.r * 1.1, o.r * 0.75, o.r);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
        const g = 0.42 + hash2(i, 6, 7) * 0.16;
        col.setRGB(g, g * 0.98, g * 0.94);
        mesh.setColorAt(i, col);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }

  _buildWalls() {
    const all = this._of(ObstacleKind.WALL);
    if (!all.length) return;
    const stoneWalls = [];
    const fallenLogs = [];
    for (const w of all) {
      if (w.logStyle) fallenLogs.push(w);
      else stoneWalls.push(w);
    }
    this._buildStoneWalls(stoneWalls);
    this._buildFallenLogs(fallenLogs);
  }

  _buildStoneWalls(walls) {
    if (!walls.length) return;
    const t = this.terrain;

    // Chop each wall into ~2 unit blocks so it follows the slope.
    const blocks = [];
    for (const w of walls) {
      const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
      const n = Math.max(1, Math.ceil(len / 2.2));
      const ang = -Math.atan2(w.z2 - w.z1, w.x2 - w.x1);
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n;
        blocks.push({
          x: w.x1 + (w.x2 - w.x1) * f, z: w.z1 + (w.z2 - w.z1) * f,
          len: len / n, ang, h: w.height, t: w.thickness
        });
      }
    }

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this._disposables.push(geo, mat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(blocks, (list) => {
      const mesh = this._registerMesh(
        new THREE.InstancedMesh(geo, mat, list.length));

      list.forEach((b, i) => {
        const h = b.h * (0.9 + hash2(i, 8, 3) * 0.2);
        const total = h + SINK;
        d.position.set(b.x, t.heightAt(b.x, b.z) - SINK + total / 2, b.z);
        d.rotation.set(0, b.ang, 0);
        d.scale.set(b.len * 1.03, total, b.t);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
        const g = 0.46 + hash2(i, 9, 3) * 0.12;
        col.setRGB(g, g * 0.97, g * 0.9);
        mesh.setColorAt(i, col);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }

  _buildFallenLogs(logs) {
    if (!logs.length) return;
    const t = this.terrain;

    const geo = new THREE.CylinderGeometry(0.22, 0.30, 1, 6);
    geo.rotateZ(Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this._disposables.push(geo, mat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(logs, (list) => {
      const mesh = this._registerMesh(
        new THREE.InstancedMesh(geo, mat, list.length));

      list.forEach((o, i) => {
        const len = Math.hypot(o.x2 - o.x1, o.z2 - o.z1);
        const ang = -Math.atan2(o.z2 - o.z1, o.x2 - o.x1);
        const cx = (o.x1 + o.x2) / 2;
        const cz = (o.z1 + o.z2) / 2;
        const h = t.heightAt(cx, cz);

        d.position.set(cx, h + 0.22, cz);
        d.rotation.set(0, ang, 0);
        d.scale.set(len, 1, 1);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);

        const shade = 0.55 + hash2(i, 50, 5) * 0.18;
        col.setRGB(shade * 0.58, shade * 0.42, shade * 0.26);
        mesh.setColorAt(i, col);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }

  _buildColumns() {
    const columns = this._of(ObstacleKind.COLUMN);
    if (!columns.length) return;
    const t = this.terrain;

    const geo = new THREE.CylinderGeometry(0.5, 0.58, 1, 7);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this._disposables.push(geo, mat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(columns, (list) => {
      const mesh = this._registerMesh(
        new THREE.InstancedMesh(geo, mat, list.length));

      list.forEach((o, i) => {
        const h = o.height * (0.6 + hash2(i, 10, 4) * 0.55);
        const tilt = (hash2(i, 11, 4) - 0.5) * 0.18;
        d.position.set(o.x, t.heightAt(o.x, o.z) - SINK, o.z);
        d.rotation.set(tilt, hash2(i, 12, 4) * Math.PI * 2, tilt * 0.5);
        d.scale.set(o.r * 2, h + SINK, o.r * 2);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
        const g = 0.5 + hash2(i, 13, 4) * 0.16;
        col.setRGB(g, g * 0.96, g * 0.88);
        mesh.setColorAt(i, col);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }

  _buildBushes() {
    const bushes = this._of(ObstacleKind.BUSH);
    if (!bushes.length) return;
    const t = this.terrain;
    const cfg = TerrainConfig.bush;

    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this._disposables.push(geo, mat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(bushes, (list) => {
      const mesh = this._registerMesh(
        new THREE.InstancedMesh(geo, mat, list.length));

      list.forEach((o, i) => {
        const s = o.scale;
        const h = t.heightAt(o.x, o.z);
        d.position.set(o.x, h + cfg.height * s * 0.35, o.z);
        d.rotation.set(0, hash2(i, 20, 4) * Math.PI * 2, 0);
        d.scale.set(cfg.radius * s * 1.15, cfg.height * s * 0.65, cfg.radius * s * 1.15);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
        col.setHSL(0.24 + hash2(i, 21, 4) * 0.06, 0.5, 0.18 + hash2(i, 22, 4) * 0.06);
        mesh.setColorAt(i, col);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }

  _buildCacti() {
    const cacti = this._of(ObstacleKind.CACTUS);
    if (!cacti.length) return;
    const t = this.terrain;

    // Bake a proper cactus geometry once — trunk + two arms + rounded
    // caps. Before this the asset was a single tapered cylinder, which
    // read as "a green post" rather than a cactus. The baked geometry is
    // shared across every instance; per-instance variation comes from
    // the instance matrix (rotation + uniform scale + brightness tint).
    // Vertex colours are baked from MergedMesh so the material stays
    // white and instance colours modulate brightness only.
    const geo = this._buildCactusGeometry();
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true
    });
    this._disposables.push(geo, mat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(cacti, (list) => {
      const mesh = this._registerMesh(
        new THREE.InstancedMesh(geo, mat, list.length));

      list.forEach((o, i) => {
        const s = o.scale;
        const h = t.heightAt(o.x, o.z);
        // Uniform scale keeps arm proportions intact. The 0.85..1.15
        // variation matches the old cylinder's per-instance height jitter.
        const heightScale = 0.85 + hash2(i, 30, 4) * 0.30;
        d.position.set(o.x, h - SINK, o.z);
        d.rotation.set(0, hash2(i, 31, 4) * Math.PI * 2, 0);
        d.scale.setScalar(s * heightScale);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
        // Baked vertex colours carry the sage-green hue. Per-instance
        // shade only varies brightness so a patch of cacti does not look
        // like a row of identical clones.
        const shade = 0.85 + hash2(i, 32, 4) * 0.20;
        col.setRGB(shade, shade, shade);
        mesh.setColorAt(i, col);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }

  // Bakes one cactus into a single BufferGeometry:
  //   - main trunk, slightly tapered, with a rounded top cap
  //   - left arm at ~42% height: horizontal stub + upward limb + rounded tip
  //   - right arm at ~58% height: shorter, mirrored on the other side
  //
  // Base at y=0, total height ~2.2 units (matching TerrainConfig.cactus
  // .height=2.0 for the trunk plus the cap). SIDES=7 is an odd number so
  // the flat-shaded silhouette reads as a ribbed saguaro rather than a
  // smooth cylinder.
  _buildCactusGeometry() {
    const mm = new MergedMesh();
    const cfg = TerrainConfig.cactus;
    const H = cfg.height;
    const R = cfg.radius * 1.5;   // visual radius — wider than collision
    const GREEN = 0x5c8a4a;       // muted sage-green, matches old HSL tint
    const SIDES = 7;

    // Main trunk.
    mm.strut([0, 0, 0], [0, H, 0], R, GREEN, SIDES, R * 0.85);
    // Rounded top.
    mm.strut([0, H, 0], [0, H + R * 0.5, 0], R * 0.85, GREEN, SIDES, 0);

    // Left arm.
    const armY = H * 0.42;
    const armR = R * 0.55;
    const armLen = R * 0.95;
    const armUp = H * 0.30;
    const armX = -R * 0.65;
    mm.strut([armX, armY, 0], [armX - armLen, armY, 0],
      armR, GREEN, SIDES, armR);
    mm.strut([armX - armLen, armY, 0], [armX - armLen, armY + armUp, 0],
      armR, GREEN, SIDES, armR * 0.75);
    mm.strut([armX - armLen, armY + armUp, 0],
      [armX - armLen, armY + armUp + armR * 0.5, 0],
      armR * 0.75, GREEN, SIDES, 0);

    // Right arm — higher, shorter.
    const armY2 = H * 0.58;
    const armR2 = R * 0.45;
    const armLen2 = R * 0.80;
    const armUp2 = H * 0.22;
    const armX2 = R * 0.65;
    mm.strut([armX2, armY2, 0], [armX2 + armLen2, armY2, 0],
      armR2, GREEN, SIDES, armR2);
    mm.strut([armX2 + armLen2, armY2, 0],
      [armX2 + armLen2, armY2 + armUp2, 0],
      armR2, GREEN, SIDES, armR2 * 0.75);
    mm.strut([armX2 + armLen2, armY2 + armUp2, 0],
      [armX2 + armLen2, armY2 + armUp2 + armR2 * 0.5, 0],
      armR2 * 0.75, GREEN, SIDES, 0);

    const mesh = mm.build();
    mesh.material.dispose();
    return mesh.geometry;
  }

  _buildPalms() {
    const palms = this._of(ObstacleKind.PALM);
    if (!palms.length) return;
    const t = this.terrain;
    const cfg = TerrainConfig.palm;

    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.20, 1, 6);
    trunkGeo.translate(0, 0.5, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b5233 });
    const crownGeo = new THREE.IcosahedronGeometry(1, 0);
    const crownMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this._disposables.push(trunkGeo, trunkMat, crownGeo, crownMat);

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    this._bucketedMeshes(palms, (list) => {
      const trunks = this._registerMesh(
        new THREE.InstancedMesh(trunkGeo, trunkMat, list.length));
      const crowns = this._registerMesh(
        new THREE.InstancedMesh(crownGeo, crownMat, list.length));

      list.forEach((o, i) => {
        const s = o.scale;
        const h = t.heightAt(o.x, o.z);
        const rot = hash2(i, 40, 4) * Math.PI * 2;
        const trunkH = cfg.trunkHeight * s;

        d.position.set(o.x, h - SINK, o.z);
        d.rotation.set(0, rot, 0);
        d.scale.set(s, trunkH + SINK, s);
        d.updateMatrix();
        trunks.setMatrixAt(i, d.matrix);

        d.position.set(o.x, h + trunkH + 0.15, o.z);
        d.rotation.set(0, rot, 0);
        d.scale.set(cfg.crownRadius * s * 1.2, 0.32 * s, cfg.crownRadius * s * 1.2);
        d.updateMatrix();
        crowns.setMatrixAt(i, d.matrix);

        col.setHSL(0.22 + hash2(i, 41, 4) * 0.06, 0.5, 0.24 + hash2(i, 42, 4) * 0.08);
        crowns.setColorAt(i, col);
      });

      trunks.instanceMatrix.needsUpdate = true;
      crowns.instanceMatrix.needsUpdate = true;
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
      trunks.computeBoundingSphere();
      crowns.computeBoundingSphere();
    });
  }

  // Lazily-built shared primitive geometries for ruin models.
  _primitive(shape) {
    if (!this._primCache) this._primCache = new Map();
    if (this._primCache.has(shape)) return this._primCache.get(shape);

    let geo;
    switch (shape) {
      case 'box':       geo = new THREE.BoxGeometry(1, 1, 1); break;
      case 'cylinder':  geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8); break;
      case 'taper':     geo = new THREE.CylinderGeometry(0.35, 0.55, 1, 6); break;
      case 'cone':      geo = new THREE.CylinderGeometry(0, 0.5, 1, 8); break;
      case 'ico':       geo = new THREE.IcosahedronGeometry(0.5, 0); break;
      case 'icoHi':     geo = new THREE.IcosahedronGeometry(0.5, 1); break;
      case 'prism':     geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 3); break;
      default:          geo = new THREE.BoxGeometry(1, 1, 1); break;
    }
    this._primCache.set(shape, geo);
    this._disposables.push(geo);
    return geo;
  }

  // Composite ruin models — one InstancedMesh per (model, part, spatial
  // bucket). Geometries are shared from _primitive; materials are one
  // per (model, part) and shared across buckets.
  _buildRuins() {
    const ruins = this._of(ObstacleKind.RUIN);
    if (!ruins.length) return;
    const t = this.terrain;

    const byModel = new Map();
    for (const o of ruins) {
      if (!byModel.has(o.modelId)) byModel.set(o.modelId, []);
      byModel.get(o.modelId).push(o);
    }

    const d = new THREE.Object3D();
    const col = new THREE.Color();
    const qLocal = new THREE.Quaternion();
    const qWorld = new THREE.Quaternion();
    const eLocal = new THREE.Euler(0, 0, 0, 'XYZ');
    const Y_AXIS = new THREE.Vector3(0, 1, 0);

    for (const [modelId, list] of byModel) {
      const model = RuinModels[modelId];
      if (!model) continue;

      for (let p = 0; p < model.parts.length; p++) {
        const part = model.parts[p];
        const geo = this._primitive(part.shape);
        const baseColor = part.color || model.color;
        const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
        this._disposables.push(mat);

        this._bucketedMeshes(list, (bucketList) => {
          const mesh = this._registerMesh(
            new THREE.InstancedMesh(geo, mat, bucketList.length));

          bucketList.forEach((o, i) => {
            const h = t.heightAt(o.x, o.z);
            const oRot = o.rot || 0;

            const lx = part.offset[0];
            const ly = part.offset[1];
            const lz = part.offset[2];
            const cosR = Math.cos(oRot);
            const sinR = Math.sin(oRot);
            const ox = lx * cosR - lz * sinR;
            const oz = lx * sinR + lz * cosR;

            d.position.set(o.x + ox, h + ly, o.z + oz);
            d.scale.set(part.scale[0], part.scale[1], part.scale[2]);

            if (part.rot) {
              eLocal.set(part.rot[0], part.rot[1], part.rot[2]);
              qLocal.setFromEuler(eLocal);
              qWorld.setFromAxisAngle(Y_AXIS, oRot);
              d.quaternion.copy(qWorld).multiply(qLocal);
            } else {
              d.rotation.set(0, oRot, 0);
            }

            d.updateMatrix();
            mesh.setMatrixAt(i, d.matrix);

            const hash = hash2(
              Math.floor(o.x * 100),
              Math.floor(o.z * 100),
              9
            );
            const shade = 0.90 + hash * 0.18;
            col.setRGB(
              baseColor[0] * shade,
              baseColor[1] * shade,
              baseColor[2] * shade
            );
            mesh.setColorAt(i, col);
          });

          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.computeBoundingSphere();
        });
      }
    }
  }

  // Camp-style scenery props — one InstancedMesh per (modelId, bucket).
  _buildScenery() {
    const sites = this._of(ObstacleKind.SCENERY);
    if (!sites.length) return;
    const t = this.terrain;

    const byModel = new Map();
    for (const o of sites) {
      if (!byModel.has(o.modelId)) byModel.set(o.modelId, []);
      byModel.get(o.modelId).push(o);
    }

    const d = new THREE.Object3D();
    const col = new THREE.Color();

    for (const [modelId, list] of byModel) {
      const built = this._sceneryGeometry(modelId);
      if (!built) continue;

      this._bucketedMeshes(list, (bucketList) => {
        const mesh = this._registerMesh(
          new THREE.InstancedMesh(built.geometry, built.material, bucketList.length));

        bucketList.forEach((o, i) => {
          d.position.set(o.x, t.heightAt(o.x, o.z), o.z);
          d.rotation.set(0, o.rot || 0, 0);
          d.scale.set(1, 1, 1);
          d.updateMatrix();
          mesh.setMatrixAt(i, d.matrix);

          const hash = hash2(
            Math.floor(o.x * 100),
            Math.floor(o.z * 100),
            9
          );
          const shade = 0.92 + hash * 0.12;
          col.setRGB(shade, shade, shade);
          mesh.setColorAt(i, col);
        });

        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
      });
    }
  }

  _sceneryGeometry(modelId) {
    if (!this._sceneryGeoCache) this._sceneryGeoCache = new Map();
    let built = this._sceneryGeoCache.get(modelId);
    if (built) return built;
    built = buildSceneryGeometry(modelId);
    if (built) {
      this._sceneryGeoCache.set(modelId, built);
      this._disposables.push(built.geometry, built.material);
    }
    return built;
  }

  dispose() {
    for (const m of this._meshes) this._parent.remove(m);
    for (const d of this._disposables) d.dispose();
    this._meshes.length = 0;
    this._disposables.length = 0;
    if (this._primCache) this._primCache.clear();
    if (this._sceneryGeoCache) this._sceneryGeoCache.clear();
  }
}
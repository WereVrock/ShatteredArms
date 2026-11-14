import * as THREE from 'three';
import { TerrainTypes } from '../config/TerrainConfig.js';
import { BiomeList } from '../config/BiomeConfig.js';
import { BiomeVisuals, TERRAIN_TYPE_KEY } from '../config/BiomeVisuals.js';
import { hash2, vnoise } from '../sim/TerrainNoise.js';

// Pixels per terrain cell, per axis, in the colour overlay texture.
// The INITIAL battle-load build uses this smaller value so the first
// frame after a battle load ships quickly (this was the value that made
// load fast before the 5x buffer made the texture build dominate). A
// follow-up idle callback re-builds the overlay at TARGET_TEX_SCALE and
// swaps it into the shader — see upgradeOverlayTexture() and
// BattleTerrainSetup.scheduleProgressiveUpgrade(). Players get a fast
// load followed by the authored crispness a moment later.
const TEX_SCALE = 2;
const TARGET_TEX_SCALE = 3;
// Must equal SceneSetup's GROUND_EXTENT: the base UV span matches the flat
// ground's plane so the grass texture tiles identically.
const GROUND_UV_SPAN = 6000;
// Terrain cells per chunk edge. See the previous version of this file — the
// chunk grid is what makes frustum culling work on the terrain mesh.
const CHUNK_CELLS = 48;
// Detail grain UV multiplier. Terrain uv spans 0..(2000/6000)=0.333, so
// 2000 here gives ~667 tiles across the 2000-unit buffer extent, ~3 world
// units per tile. Tunable, purely visual.
const DETAIL_UV_SCALE = 2000.0;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Small tiling grain texture. Sampled with a high-frequency UV multiply in
// the merged shader below to give sand / mud / rocky patches the fine
// within-cell texture the overlay alone cannot provide.
function buildDetailTexture() {
  const SIZE = 64;
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const fine = hash2(x, y, 42);
      const coarse = hash2(x >> 2, y >> 2, 43);
      const v = Math.min(255, Math.max(0,
        Math.round((fine * 0.55 + coarse * 0.45) * 255)
      ));
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// The displaced ground: a heightfield mesh over the generated region,
// split into CHUNK_CELLS×CHUNK_CELLS tiles. Each chunk is ONE mesh with
// ONE material that samples both the base grass texture and the terrain
// colour overlay, blending them in the fragment shader.
//
// The overlay texture is built at the FAST TEX_SCALE first and swapped
// for the authored TARGET_TEX_SCALE via upgradeOverlayTexture() once the
// browser is idle. Chunk geometry is never rebuilt — only the sampler
// uniform is reassigned, which is a pointer write.
export class TerrainSurfaceView {
  constructor(parent, terrain, groundMaterial) {
    this.terrain = terrain;
    this._parent = parent;
    this._meshes = [];
    this._disposables = [];

    const b = terrain.bounds;
    const cs = terrain.cellSize;
    const r = terrain.region || b;
    const ix0 = Math.max(0, Math.floor((r.minX - b.minX) / cs));
    const iz0 = Math.max(0, Math.floor((r.minZ - b.minZ) / cs));
    const ix1 = Math.min(terrain.cols, Math.ceil((r.maxX - b.minX) / cs));
    const iz1 = Math.min(terrain.rows, Math.ceil((r.maxZ - b.minZ) / cs));
    const cx = ix1 - ix0;
    const cz = iz1 - iz0;
    this._ix0 = ix0;
    this._iz0 = iz0;
    this._cx = cx;
    this._cz = cz;

    // Initial (fast) overlay texture.
    this._currentTexScale = TEX_SCALE;
    this._overlayTex = this._buildOverlayTexture(TEX_SCALE);
    // Populated by onBeforeCompile below; upgradeOverlayTexture() uses it
    // to swap the sampler WITHOUT recompiling the shader or touching any
    // chunk geometry.
    this._overlayUniform = null;

    const detailTex = buildDetailTexture();

    // White 1x1 placeholder, used when groundMaterial.map is null. Keeps
    // USE_MAP always on so a texture toggle does NOT trigger a shader
    // recompile — just a texture swap.
    this._placeholderTex = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    this._placeholderTex.needsUpdate = true;

    const mergedMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: groundMaterial.map || this._placeholderTex,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

    mergedMat.onBeforeCompile = (shader) => {
      shader.uniforms.overlayMap = { value: this._overlayTex };
      shader.uniforms.detailTex = { value: detailTex };
      // Stable reference so upgradeOverlayTexture() can replace the
      // sampled texture in place.
      this._overlayUniform = shader.uniforms.overlayMap;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `
          #include <common>
          attribute vec2 overlayUv;
          varying vec2 vOverlayUv;
          varying vec2 vDetailUv;
        `)
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          vOverlayUv = overlayUv;
          vDetailUv = uv * ${DETAIL_UV_SCALE.toFixed(1)};
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `
          #include <common>
          uniform sampler2D overlayMap;
          uniform sampler2D detailTex;
          varying vec2 vOverlayUv;
          varying vec2 vDetailUv;
        `)
        .replace('#include <map_fragment>', `
          #include <map_fragment>
          vec4 ovCol = texture2D(overlayMap, vOverlayUv);
          float detail = texture2D(detailTex, vDetailUv).r;
          vec3 ovRgb = ovCol.rgb * (0.82 + detail * 0.36);
          diffuseColor.rgb = mix(diffuseColor.rgb, ovRgb, ovCol.a);
        `);
    };

    this._syncMaterial = () => {
      const targetMap = groundMaterial.map || this._placeholderTex;
      if (mergedMat.map !== targetMap) mergedMat.map = targetMap;
      if (!mergedMat.color.equals(groundMaterial.color)) {
        mergedMat.color.copy(groundMaterial.color);
      }
    };

    this._disposables.push(mergedMat, this._overlayTex, detailTex, this._placeholderTex);

    for (let jz = 0; jz < cz; jz += CHUNK_CELLS) {
      const nz = Math.min(CHUNK_CELLS, cz - jz);
      for (let jx = 0; jx < cx; jx += CHUNK_CELLS) {
        const nx = Math.min(CHUNK_CELLS, cx - jx);
        this._buildChunk(ix0 + jx, iz0 + jz, nx, nz, mergedMat);
      }
    }
  }

  _buildChunk(cellX0, cellZ0, nx, nz, material) {
    const terrain = this.terrain;
    const b = terrain.bounds;
    const cs = terrain.cellSize;
    const H = terrain.height;
    const vx = nx + 1;
    const vz = nz + 1;
    const count = vx * vz;

    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const uvBase = new Float32Array(count * 2);
    const uvOver = new Float32Array(count * 2);

    for (let j = 0; j < vz; j++) {
      for (let i = 0; i < vx; i++) {
        const gi = cellX0 + i;
        const gj = cellZ0 + j;
        const x = b.minX + gi * cs;
        const z = b.minZ + gj * cs;
        const k = j * vx + i;

        pos[k * 3] = x;
        pos[k * 3 + 1] = H.getVertex(gi, gj);
        pos[k * 3 + 2] = z;

        const nxV = (H.getVertex(gi - 1, gj) - H.getVertex(gi + 1, gj)) / (2 * cs);
        const nzV = (H.getVertex(gi, gj - 1) - H.getVertex(gi, gj + 1)) / (2 * cs);
        const inv = 1 / Math.sqrt(nxV * nxV + 1 + nzV * nzV);
        nor[k * 3] = nxV * inv;
        nor[k * 3 + 1] = inv;
        nor[k * 3 + 2] = nzV * inv;

        uvBase[k * 2] = (x + GROUND_UV_SPAN / 2) / GROUND_UV_SPAN;
        uvBase[k * 2 + 1] = 0.5 - z / GROUND_UV_SPAN;
        uvOver[k * 2] = (cellX0 - this._ix0 + i) / this._cx;
        uvOver[k * 2 + 1] = (cellZ0 - this._iz0 + j) / this._cz;
      }
    }

    const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
    const idx = new IndexArray(nx * nz * 6);
    let w = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * vx + i, bb = a + 1, c = a + vx, d = c + 1;
        idx[w++] = a; idx[w++] = c; idx[w++] = bb;
        idx[w++] = bb; idx[w++] = c; idx[w++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvBase, 2));
    geo.setAttribute('overlayUv', new THREE.BufferAttribute(uvOver, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.onBeforeRender = this._syncMaterial;
    this._parent.add(mesh);
    this._meshes.push(mesh);
    this._disposables.push(geo);
  }

  // texScale is the pixels-per-cell used for THIS build. Default is the
  // fast TEX_SCALE used at load time; upgradeOverlayTexture() passes the
  // higher TARGET_TEX_SCALE.
  _buildOverlayTexture(texScale = TEX_SCALE) {
    const t = this.terrain;
    const W = this._cx * texScale;
    const H = this._cz * texScale;
    const data = new Uint8Array(W * H * 4);
    const grass = TerrainTypes[0].color;

    const cellCount = t.cols * t.rows;
    const tintR = new Uint8Array(cellCount);
    const tintG = new Uint8Array(cellCount);
    const tintB = new Uint8Array(cellCount);
    const tintA = new Uint8Array(cellCount);

    for (let iz = 0; iz < t.rows; iz++) {
      for (let ix = 0; ix < t.cols; ix++) {
        const idx = iz * t.cols + ix;
        const type = t.types[idx];
        const def = TerrainTypes[type];
        if (def.alpha === 0) continue;

        let color = def.color;
        let alpha = def.alpha;
        const biomeId = t.biomeGrid ? BiomeList[t.biomeGrid[idx]].id : null;
        const override = biomeId && BiomeVisuals[biomeId] &&
          BiomeVisuals[biomeId].ground &&
          BiomeVisuals[biomeId].ground[TERRAIN_TYPE_KEY[type]];
        if (override) {
          if (override.color) color = override.color;
          else if (Array.isArray(override)) color = override;
          if (typeof override.alpha === 'number') alpha = override.alpha;
        }

        const snowH = biomeId && BiomeVisuals[biomeId] && BiomeVisuals[biomeId].snowHeight;
        if (snowH !== undefined) {
          const cellH = t.heightAt(t.cellCenterX(ix), t.cellCenterZ(iz));
          if (cellH > snowH) {
            const snowAmt = Math.min(1, (cellH - snowH) / 4);
            const blend = snowAmt * 0.88;
            color = [
              color[0] + (255 - color[0]) * blend,
              color[1] + (255 - color[1]) * blend,
              color[2] + (255 - color[2]) * blend
            ];
          }
        }

        tintR[idx] = color[0];
        tintG[idx] = color[1];
        tintB[idx] = color[2];
        tintA[idx] = alpha * 255;
      }
    }

    // Precompute jitter + shade at 1/4 resolution; reuse per 2x2 block.
    // The jitter/shade fields are smooth noise, and one cell maps to
    // texScale pixels, so sampling at 2-pixel blocks is visually
    // identical while cutting the noise work 4x. The per-pixel grain
    // hash stays per-pixel — that IS the fine texture.
    const JIT_BLOCK = 2;
    const jitW = Math.ceil(W / JIT_BLOCK);
    const jitH = Math.ceil(H / JIT_BLOCK);
    const jitterX = new Float32Array(jitW * jitH);
    const jitterZ = new Float32Array(jitW * jitH);
    const shadeField = new Float32Array(jitW * jitH);
    for (let jy = 0; jy < jitH; jy++) {
      for (let jx = 0; jx < jitW; jx++) {
        const u = this._ix0 + (jx * JIT_BLOCK + 0.5) / texScale;
        const v = this._iz0 + (jy * JIT_BLOCK + 0.5) / texScale;
        const off = jy * jitW + jx;
        jitterX[off] = (vnoise(u * 0.9 + 13.1, v * 0.9, 7) - 0.5) * 1.4;
        jitterZ[off] = (vnoise(u * 0.9, v * 0.9 + 71.7, 11) - 0.5) * 1.4;
        shadeField[off] = 0.88 + vnoise(u * 3.1, v * 3.1, 3) * 0.24;
      }
    }

    for (let pz = 0; pz < H; pz++) {
      const jy = pz >> 1;
      const v = this._iz0 + (pz + 0.5) / texScale;
      const jitterRow = jy * jitW;
      for (let px = 0; px < W; px++) {
        const jx = px >> 1;
        const jOff = jitterRow + jx;
        const u = this._ix0 + (px + 0.5) / texScale;
        const cx = clamp(Math.floor(u + jitterX[jOff]), 0, t.cols - 1);
        const cz = clamp(Math.floor(v + jitterZ[jOff]), 0, t.rows - 1);
        const cellIdx = cz * t.cols + cx;

        const idx = (pz * W + px) * 4;
        if (tintA[cellIdx] === 0) {
          data[idx] = grass[0]; data[idx + 1] = grass[1]; data[idx + 2] = grass[2]; data[idx + 3] = 0;
          continue;
        }

        const shade = shadeField[jOff] + (hash2(px, pz, 5) - 0.5) * 0.08;
        data[idx]     = Math.min(255, tintR[cellIdx] * shade);
        data[idx + 1] = Math.min(255, tintG[cellIdx] * shade);
        data[idx + 2] = Math.min(255, tintB[cellIdx] * shade);
        data[idx + 3] = tintA[cellIdx];
      }
    }

    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    if (THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  // Progressive quality upgrade. Rebuilds the overlay texture at
  // targetScale and swaps it into the shader uniform — no chunk geometry
  // is touched, no shader recompile, no per-frame cost. Called from
  // BattleTerrainSetup.scheduleProgressiveUpgrade() after the first
  // render has shipped. Safe to call at any time: no-op when the shader
  // has not compiled yet, or when targetScale is not higher than the
  // current scale (never downgrades).
  upgradeOverlayTexture(targetScale = TARGET_TEX_SCALE) {
    if (!this._overlayUniform) return;   // shader not compiled yet
    if (targetScale <= this._currentTexScale) return;

    const newTex = this._buildOverlayTexture(targetScale);
    const oldTex = this._overlayTex;

    this._overlayUniform.value = newTex;
    this._overlayTex = newTex;
    this._currentTexScale = targetScale;

    // Release the old texture immediately so VRAM is reclaimed without
    // waiting for the whole view to be disposed.
    if (oldTex) oldTex.dispose();

    this._disposables.push(newTex);
  }

  dispose() {
    for (const m of this._meshes) this._parent.remove(m);
    for (const d of this._disposables) d.dispose();
    this._meshes.length = 0;
    this._disposables.length = 0;
  }
}
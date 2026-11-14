import * as THREE from 'three';
import { buildWaterField } from './WaterField.js';
import { createWaterMaterial, createSimpleWaterMaterial } from './WaterShader.js';
import { SettingsStore } from '../ui/settings/SettingsStore.js';
import { BiomeVisuals } from '../config/BiomeVisuals.js';

// Tiny lift so the surface never z-fights shore vertices set to the lake
// level.
const WATER_LIFT = 0.04;
// Water is split into tiles of this many terrain cells per side. Only
// tiles that contain water get a mesh, and each is frustum-culled on its
// own.
const CHUNK_CELLS = 16;

// Water effects are ON unless the setting is explicitly false.
function effectsOn() {
  return SettingsStore.get().waterEffects !== false;
}

// The water surface: flat transparent meshes at terrain.waterLevel, one per
// tile that touches water. The shader cuts the shoreline from the
// per-vertex wetness. With effects on it animates from the wall clock (so
// it keeps moving while paused); with effects off it is a static flat tint
// and the animated shader is never even compiled. Follows the
// `waterEffects` setting live.
export class TerrainWaterView {
  constructor(parent, terrain) {
    this._parent = parent;
    this._meshes = [];
    this._geometries = [];
    this._full = null;
    this._simple = null;
    this._disposed = false;
    this._unsub = null;
    this._effects = effectsOn();

    // Called before each visible tile draws; any visible tile refreshes the
    // shared clock, so it never freezes while at least one tile is on screen.
    this._tick = () => {
      if (this._effects && this._full) {
        this._full.uniforms.uTime.value = performance.now() * 0.001;
      }
    };

    const field = buildWaterField(terrain);
    if (!field.hasWater) return;

    this._buildChunks(field, terrain);
    if (this._meshes.length === 0) return;

    const unsub = SettingsStore.subscribe(() => this._onSettings());
    this._unsub = typeof unsub === 'function' ? unsub : null;
  }

  _currentMaterial() {
    const wc = this._biomeWaterColors();
    if (this._effects) {
      if (!this._full) this._full = createWaterMaterial(wc);
      return this._full;
    }
    if (!this._simple) this._simple = createSimpleWaterMaterial(wc);
    return this._simple;
  }

  // Per-biome water tint. Reads terrain.dominantBiome; falls back to the
  // shader defaults when the terrain predates biome data or the biome
  // has no water block.
  _biomeWaterColors() {
    const biomeId = this.terrain && this.terrain.dominantBiome;
    const v = biomeId && BiomeVisuals[biomeId];
    if (v && v.water) {
      return { shallow: v.water.shallow, deep: v.water.deep };
    }
    return {};
  }

  _buildChunks(field, terrain) {
    const { ix0, iz0, cx, cz, data } = field;
    const b = terrain.bounds;
    const cs = terrain.cellSize;
    const y = (terrain.waterLevel || 0) + WATER_LIFT;
    const stride = cx + 1;
    const material = this._currentMaterial();

    for (let cj = 0; cj < cz; cj += CHUNK_CELLS) {
      const nz = Math.min(CHUNK_CELLS, cz - cj);
      for (let ci = 0; ci < cx; ci += CHUNK_CELLS) {
        const nx = Math.min(CHUNK_CELLS, cx - ci);
        const vx = nx + 1;
        const vz = nz + 1;

        const pos = new Float32Array(vx * vz * 3);
        const wat = new Float32Array(vx * vz * 2);
        let anyWet = false;
        for (let j = 0; j < vz; j++) {
          for (let i = 0; i < vx; i++) {
            const gi = ci + i;
            const gj = cj + j;
            const src = (gj * stride + gi) * 2;
            const k = j * vx + i;
            pos[k * 3] = b.minX + (ix0 + gi) * cs;
            pos[k * 3 + 1] = y;
            pos[k * 3 + 2] = b.minZ + (iz0 + gj) * cs;
            wat[k * 2] = data[src];
            wat[k * 2 + 1] = data[src + 1];
            if (data[src] > 0) anyWet = true;
          }
        }
        if (!anyWet) continue;

        // Same winding as the terrain surface: faces up.
        const indices = [];
        for (let j = 0; j < nz; j++) {
          for (let i = 0; i < nx; i++) {
            const a = j * vx + i;
            const bb = a + 1;
            const c = a + vx;
            const d = c + 1;
            if (wat[a * 2] <= 0 && wat[bb * 2] <= 0 && wat[c * 2] <= 0 && wat[d * 2] <= 0) continue;
            indices.push(a, c, bb, bb, c, d);
          }
        }
        if (indices.length === 0) continue;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aWater', new THREE.BufferAttribute(wat, 2));
        geo.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));

        const mesh = new THREE.Mesh(geo, material);
        mesh.renderOrder = 2;
        mesh.receiveShadow = false;
        mesh.castShadow = false;
        mesh.onBeforeRender = this._tick;
        this._parent.add(mesh);

        this._geometries.push(geo);
        this._meshes.push(mesh);
      }
    }
  }

  _onSettings() {
    if (this._disposed) return;
    const on = effectsOn();
    if (on === this._effects) return;
    this._effects = on;
    const material = this._currentMaterial();
    for (let i = 0; i < this._meshes.length; i++) {
      this._meshes[i].material = material;
    }
  }

  dispose() {
    this._disposed = true;
    if (this._unsub) { this._unsub(); this._unsub = null; }
    for (const m of this._meshes) this._parent.remove(m);
    for (const g of this._geometries) g.dispose();
    if (this._full) this._full.dispose();
    if (this._simple) this._simple.dispose();
    this._meshes.length = 0;
    this._geometries.length = 0;
    this._full = null;
    this._simple = null;
  }
}
import * as THREE from 'three';
import { TerrainSurfaceView } from './TerrainSurfaceView.js';
import { TerrainObstacleView } from './TerrainObstacleView.js';
import { TerrainWaterView } from './TerrainWaterView.js';
import { SettingsStore } from '../ui/settings/SettingsStore.js';

const MAX_DEBUG_VERTS = 8192;
const DEBUG_LIFT = 0.3;

// Composes the terrain visuals (surface, obstacles) and the optional debug
// overlay of selected units' planned paths.
export class TerrainView {
  constructor(sceneSetup, terrain) {
    this._sceneSetup = sceneSetup;
    this.scene = sceneSetup.scene;
    this.terrain = terrain;
    this.debugPaths = false;
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.surface = new TerrainSurfaceView(this.group, terrain, sceneSetup.ground.material);
    this.obstacles = new TerrainObstacleView(this.group, terrain);
    this.water = new TerrainWaterView(this.group, terrain);
    this._buildDebugLines();
  }

  setDebugPaths(on) { this.debugPaths = !!on; }

  _buildDebugLines() {
    const geo = new THREE.BufferGeometry();
    this._debugPos = new Float32Array(MAX_DEBUG_VERTS * 3);
    const attr = new THREE.BufferAttribute(this._debugPos, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ color: 0x00e5ff, transparent: true, depthTest: false });
    this._debugLine = new THREE.LineSegments(geo, mat);
    this._debugLine.renderOrder = 999;
    this._debugLine.frustumCulled = false;
    this._debugLine.visible = false;
    this.group.add(this._debugLine);
    this._debugGeo = geo;
    this._debugMat = mat;
  }

  // Appends a path as line segments starting at (px, pz). Returns the new vertex count.
  _appendPath(path, startIdx, px, pz, n) {
    const pos = this._debugPos;
    const t = this.terrain;
    for (let i = startIdx; i < path.length; i++) {
      if (n + 2 > MAX_DEBUG_VERTS) break;
      const w = path[i];
      pos[n * 3] = px; pos[n * 3 + 1] = t.heightAt(px, pz) + DEBUG_LIFT; pos[n * 3 + 2] = pz; n++;
      pos[n * 3] = w.x; pos[n * 3 + 1] = t.heightAt(w.x, w.z) + DEBUG_LIFT; pos[n * 3 + 2] = w.z; n++;
      px = w.x; pz = w.z;
    }
    return n;
  }

  // Call once per frame from the render loop.
  syncPaths(unitsById) {
    // Optional distance culling for obstacles. Off by default
    // (cullDistantObstacles is false) — full quality. Toggled from
    // Settings → Graphics → Quality. Runs before the debug-path branch
    // so it fires regardless of debug paths.
    if (this.obstacles) {
      const cull = SettingsStore.get().cullDistantObstacles === true;
      if (cull && this._sceneSetup && this._sceneSetup.cameraTarget) {
        this.obstacles.updateVisibility(this._sceneSetup.cameraTarget);
      } else {
        this.obstacles.updateVisibility(null);
      }
    }

    if (!this.debugPaths) {
      if (this._debugLine.visible) this._debugLine.visible = false;
      return;
    }
    let n = 0;
    for (const unit of unitsById.values()) {
      if (!unit.selected) continue;
      if (unit._path) {
        n = this._appendPath(unit._path, unit._pathIdx,
          unit.formationMarchOrigin.x, unit.formationMarchOrigin.z, n);
      }
      if (unit._directPath) {
        const c = unit.getCenter();
        n = this._appendPath(unit._directPath, 0, c.x, c.z, n);
      }
    }
    this._debugGeo.setDrawRange(0, n);
    this._debugGeo.attributes.position.needsUpdate = true;
    this._debugLine.visible = n > 0;
  }

  dispose() {
    this.surface.dispose();
    this.obstacles.dispose();
    this.water.dispose();
    this.scene.remove(this.group);
    this._debugGeo.dispose();
    this._debugMat.dispose();
  }
}
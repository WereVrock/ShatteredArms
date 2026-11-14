// ===== DeploymentZoneView.js =====
// Ground overlay: draws the deployment zone for each team as a translucent
// quad plus a border line. The zone is projected onto the terrain — both
// the fill and the outline sample ActiveTerrain.heightAt per vertex, so on
// hilly maps the zone drapes over the landscape like a laser projected
// from above rather than floating as a flat billboard.
//
// Geometry is written lazily on first show() and re-written whenever the
// active terrain changes (via mesh.onBeforeRender, same trick the field
// boundary strips use in SceneSetup). Zones are static for the whole
// deployment phase, so between terrain changes the buffers are left alone.
//
// One mesh pair per team, created on first show() and reused.
import * as THREE from 'three';
import { ActiveTerrain } from '../session/ActiveTerrain.js';

// Subdivisions for the terrain-following geometry. The fill is a
// (GRID+1)^2 vertex mesh so its interior can drape over hills; the
// outline is a LineLoop with GRID vertices per edge (4*GRID total).
// 32 resolves hills down to a few world units while staying cheap.
const GRID = 32;

// Lift above terrain, in world units. High enough to clear the ground
// plane / terrain surface, low enough that the zone reads as painted on
// the ground rather than floating.
const Y_FILL = 0.05;
const Y_OUTLINE = 0.06;

export class DeploymentZoneView {
  constructor(scene) {
    this.scene = scene;
    this._entries = new Map(); // teamId -> { fill, outline, zone, sampledTerrain }
  }

  show(teamId, zone, color, fillOpacity, outlineOpacity) {
    let entry = this._entries.get(teamId);
    if (!entry) {
      entry = this._createEntry();
      this._entries.set(teamId, entry);
    }

    entry.zone = zone;
    this._writeGeometry(entry);
    entry.sampledTerrain = ActiveTerrain.get();

    entry.fill.material.color.setHex(color);
    entry.fill.material.opacity = fillOpacity;
    entry.outline.material.color.setHex(color);
    entry.outline.material.opacity = outlineOpacity;

    entry.fill.visible = true;
    entry.outline.visible = true;
  }

  hide(teamId) {
    const entry = this._entries.get(teamId);
    if (!entry) return;
    entry.fill.visible = false;
    entry.outline.visible = false;
  }

  hideAll() {
    for (const teamId of this._entries.keys()) this.hide(teamId);
  }

  dispose() {
    for (const entry of this._entries.values()) {
      this.scene.remove(entry.fill);
      this.scene.remove(entry.outline);
      entry.fill.geometry.dispose();
      entry.fill.material.dispose();
      entry.outline.geometry.dispose();
      entry.outline.material.dispose();
    }
    this._entries.clear();
  }

  _createEntry() {
    const verts = (GRID + 1) * (GRID + 1);
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(verts * 3), 3)
    );

    // Two triangles per grid cell.
    const idx = new Uint16Array(GRID * GRID * 6);
    let o = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const v00 = j * (GRID + 1) + i;
        const v10 = v00 + 1;
        const v01 = v00 + (GRID + 1);
        const v11 = v01 + 1;
        idx[o++] = v00; idx[o++] = v10; idx[o++] = v11;
        idx[o++] = v00; idx[o++] = v11; idx[o++] = v01;
      }
    }
    fillGeo.setIndex(new THREE.BufferAttribute(idx, 1));

    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x3a6ea5,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.frustumCulled = false;
    fill.renderOrder = 900;
    this.scene.add(fill);

    const outVerts = GRID * 4;
    const outGeo = new THREE.BufferGeometry();
    outGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(outVerts * 3), 3)
    );

    const outMat = new THREE.LineBasicMaterial({
      color: 0x3a6ea5,
      transparent: true,
      opacity: 0.7,
      depthTest: false
    });

    const outline = new THREE.LineLoop(outGeo, outMat);
    outline.frustumCulled = false;
    outline.renderOrder = 901;
    this.scene.add(outline);

    const entry = { fill, outline, zone: null, sampledTerrain: undefined };

    // Lazy terrain re-projection. Fires on every render but only re-writes
    // the buffers when the active terrain has changed. Same pattern as
    // SceneSetup's field-boundary strips.
    fill.onBeforeRender = () => {
      const t = ActiveTerrain.get();
      if (t !== entry.sampledTerrain) {
        entry.sampledTerrain = t;
        this._writeGeometry(entry);
      }
    };

    return entry;
  }

  _writeGeometry(entry) {
    const zone = entry.zone;
    if (!zone) return;

    // Fill: (GRID+1)^2 mesh sampled straight from zone-local coordinates
    // so the mesh layout matches the rectangle, whatever the yaw.
    const fillPos = entry.fill.geometry.attributes.position.array;
    const stride = GRID + 1;
    const depthSpan = zone.backDepth + zone.frontDepth;
    for (let j = 0; j <= GRID; j++) {
      const dj = j / GRID;
      const depth = -zone.backDepth + dj * depthSpan;
      for (let i = 0; i <= GRID; i++) {
        const di = i / GRID;
        const lateral = -zone.halfLateral + di * 2 * zone.halfLateral;
        const p = zone.toWorld(lateral, depth);
        const k = (j * stride + i) * 3;
        fillPos[k]     = p.x;
        fillPos[k + 1] = ActiveTerrain.heightAt(p.x, p.z) + Y_FILL;
        fillPos[k + 2] = p.z;
      }
    }
    entry.fill.geometry.attributes.position.needsUpdate = true;
    entry.fill.geometry.computeBoundingSphere();

    // Outline: LineLoop with GRID vertices per edge, walked back-left →
    // back-right → front-right → front-left; LineLoop closes the loop
    // automatically.
    const outPos = entry.outline.geometry.attributes.position.array;
    let v = 0;
    const writeVert = (lateral, depth) => {
      const p = zone.toWorld(lateral, depth);
      outPos[v++] = p.x;
      outPos[v++] = ActiveTerrain.heightAt(p.x, p.z) + Y_OUTLINE;
      outPos[v++] = p.z;
    };
    // Back edge (depth = -backDepth), lateral low → high.
    for (let i = 0; i < GRID; i++) {
      const lateral = -zone.halfLateral + (i / GRID) * 2 * zone.halfLateral;
      writeVert(lateral, -zone.backDepth);
    }
    // Right edge (lateral = +halfLateral), depth back → front.
    for (let i = 0; i < GRID; i++) {
      const depth = -zone.backDepth + (i / GRID) * depthSpan;
      writeVert(zone.halfLateral, depth);
    }
    // Front edge (depth = +frontDepth), lateral high → low.
    for (let i = 0; i < GRID; i++) {
      const lateral = zone.halfLateral - (i / GRID) * 2 * zone.halfLateral;
      writeVert(lateral, zone.frontDepth);
    }
    // Left edge (lateral = -halfLateral), depth front → back.
    for (let i = 0; i < GRID; i++) {
      const depth = zone.frontDepth - (i / GRID) * depthSpan;
      writeVert(-zone.halfLateral, depth);
    }
    entry.outline.geometry.attributes.position.needsUpdate = true;
    entry.outline.geometry.computeBoundingSphere();
  }
}
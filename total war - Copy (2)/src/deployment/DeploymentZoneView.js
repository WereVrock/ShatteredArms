// Ground overlay: draws the deployment zone for each team as a translucent
// quad plus a border line. Purely visual — no sim state is read or written.
//
// One mesh pair per team, created lazily on first show() and reused. Zones
// are static for the whole deployment phase, so the geometry is written once
// per show() and then left alone.
import * as THREE from 'three';

const Y_FILL = 0.04;
const Y_OUTLINE = 0.045;

export class DeploymentZoneView {
  constructor(scene) {
    this.scene = scene;
    this._entries = new Map(); // teamId -> { fill, outline }
  }

  show(teamId, zone, color, fillOpacity, outlineOpacity) {
    let entry = this._entries.get(teamId);
    if (!entry) {
      entry = this._createEntry();
      this._entries.set(teamId, entry);
    }

    const corners = zone.getCornersWorld();
    this._writeQuad(entry.fill.geometry, corners, Y_FILL);
    this._writeQuad(entry.outline.geometry, corners, Y_OUTLINE);

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
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    fillGeo.setIndex([0, 1, 2, 0, 2, 3]);

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

    const outGeo = new THREE.BufferGeometry();
    outGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
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

    return { fill, outline };
  }

  _writeQuad(geo, corners, y) {
    const arr = geo.attributes.position.array;
    for (let i = 0; i < 4; i++) {
      arr[i * 3]     = corners[i].x;
      arr[i * 3 + 1] = y;
      arr[i * 3 + 2] = corners[i].z;
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();
  }
}
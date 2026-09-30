// ===== PathLineView.js =====
// Debug overlay: draws a straight line from a unit's current center to its
// formationOrigin — the last position an issueMoveOrder placed the unit's
// formation at. Since Unit.issueMoveOrder sets formationOrigin = (x, z) on
// every call, and orderTarget is the same (x, z), the line ends at the
// unit's ordered destination. If the unit has arrived (center ≈ formationOrigin)
// the line collapses to nothing and hides.
//
// Intended for the G+click debug flow — click an enemy unit to see where
// it's been sent. Pure visual; does not touch sim state.
//
// depthTest is disabled so the line renders through terrain and other units;
// this is a debug tool, not a render layer.
import * as THREE from 'three';

const LINE_Y = 0.15;

export class PathLineView {
  constructor(scene) {
    this.scene = scene;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.geo = geo;

    const mat = new THREE.LineBasicMaterial({
      color: 0xffc020,
      transparent: true,
      opacity: 0.9,
      depthTest: false
    });
    this.mat = mat;

    this.line = new THREE.Line(geo, mat);
    this.line.visible = false;
    this.line.frustumCulled = false;
    this.line.renderOrder = 999;
    scene.add(this.line);

    this._unit = null;
  }

  // Pass a Unit to track, or null to hide the line entirely.
  setUnit(unit) {
    this._unit = unit || null;
    if (!this._unit) this.line.visible = false;
  }

  // Called each frame to sync the line to the unit's live position. The
  // destination (formationOrigin) is fixed at order-issue time, so only
  // the start point moves as the unit advances.
  sync() {
    const unit = this._unit;
    if (!unit) {
      this.line.visible = false;
      return;
    }

    const center = unit.getCenter();
    const dest = unit.formationOrigin;
    if (!dest) {
      this.line.visible = false;
      return;
    }

    const dx = dest.x - center.x;
    const dz = dest.z - center.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.1) {
      this.line.visible = false;
      return;
    }

    const pos = this.geo.attributes.position.array;
    pos[0] = center.x;
    pos[1] = LINE_Y;
    pos[2] = center.z;
    pos[3] = dest.x;
    pos[4] = LINE_Y;
    pos[5] = dest.z;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeBoundingSphere();

    this.line.visible = true;
  }

  dispose() {
    this.scene.remove(this.line);
    this.geo.dispose();
    this.mat.dispose();
  }
}
// Debug overlay: for a set of "watched" units, draws a small dot at every
// alive soldier's current formationSlot (where the formation system wants
// them to stand) plus a thin line from that dot to the soldier's actual
// current position. A mismatch is visible at a glance:
//   - dots not forming the expected grid shape -> the SHAPE/slot math is
//     wrong (formationOffset / formationCols problem, e.g. Unit.js).
//   - dots correctly spread in the expected grid, but long lines running
//     off to soldiers standing somewhere else -> the slots are right and
//     it's a MOVEMENT problem (soldiers not walking to their slot).
//
// Purely visual, reads sim state only. Only ever shown while debug mode is
// on (see BattleRenderer.setDebugModeOn) — gated by the caller, not by this
// class holding its own on/off state, so there is exactly one place
// ("is debug mode on") that decides visibility.
import * as THREE from 'three';

const DOT_Y = 0.12;
const LINE_Y = 0.10;
const DOT_SIZE = 0.12;
const DOT_COLOR = 0x40e0ff;
const LINE_COLOR = 0xffe040;

export class FormationSlotDebugView {
  constructor(scene) {
    this.scene = scene;

    // Pooled per-soldier entries, keyed by soldier id. Each entry owns one
    // dot mesh and one line mesh. Pooling avoids alloc/dispose churn every
    // frame while debug mode is on, and everything is hidden (not disposed)
    // the moment it's no longer needed.
    this._entriesBySoldierId = new Map();

    // The units currently being visualized. Set via setUnits(); empty when
    // debug mode is off or nothing is selected.
    this._units = [];
  }

  // Pass an array of Units to visualize (typically the player's current
  // selection), or an empty array / null to hide everything.
  setUnits(units) {
    this._units = units || [];
  }

  // Called each frame. No-op cost when _units is empty beyond hiding any
  // previously-shown entries once.
// Called each frame. No-op cost when _units is empty beyond hiding any
  // previously-shown entries once.
// Called each frame. No-op cost when _units is empty beyond hiding any
  // previously-shown entries once.
  sync() {
    const liveSoldierIds = new Set();

    for (const unit of this._units) {
      for (const soldier of unit.getAliveSoldiers()) {
        liveSoldierIds.add(soldier.id);
        const entry = this._acquireEntry(soldier.id);
        this._updateEntry(entry, soldier);
      }
    }

    // Hide any pooled entry that isn't part of this frame's live set —
    // e.g. selection changed, or a soldier died.
    for (const [soldierId, entry] of this._entriesBySoldierId) {
      if (!liveSoldierIds.has(soldierId)) {
        entry.dot.visible = false;
        entry.line.visible = false;
      }
    }
  }

  _acquireEntry(soldierId) {
    let entry = this._entriesBySoldierId.get(soldierId);
    if (entry) return entry;

    const dotGeo = new THREE.CircleGeometry(DOT_SIZE, 12);
    const dotMat = new THREE.MeshBasicMaterial({
      color: DOT_COLOR,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.rotation.x = -Math.PI / 2;
    dot.renderOrder = 997;
    dot.frustumCulled = false;
    this.scene.add(dot);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: LINE_COLOR,
      transparent: true,
      opacity: 0.75,
      depthTest: false
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.renderOrder = 997;
    line.frustumCulled = false;
    this.scene.add(line);

    entry = { dot, line, lineGeo };
    this._entriesBySoldierId.set(soldierId, entry);
    return entry;
  }

  _updateEntry(entry, soldier) {
    const slot = soldier.formationSlot;

    entry.dot.position.set(slot.x, DOT_Y, slot.z);
    entry.dot.visible = true;

    const pos = entry.lineGeo.attributes.position.array;
    pos[0] = slot.x;
    pos[1] = LINE_Y;
    pos[2] = slot.z;
    pos[3] = soldier.pos.x;
    pos[4] = LINE_Y;
    pos[5] = soldier.pos.z;
    entry.lineGeo.attributes.position.needsUpdate = true;
    entry.lineGeo.computeBoundingSphere();
    entry.line.visible = true;
  }

  dispose() {
    for (const entry of this._entriesBySoldierId.values()) {
      this.scene.remove(entry.dot);
      entry.dot.geometry.dispose();
      entry.dot.material.dispose();
      this.scene.remove(entry.line);
      entry.line.geometry.dispose();
      entry.line.material.dispose();
    }
    this._entriesBySoldierId.clear();
  }
}
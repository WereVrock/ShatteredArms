import * as THREE from 'three';

// Left-click: selects a single unit (or deselects on empty ground).
// Left-click-drag: rectangle-select (only when RMB is NOT also held — LMB+RMB
// together is reserved for camera panning, handled by CameraController).
// Shift+drag: adds to current selection instead of replacing it.
//
// Only units whose team is in `controllableTeamIds` can be selected.
//
// Picking (shared with OrderDragController):
//   aimRaycasterFromEvent(e)  — aims this.raycaster from a mouse event
//   pickUnitId()              — returns the unitId under the current ray
//
// Both are on this class so there is exactly ONE raycaster that gets aimed,
// instead of each controller keeping its own and drifting out of sync. A
// previous version of this file had the aim call removed from
// _handleSingleClick, which made every click miss silently.
export class SelectionController {
  constructor(canvas, sceneSetup, units, battleRenderer, selectionBoxView, controllableTeamIds) {
    this.canvas = canvas;
    this.sceneSetup = sceneSetup;
    this.units = units;
    this.unitsById = new Map(units.map(u => [u.id, u]));
    this.battleRenderer = battleRenderer;
    this.selectionBoxView = selectionBoxView;

    this.controllableTeamIds = new Set(
      controllableTeamIds && controllableTeamIds.length > 0
        ? controllableTeamIds
        : units.map(u => u.teamId)
    );

    this.selectedUnits = new Set();

    this.raycaster = new THREE.Raycaster();

    this.isDragSelecting = false;
    this.dragStartScreen = null;
    this.dragShiftHeld = false;
    this.rightButtonDown = false;
    // True for the duration of a click sequence that began with G held —
    // keeps mousemove from ever promoting it into a rectangle-select drag,
    // regardless of incidental mouse movement before mouseup.
    this._suppressDragForGClick = false;

    // Debug-inspect state. Holding G turns left-click into "open this unit
    // for inspection" — the unit is stored here, independent of the
    // player's selection set, and onDebugSelectionChanged fires with the
    // new target (or null to clear). main.js wires the callback to the HUD
    // info panel and the path-line overlay. Inspecting an enemy never
    // disturbs the player's own orders, which is the whole point.
    this.gKeyDown = false;
    this.onDebugSelectionChanged = null;
    this._debugTarget = null;

    const DRAG_THRESHOLD_PX = 5;
    this.dragThreshold = DRAG_THRESHOLD_PX;

    this._bindEvents();
  }

  isControllable(unit) {
    return !!unit && this.controllableTeamIds.has(unit.teamId);
  }

  // Aims this.raycaster from a mouse event. Callers MUST call this before
  // pickUnitId() (or before reading this.raycaster.ray for a ground-plane hit).
  aimRaycasterFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1
    };
    this.raycaster.setFromCamera(ndc, this.sceneSetup.camera);
  }

  // Returns the unitId under this.raycaster, or null. Recursive intersect plus
  // a walk up the parent chain means it works whether unitId ended up on the
  // mesh itself or only on an ancestor group.
// Returns the unitId under this.raycaster, or null. Rays are tested against
  // the soldiers' invisible pick-proxy spheres, not their visible body meshes
  // — that's what makes click accuracy reliable.
  pickUnitId() {
    const meshes = this.battleRenderer.getPickableMeshes();
    if (meshes.length === 0) return null;

    const intersections = this.raycaster.intersectObjects(meshes, false);
    if (intersections.length === 0) return null;

    for (const hit of intersections) {
      let obj = hit.object;
      while (obj) {
        const uid = obj.userData && obj.userData.unitId;
        if (uid !== undefined) return uid;
        obj = obj.parent;
      }
    }
    return null;
  }

  _bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) {
        this.rightButtonDown = true;
        this._cancelDragSelect();
        return;
      }
      if (e.button !== 0) return;
      if (this.rightButtonDown) return; // RMB already held: this is a camera pan, not a select-drag

      this.dragStartScreen = { x: e.clientX, y: e.clientY };
      this.dragShiftHeld = e.shiftKey;
      this.isDragSelecting = false;
      // G held: this mousedown is a debug-inspect click, never a rectangle-
      // select drag. Recorded separately from dragStartScreen (which mouseup
      // still needs, to know a click sequence is in progress) so mousemove
      // can refuse to promote it into a drag regardless of how far the mouse
      // travels before mouseup.
      this._suppressDragForGClick = this.gKeyDown;
    });

    window.addEventListener('mousemove', (e) => {
      if (this.rightButtonDown) return; // camera pan owns the drag; no select-box tracking
      if (!this.dragStartScreen) return;
      if (this._suppressDragForGClick) return; // G-held click: never becomes a rectangle select

      const dx = e.clientX - this.dragStartScreen.x;
      const dy = e.clientY - this.dragStartScreen.y;
      if (!this.isDragSelecting && Math.sqrt(dx * dx + dy * dy) > this.dragThreshold) {
        this.isDragSelecting = true;
      }
      if (this.isDragSelecting) {
        this.selectionBoxView.show(this.dragStartScreen.x, this.dragStartScreen.y, e.clientX, e.clientY);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) {
        this.rightButtonDown = false;
        return;
      }
      if (e.button !== 0 || !this.dragStartScreen) return;

      if (this.isDragSelecting) {
        this._finishRectSelect(this.dragStartScreen, { x: e.clientX, y: e.clientY }, this.dragShiftHeld);
        this.selectionBoxView.hide();
      } else if (!this.rightButtonDown) {
        this._handleSingleClick(e);
      }

      this.dragStartScreen = null;
      this.isDragSelecting = false;
      this._suppressDragForGClick = false;
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyG') this.gKeyDown = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyG') this.gKeyDown = false;
    });
  }

  _cancelDragSelect() {
    this.dragStartScreen = null;
    this.isDragSelecting = false;
    this.selectionBoxView.hide();
  }

  _handleSingleClick(e) {
    this.aimRaycasterFromEvent(e);
    const clickedUnitId = this.pickUnitId();
    const clickedUnit = clickedUnitId ? this.unitsById.get(clickedUnitId) : null;

    // Debug-inspect mode: while G is held, left-click sets the debug target
    // instead of touching the player's selection. Clicking the current
    // debug target again (or empty ground) clears it. Works for any team,
    // so you can inspect your own units too without losing your selection.
    if (this.gKeyDown) {
      if (this.onDebugSelectionChanged) {
        const next = (clickedUnit && clickedUnit !== this._debugTarget) ? clickedUnit : null;
        this._debugTarget = next;
        this.onDebugSelectionChanged(next);
      }
      return;
    }

    if (this.isControllable(clickedUnit)) {
      if (e.shiftKey) {
        this._addToSelection(clickedUnit);
      } else {
        this._replaceSelection([clickedUnit]);
      }
    } else if (!e.shiftKey) {
      // Clicking an enemy (or empty ground) without shift clears the selection.
      this._replaceSelection([]);
    }
  }

  _finishRectSelect(startScreen, endScreen, additive) {
    const rect = {
      left: Math.min(startScreen.x, endScreen.x),
      right: Math.max(startScreen.x, endScreen.x),
      top: Math.min(startScreen.y, endScreen.y),
      bottom: Math.max(startScreen.y, endScreen.y)
    };

    const canvasRect = this.canvas.getBoundingClientRect();
    const hitUnits = new Set();

    for (const unit of this.units) {
      if (!this.isControllable(unit)) continue;
      for (const soldier of unit.getAliveSoldiers()) {
        const screenPos = this._worldToScreen(soldier.pos.x, 0.5, soldier.pos.z, canvasRect);
        if (screenPos.x >= rect.left && screenPos.x <= rect.right &&
            screenPos.y >= rect.top && screenPos.y <= rect.bottom) {
          hitUnits.add(unit);
          break;
        }
      }
    }

    if (additive) {
      for (const u of hitUnits) this._addToSelection(u);
    } else {
      this._replaceSelection(Array.from(hitUnits));
    }
  }

  _worldToScreen(x, y, z, canvasRect) {
    const vector = new THREE.Vector3(x, y, z);
    vector.project(this.sceneSetup.camera);
    return {
      x: canvasRect.left + (vector.x * 0.5 + 0.5) * canvasRect.width,
      y: canvasRect.top + (-vector.y * 0.5 + 0.5) * canvasRect.height
    };
  }

  _replaceSelection(unitsList) {
    for (const u of this.selectedUnits) u.selected = false;
    this.selectedUnits.clear();
    for (const u of unitsList) {
      u.selected = true;
      this.selectedUnits.add(u);
    }
  }

_addToSelection(unit) {
    unit.selected = true;
    this.selectedUnits.add(unit);
  }

  // Public entry point for programmatic selection — used by ArmyBarView's
  // card click handler. Same containment rule as click-on-canvas: a
  // non-controllable unit is silently ignored. `additive` mirrors
  // shift-click on the canvas (adds to the current selection instead of
  // replacing it).
  selectUnit(unit, additive = false) {
    if (!this.isControllable(unit)) return;
    if (additive) {
      this._addToSelection(unit);
    } else {
      this._replaceSelection([unit]);
    }
  }
}
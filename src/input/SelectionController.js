// ===== SelectionController.js =====
import * as THREE from 'three';

// Left-click: selects a single unit (or deselects on empty ground).
// Left-click-drag: rectangle-select (only when RMB is NOT also held — LMB+RMB
// together is reserved for camera panning, handled by CameraController).
// Shift+drag: adds to current selection instead of replacing it.
//
// Only units whose team is in `controllableTeamIds` can be selected.
//
// PICKING
// Click picking projects EVERY LIVING SOLDIER of every unit to screen
// space and returns the unit whose nearest soldier is closest to the
// click, within pickRadiusPx. Any soldier of a unit is a valid pick
// target, so clicking on a flank soldier selects that flank soldier's
// unit — matching the hit footprint of the old per-soldier pick-proxy
// raycast, but without one invisible mesh per soldier in the scene
// graph.
//
// An earlier version of this method projected only the unit's centroid.
// That failed for wide formations: clicking on a soldier at the flank
// put the click 100+ screen pixels from the unit's centroid, well
// outside any reasonable pick radius, so the pick returned null and the
// click was silently ignored. Projecting every soldier fixes this at
// negligible cost — the loop runs once per click, never per frame.
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

    // Shared raycaster. Retained because OrderDragController and
    // CameraController both use it for GROUND-PLANE hits (a plane
    // intersection against this.raycaster.ray). Unit picking no longer
    // goes through it — see pickUnitAtScreen.
    this.raycaster = new THREE.Raycaster();

    this.isDragSelecting = false;
    this.dragStartScreen = null;
    this.dragShiftHeld = false;
    this.rightButtonDown = false;
    this._suppressDragForGClick = false;

    this.gKeyDown = false;
    // Ctrl-held state for the order-destination reveal (see main.js's
    // render loop and OrderPreviewView.showOrderDestinations). Read once
    // per frame; there is no per-frame key polling.
    this.ctrlKeyDown = false;
    this.onDebugSelectionChanged = null;
    this._debugTarget = null;

    const DRAG_THRESHOLD_PX = 5;
    this.dragThreshold = DRAG_THRESHOLD_PX;

    // Pixel radius within which a click counts as "on" a soldier.
    //
    // Sized against the default camera: at distance 40, FOV 55°, viewport
    // 1080px, that is ~26 pixels per world unit, so a blob soldier
    // (~0.44 world units wide) is ~11 screen pixels. 24 is roughly two
    // soldier widths — a click between two soldiers of the same unit
    // still hits that unit, and a click on a single soldier gives a
    // comfortable margin without spilling over into a neighbouring
    // unit's footprint.
    this.pickRadiusPx = 24;

    // Reusable Vector3 to avoid per-click allocation.
    this._projVec = new THREE.Vector3();

    this._bindEvents();
  }

  isControllable(unit) {
    return !!unit && this.controllableTeamIds.has(unit.teamId);
  }

  // Aims this.raycaster from a mouse event. Used by callers that need a
  // GROUND-PLANE hit via raycaster.ray. Unit picking does NOT go through
  // the raycaster — see pickUnitAtScreen.
  aimRaycasterFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1
    };
    this.raycaster.setFromCamera(ndc, this.sceneSetup.camera);
  }

  // Returns the unitId of the unit whose nearest living soldier is
  // closest to the given screen pixel, within pickRadiusPx. Null on a
  // miss.
  //
  // Iterates every living soldier of every unit and projects each to
  // screen space. Any soldier of a unit is a valid pick target, so a
  // click on a flank soldier selects that flank soldier's unit — the
  // same hit footprint as the old per-soldier pick-proxy raycast, but
  // without one invisible mesh per soldier in the scene graph.
  //
  // Cost: one .project() per living soldier per click. At 3000 soldiers
  // that is ~60k flops total, and this method only ever runs on a click,
  // never per frame.
  //
  // Takes raw clientX / clientY (the values on a mouse event). The
  // projected screen positions include canvasRect.left / top so the
  // comparison stays in the same client coordinate space as the event.
  // Approximate head-top height, in world units, of the tallest common
  // unit. Used as the top of the pick segment. 1.4 covers a foot
  // soldier's helmet with a small margin; a mounted rider's head sits a
  // little above it but is still covered by the pick radius.
  //
  // Using a fixed height slightly greater than the visual top is
  // harmless: the closest-point-on-segment test below rejects clicks
  // that land well above the segment, so the only effect of a small
  // over-estimate is that a click just past the top of the helmet still
  // counts as a hit — which is what a player expects anyway.
  pickUnitAtScreen(clientX, clientY) {
    const canvasRect = this.canvas.getBoundingClientRect();
    const camera = this.sceneSetup.camera;
    const v = this._projVec;
    const PICK_HEAD_Y = 1.4;

    const radiusSq = this.pickRadiusPx * this.pickRadiusPx;
    let bestUnit = null;
    let bestDistSq = radiusSq;
    let bestDepth = Infinity;

    for (const unit of this.units) {
      const alive = unit.getAliveSoldiers();
      if (alive.length === 0) continue;

      for (const s of alive) {
        // Foot point at ground level.
        v.set(s.pos.x, 0, s.pos.z).project(camera);
        if (v.z < -1 || v.z > 1) continue;
        const footX = canvasRect.left + (v.x * 0.5 + 0.5) * canvasRect.width;
        const footY = canvasRect.top  + (-v.y * 0.5 + 0.5) * canvasRect.height;
        const footZ = v.z;

        // Head point at approximate soldier-top height.
        v.set(s.pos.x, PICK_HEAD_Y, s.pos.z).project(camera);
        if (v.z < -1 || v.z > 1) continue;
        const headX = canvasRect.left + (v.x * 0.5 + 0.5) * canvasRect.width;
        const headY = canvasRect.top  + (-v.y * 0.5 + 0.5) * canvasRect.height;

        // Closest point on the 2D segment [foot, head] to the click.
        // At a high camera pitch the soldier is foreshortened on screen
        // (head sits a few pixels above the feet) and at a low pitch the
        // body spans many pixels vertically — a single projected mid-
        // body point cannot cover both cases at a fixed pick radius.
        // The segment adapts: it shrinks with the foreshortening and
        // grows with the projection, so a click anywhere on the visible
        // silhouette is within the radius.
        const segX = headX - footX;
        const segY = headY - footY;
        const segLen2 = segX * segX + segY * segY;

        let closestX;
        let closestY;
        if (segLen2 < 1e-6) {
          // Soldier's vertical extent collapsed to a single pixel
          // (camera exactly overhead): the segment is a point.
          closestX = footX;
          closestY = footY;
        } else {
          // Project click onto the segment, clamp to [0, 1] so clicks
          // past either end use the nearest endpoint.
          let t = ((clientX - footX) * segX + (clientY - footY) * segY) / segLen2;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          closestX = footX + t * segX;
          closestY = footY + t * segY;
        }

        const dx = closestX - clientX;
        const dy = closestY - clientY;
        const d2 = dx * dx + dy * dy;

        if (d2 <= radiusSq) {
          // Prefer the nearest soldier in screen space; ties break
          // toward the camera so a foreground soldier wins over one
          // directly behind it.
          if (d2 < bestDistSq || (d2 === bestDistSq && footZ < bestDepth)) {
            bestDistSq = d2;
            bestDepth = footZ;
            bestUnit = unit;
          }
        }
      }
    }

    return bestUnit ? bestUnit.id : null;
  }

  // Backward-compatibility shim. Some external callers may still reach
  // for the old raycast-against-proxies API; the correct call is
  // pickUnitAtScreen(clientX, clientY). Returns null — the proxies no
  // longer exist in this codebase.
  pickUnitId() {
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
      if (this.rightButtonDown) return;

      this.dragStartScreen = { x: e.clientX, y: e.clientY };
      this.dragShiftHeld = e.shiftKey;
      this.isDragSelecting = false;
      this._suppressDragForGClick = this.gKeyDown;
    });

    window.addEventListener('mousemove', (e) => {
      if (this.rightButtonDown) return;
      if (!this.dragStartScreen) return;
      if (this._suppressDragForGClick) return;

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
      // e.key is 'Control' for both ControlLeft and ControlRight — do
      // not use e.ctrlKey, which is the modifier state (true for ANY key
      // pressed while Ctrl is held, not just Ctrl itself).
      if (e.key === 'Control') this.ctrlKeyDown = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyG') this.gKeyDown = false;
      if (e.key === 'Control') this.ctrlKeyDown = false;
    });
    // A tab-away or alt-tab mid-hold never delivers a keyup for the
    // Ctrl key, which would leave ctrlKeyDown latched true and the
    // order-destination reveal stuck on. Clearing both held-key flags
    // on blur is the safe reset. Same latent bug exists for G; fixed
    // here while we are touching the listeners.
    window.addEventListener('blur', () => {
      this.gKeyDown = false;
      this.ctrlKeyDown = false;
    });
  }

  _cancelDragSelect() {
    this.dragStartScreen = null;
    this.isDragSelecting = false;
    this.selectionBoxView.hide();
  }

  _handleSingleClick(e) {
    const clickedUnitId = this.pickUnitAtScreen(e.clientX, e.clientY);
    const clickedUnit = clickedUnitId ? this.unitsById.get(clickedUnitId) : null;

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

  clearSelection() {
    this._replaceSelection([]);
  }

  _addToSelection(unit) {
    unit.selected = true;
    this.selectedUnits.add(unit);
  }

  selectUnit(unit, additive = false) {
    if (!this.isControllable(unit)) return;
    if (additive) {
      this._addToSelection(unit);
    } else {
      this._replaceSelection([unit]);
    }
  }
}
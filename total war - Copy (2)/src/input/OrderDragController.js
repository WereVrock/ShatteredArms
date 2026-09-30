import * as THREE from 'three';
import { CombatConfig } from '../config/CombatConfig.js';
import { SettingsStore } from '../ui/settings/SettingsStore.js';

const LINE_GAP_BETWEEN_UNITS = 1.0;

// Below this drag distance (world units) the right-click is treated as a
// plain move/attack order — the formation stays centered on the click point,
// matching the pre-existing behavior. Above it, the click point becomes ONE
// CORNER of the formation line and the cursor the other.
const DRAG_CORNER_THRESHOLD = 0.3;

// Minimum time (ms) the right button must be held before the controller
// treats the interaction as a formation drag, independent of how far the
// cursor has moved. A quick right-click under this duration — even with a
// little jitter — releases into a plain move order. A deliberate hold past
// it enters formation mode so the player can see the preview and start
// widening the line without having to jiggle the mouse first.
const HOLD_TIME_MS = 500;

// Right-click double-click detection. A second plain right-click within
// this time window and screen-distance window of the first is treated as a
// double-click: the move order it commits uses directMarch, so soldiers
// walk straight to their new slots instead of the block assembling en
// route. Two clicks far apart, or spaced further in time, are two normal
// move orders.
const RIGHT_DOUBLE_CLICK_MS = 350;
const RIGHT_DOUBLE_CLICK_PX = 6;

// Right-click-and-hold-drag: Total-War style formation drag.
//
// Order routing on right-mouse-down:
//   - selected unit          -> fall through to drag (formation change)
//   - friendly unselected    -> move the group to that unit's center
//   - enemy unit             -> attack order (persistent chase of that unit)
//   - empty ground           -> start a formation drag
//
// Corner-anchored drag: once the cursor moves more than DRAG_CORNER_THRESHOLD
// from the initial click, the formation line is laid out BETWEEN the click
// point and the cursor — the click point is one corner, the cursor the other.
// Below the threshold (a plain right-click), the formation is still centered
// on the click point, so a simple move order keeps its old behavior.
//
// Implementation note: the placement math is unchanged and still centers the
// line on `destinationPoint`. Corner-anchoring is achieved by recentring
// `destinationPoint` on the MIDPOINT of (anchor, cursor) during the drag.
// Because the line is symmetric around its center, a line centered on the
// midpoint with width |cursor - anchor| spans exactly from the anchor to the
// cursor — no placement code has to know about corners.
//
// DEPLOYMENT MODE:
// When a DeploymentPhase is supplied and active, right-click-drag runs the
// same state machine but commits through DeploymentPhase.tryPlayerMoveBatch
// instead of issuing normal orders. Two behaviors:
//   - Short click (no drag): rigid translation — every selected unit shifts
//     by the same (dx, dz) from the selection centroid, so relative offsets
//     are preserved. Facing is unchanged.
//   - Drag past the threshold: line formation between anchor and cursor,
//     same as battle-time formation drag. Each unit gets a new position,
//     the shared previewFacing, and its share of the total line width.
// In both cases soldiers snap instantly to their new slots (no walking),
// and the whole batch is rejected atomically if any unit would land outside
// the team's deployment zone.
//
// Picking is delegated to SelectionController so there is a single raycaster
// aimed from the current click. SelectionController.pickUnitId() is the only
// pick path in the codebase — this controller doesn't duplicate the logic.
//
// Multi-unit line placement: selected units are laid out side by side along
// the RIGHT axis of the new facing, evenly spaced and centered on the
// destination.
export class OrderDragController {
  constructor(canvas, sceneSetup, selectionController, orderPreviewView, deploymentPhase) {
    this.canvas = canvas;
    this.sceneSetup = sceneSetup;
    this.selectionController = selectionController;
    this.orderPreviewView = orderPreviewView;
    // Optional DeploymentPhase. When set and active, right-clicks route to
    // instant in-zone repositioning instead of issuing normal orders. See
    // the class comment for the two deployment commit shapes.
    this.deploymentPhase = deploymentPhase || null;

    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.isOrderDragging = false;
    // True while the current drag was started during deployment. Consumed
    // by the mouseup handler to pick the deployment commit path. Cleared by
    // _abortDrag like every other piece of drag state.
    this._deploymentDrag = false;
    // The point the formation is currently centered on. When no drag has
    // happened this equals anchorPoint (a plain move order centered on the
    // click). During a drag it moves to the midpoint of (anchor, cursor) so
    // the line spans anchor-to-cursor — see class comment.
    this.destinationPoint = null;
    // The original right-click point. Never moves during a drag; the drag
    // vector is measured from here, not from destinationPoint (which moves).
    this.anchorPoint = null;
    // True only after the current drag has passed EITHER the drag-distance
    // threshold OR the hold-time threshold. While false, no formation
    // preview is shown and mouseup commits a plain move order — this is
    // what lets a quick right-click feel like a simple move rather than an
    // instant formation-drag.
    this._dragExceededThreshold = false;
    // performance.now() at the moment the right button went down. Used to
    // measure hold duration independently of mouse movement.
    this._rightDownTime = 0;
    // True only after the current drag has moved past DRAG_CORNER_THRESHOLD.
    // While false, no formation preview is shown and mouseup commits a
    // plain move order — this is what lets a quick right-click feel like a
    // simple move rather than an instant formation-drag.
    this._dragExceededThreshold = false;
    this.previewFacing = 0;
    this.previewWidthUnits = 0;
    this.defaultWidthByUnit = new Map();

    // Tracks LMB state so we can tell "right-click order" apart from
    // "LMB+RMB camera pan". A right-click only starts an order drag when
    // LMB is NOT already held.
    this.leftButtonDown = false;

    const MIN_WIDTH_UNITS = 0.6;
    this.minWidthUnits = MIN_WIDTH_UNITS;

    // Double-click detection state. Updated on every right mousedown, read
    // on the plain-click mouseup commit path. A second right-click within
    // RIGHT_DOUBLE_CLICK_MS at roughly the same screen position flips
    // _isDoubleClick true for that commit, which causes _issueGroupOrder to
    // pass { directMarch: true } into every affected Unit.issueMoveOrder.
    this._lastRightDownTime = 0;
    this._lastRightDownScreenX = 0;
    this._lastRightDownScreenY = 0;
    this._isDoubleClick = false;

    this._bindEvents();
  }

_bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.leftButtonDown = true;
        // If an order drag is already in progress, the player just pressed
        // LMB on top of RMB — they want a camera pan, not an order. Cancel.
        if (this.isOrderDragging) this._abortDrag();
        return;
      }
      if (e.button !== 2) return;
      if (this.leftButtonDown) return; // LMB already held → camera pan, not an order

      // Double-click detection: compare this right-click against the
      // previous one. The flag is consumed by the plain-click mouseup
      // commit; formation drags ignore it. Gated on the user's
      // "Double-click: direct march" setting — when off, every
      // right-click is treated as a normal (non-direct) order, and the
      // previous-click timing is still recorded so toggling the setting
      // mid-session does not misread the next click as a double.
      const now = performance.now();
      const directMarchEnabled = SettingsStore.get().doubleClickDirectMarch !== false;
      this._isDoubleClick = directMarchEnabled &&
        (now - this._lastRightDownTime) < RIGHT_DOUBLE_CLICK_MS &&
        Math.abs(e.clientX - this._lastRightDownScreenX) < RIGHT_DOUBLE_CLICK_PX &&
        Math.abs(e.clientY - this._lastRightDownScreenY) < RIGHT_DOUBLE_CLICK_PX;
      this._lastRightDownTime = now;
      this._lastRightDownScreenX = e.clientX;
      this._lastRightDownScreenY = e.clientY;

      const selected = Array.from(this.selectionController.selectedUnits);
      if (selected.length === 0) return;

      const inDeployment = !!(this.deploymentPhase && this.deploymentPhase.isActive());

      // Aim the shared raycaster from THIS click. SelectionController owns
      // the raycaster — we never keep a second one, so there is no way for
      // this controller and SelectionController to disagree about where the
      // cursor is pointing.
      this.selectionController.aimRaycasterFromEvent(e);

      // Outside deployment, a right-click on a friendly unselected unit
      // moves the group to its center, and on an enemy issues an attack
      // order. During deployment NEITHER applies — the AI is frozen and
      // there is no combat, so the only meaningful action is repositioning
      // the current selection inside the zone.
      if (!inDeployment) {
        const clickedUnitId = this.selectionController.pickUnitId();
        if (clickedUnitId) {
          const clickedUnit = this.selectionController.unitsById.get(clickedUnitId);
          if (clickedUnit && !selected.includes(clickedUnit)) {
            if (clickedUnit.teamId === selected[0].teamId) {
              // Friendly, unselected: move the group to its center. This
              // is also a plain move order, so it gets the same
              // destination flash as a right-click on empty ground.
              const center = clickedUnit.getCenter();
              const issued = this._issueGroupOrder(
                selected, center.x, center.z, undefined, null, this._isDoubleClick
              );
              if (issued) {
                this._flashFormationCommit(selected, center.x, center.z, undefined, null);
              }
            } else {
              // Enemy: attack order — persistent chase of that unit.
              this._issueAttackOrder(selected, clickedUnit);
            }
            e.preventDefault();
            return;
          }
        }
      }

      const groundPoint = new THREE.Vector3();
      this.selectionController.raycaster.ray.intersectPlane(this.groundPlane, groundPoint);
      if (!groundPoint) return;

      // Anchor is fixed here; destination starts equal to it and only moves
      // once the drag crosses DRAG_CORNER_THRESHOLD in mousemove.
      this.anchorPoint = { x: groundPoint.x, z: groundPoint.z };
      this.destinationPoint = { x: groundPoint.x, z: groundPoint.z };
      this.previewFacing = this._averageFacing(selected);

      for (const u of selected) {
        this.defaultWidthByUnit.set(u.id, u.currentWidthUnits || 3);
      }
      this.previewWidthUnits = this._totalDefaultWidth(selected);

      this.isOrderDragging = true;
      this._deploymentDrag = inDeployment;
      // Formation mode is not entered yet: the ghost only appears once
      // EITHER the cursor has moved past DRAG_CORNER_THRESHOLD OR the
      // button has been held past HOLD_TIME_MS. Until then, a release
      // commits a plain move order.
      this._dragExceededThreshold = false;
      this._rightDownTime = performance.now();
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isOrderDragging || !this.anchorPoint) return;
      const selected = Array.from(this.selectionController.selectedUnits);
      if (selected.length === 0) return;

      this.selectionController.aimRaycasterFromEvent(e);
      const groundPoint = new THREE.Vector3();
      this.selectionController.raycaster.ray.intersectPlane(this.groundPlane, groundPoint);
      if (!groundPoint) return;

      // Drag vector measured from the ANCHOR, not from destinationPoint —
      // destinationPoint moves to the midpoint during a drag and would
      // otherwise cause the measurement to drift.
      const dx = groundPoint.x - this.anchorPoint.x;
      const dz = groundPoint.z - this.anchorPoint.z;
      const dragDist = Math.sqrt(dx * dx + dz * dz);

      const elapsedMs = performance.now() - this._rightDownTime;
      const exceededByDist = dragDist > DRAG_CORNER_THRESHOLD;
      const exceededByTime = elapsedMs >= HOLD_TIME_MS;

      if (exceededByDist || exceededByTime) {
        this._dragExceededThreshold = true;

        if (exceededByDist) {
          this.previewFacing = Math.atan2(dx, dz) + Math.PI / 2;
          this.previewWidthUnits = Math.max(this.minWidthUnits, dragDist);

          // Corner-anchor: the click point is one corner of the line, the
          // cursor the other. Centering the existing symmetric placement on
          // the midpoint of the two makes the line span anchor-to-cursor.
          this.destinationPoint = {
            x: (this.anchorPoint.x + groundPoint.x) / 2,
            z: (this.anchorPoint.z + groundPoint.z) / 2
          };
        } else {
          // Held past HOLD_TIME_MS without dragging far: player is in
          // formation mode but has not started widening the line yet.
          // Preview the default formation centred on the click so the
          // player can see they're in formation mode and begin the drag.
          this.previewWidthUnits = this._totalDefaultWidth(selected);
          this.destinationPoint = { x: this.anchorPoint.x, z: this.anchorPoint.z };
        }

        this.orderPreviewView.show(
          this.destinationPoint.x,
          this.destinationPoint.z,
          this.previewFacing
        );
        this.orderPreviewView.showUnitHighlights(selected.map(u => u.getCenter()));
        this._updateGhostPreview(selected);
      } else {
        // Neither threshold crossed: still a plain move order candidate.
        // Keep any preview hidden so a quick right-click never looks like
        // it has entered formation mode.
        this.previewWidthUnits = this._totalDefaultWidth(selected);
        this.destinationPoint = { x: this.anchorPoint.x, z: this.anchorPoint.z };
        this._dragExceededThreshold = false;
        this.orderPreviewView.hide();
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.leftButtonDown = false;
        return;
      }
      if (e.button !== 2 || !this.isOrderDragging) return;

      const selected = Array.from(this.selectionController.selectedUnits);
      if (selected.length > 0 && this.destinationPoint) {
        if (this._deploymentDrag) {
          this._issueDeploymentOrder(selected);
        } else if (this._dragExceededThreshold) {
          // Formation drag: destinationPoint is either the midpoint of
          // (anchor, cursor) if the cursor moved, or the anchor itself if
          // only the hold-time threshold was crossed.
          this._issueGroupOrder(
            selected,
            this.destinationPoint.x,
            this.destinationPoint.z,
            this.previewFacing,
            this.previewWidthUnits
          );
        } else {
          // Plain right-click: commit a simple move order centred on the
          // click. Facing and width are left untouched — no formation was
          // set. A double-click flips directMarch so soldiers walk straight
          // to their new slots instead of the formation assembling en
          // route.
          const issued = this._issueGroupOrder(
            selected,
            this.anchorPoint.x,
            this.anchorPoint.z,
            undefined,
            null,
            this._isDoubleClick
          );
          // Confirm visually only when the order actually landed. An
          // out-of-bounds click is silently dropped by _issueGroupOrder,
          // so it must not flash as if something happened.
          if (issued) {
            this._flashFormationCommit(
              selected,
              this.anchorPoint.x,
              this.anchorPoint.z,
              undefined,
              null
            );
          }
        }
      }

      this._abortDrag();
    });
  }

  // Clears every bit of drag state and hides the preview without issuing an
  // order. Used by the LMB-guard above and by the normal mouseup path.
// Clears every bit of drag state and hides the preview without issuing an
  // order. Used by the LMB-guard above and by the normal mouseup path.
// Clears every bit of drag state and hides the preview without issuing an
  // order. Used by the LMB-guard above and by the normal mouseup path.
  _abortDrag() {
    this.isOrderDragging = false;
    this._deploymentDrag = false;
    this.destinationPoint = null;
    this.anchorPoint = null;
    this.defaultWidthByUnit.clear();
    this._dragExceededThreshold = false;
    this._rightDownTime = 0;
    this.orderPreviewView.hide();
  }

  // Deployment-phase commit. Two shapes, chosen by whether the drag crossed
  // DRAG_CORNER_THRESHOLD (detected by previewWidthUnits differing from the
  // selection's default total width):
  //
  //   - Rigid translation: short click. Every unit shifts by the same
  //     (dx, dz) from the selection centroid; internal offsets and each
  //     unit's current facing are preserved.
  //   - Line formation: real drag. Units are laid out in a line between the
  //     anchor and the cursor, all sharing previewFacing, each with its
  //     share of the total width. Same layout _computeLinePlacements uses
  //     during battle, just committed instantly.
  //
  // Both shapes go through DeploymentPhase.tryPlayerMoveBatch, which
  // validates every destination against the team's deployment zone FIRST
  // and rejects the whole batch atomically if any unit would land outside.
  // A failed batch leaves the selection exactly where it was — never a
  // partial commit.
  _issueDeploymentOrder(selected) {
    if (!this.deploymentPhase) return;

    const defaultTotal = this._totalDefaultWidth(selected);
    const isFormationDrag = Math.abs(this.previewWidthUnits - defaultTotal) > 0.01;

    const moves = [];

    if (isFormationDrag) {
      const placements = this._computeLinePlacements(
        selected,
        this.previewFacing,
        this.previewWidthUnits,
        this.destinationPoint.x,
        this.destinationPoint.z
      );
      for (const p of placements) {
        moves.push({
          unit: p.unit,
          x: p.cx,
          z: p.cz,
          facing: this.previewFacing,
          widthUnits: p.width
        });
      }
    } else {
      let cx = 0, cz = 0;
      for (const u of selected) {
        const c = u.getCenter();
        cx += c.x;
        cz += c.z;
      }
      cx /= selected.length;
      cz /= selected.length;

      const dx = this.destinationPoint.x - cx;
      const dz = this.destinationPoint.z - cz;

      for (const u of selected) {
        const c = u.getCenter();
        moves.push({
          unit: u,
          x: c.x + dx,
          z: c.z + dz,
          facing: u.formationFacing
        });
      }
    }

    this.deploymentPhase.tryPlayerMoveBatch(moves);
  }

  // Computes the line layout: each selected unit gets a center position along
  // the right axis of `facing`, spaced by its share of the total line width
  // plus a fixed edge gap. Existing world positions are ignored. The line is
  // SYMMETRIC around (originX, originZ) — corner-anchoring is handled by the
  // caller passing the midpoint of the drag as the origin, not by any change
  // to this method.
  _computeLinePlacements(selectedUnits, facing, totalWidthUnits, originX, originZ) {
    const n = selectedUnits.length;
    if (n === 0) return [];

    const naturalWidths = selectedUnits.map(u =>
      this.defaultWidthByUnit.get(u.id) || u.currentWidthUnits || 3
    );
    const naturalTotal = naturalWidths.reduce((a, b) => a + b, 0);

    let widths = naturalWidths;
    if (totalWidthUnits && naturalTotal > 0) {
      const scale = totalWidthUnits / naturalTotal;
      widths = naturalWidths.map(w => w * scale);
    }

    const rightX = Math.cos(facing);
    const rightZ = -Math.sin(facing);

    const lineTotal = widths.reduce((a, b) => a + b, 0) + LINE_GAP_BETWEEN_UNITS * (n - 1);

    const placements = [];
    let cursor = -lineTotal / 2;
    for (let i = 0; i < n; i++) {
      const w = widths[i];
      const offset = cursor + w / 2;
      placements.push({
        unit: selectedUnits[i],
        cx: originX + rightX * offset,
        cz: originZ + rightZ * offset,
        width: w
      });
      cursor += w + LINE_GAP_BETWEEN_UNITS;
    }
    return placements;
  }

  _updateGhostPreview(selectedUnits) {
    if (!this.destinationPoint) return;

    const placements = this._computeLinePlacements(
      selectedUnits,
      this.previewFacing,
      this.previewWidthUnits,
      this.destinationPoint.x,
      this.destinationPoint.z
    );

    const allSlots = [];
    for (const p of placements) {
      allSlots.push(...p.unit.previewFormationSlots(p.cx, p.cz, this.previewFacing, p.width));
    }

    this.orderPreviewView.showGhostSlots(allSlots, this.previewFacing);
  }

  _totalDefaultWidth(units) {
    let total = 0;
    for (const u of units) {
      total += this.defaultWidthByUnit.get(u.id) || u.currentWidthUnits || 3;
    }
    return total || 3;
  }

// Returns true if the order was issued, false if it was refused (any
  // destination outside map bounds). Callers use the return value to gate
  // visual confirmation — a refused order must not flash as if it landed.
  // directMarch: passed through to each affected Unit.issueMoveOrder /
  // issueFormationOrder. When true, every affected unit snaps its march
  // anchor to its destination immediately, so soldiers walk straight to
  // their final formation slots rather than the block assembling en route.
  // When false (default), the live-anchor assembly behaviour is preserved.
  _issueGroupOrder(selectedUnits, x, z, facing, totalWidthUnits, directMarch = false) {
    const opts = directMarch ? { directMarch: true } : undefined;

    if (selectedUnits.length === 1) {
      if (!this._isInsideBounds(x, z)) return false;
      if (totalWidthUnits) {
        selectedUnits[0].issueFormationOrder(x, z, facing, totalWidthUnits, opts);
      } else {
        selectedUnits[0].issueMoveOrder(x, z, facing, opts);
      }
      return true;
    }

    const resolvedFacing = (facing !== undefined && facing !== null)
      ? facing
      : this._averageFacing(selectedUnits);

    const placements = this._computeLinePlacements(
      selectedUnits, resolvedFacing, totalWidthUnits, x, z
    );

    // All-or-nothing: if ANY unit's destination lands outside the map
    // bounds, the whole order is silently dropped. No partial commits —
    // half a line moving and half staying put reads worse than nothing.
    // No error indicator, per the requested "just do nothing" behaviour.
    for (const p of placements) {
      if (!this._isInsideBounds(p.cx, p.cz)) return false;
    }

    for (const p of placements) {
      if (totalWidthUnits) {
        p.unit.issueFormationOrder(p.cx, p.cz, resolvedFacing, p.width, opts);
      } else {
        p.unit.issueMoveOrder(p.cx, p.cz, resolvedFacing, opts);
      }
    }
    return true;
  }

// Visual confirmation of a just-committed plain move: a ring flash at
  // the destination plus a one-shot copy of the formation ghost slots at
  // the positions the soldiers will land in. Uses the same placement math
  // _issueGroupOrder uses, so the flash is exactly where the order sent
  // them — including the default-width line a multi-unit plain move
  // produces.
  //
  // Called only when _issueGroupOrder returned true; a refused order must
  // not flash as if it landed.
  _flashFormationCommit(selected, x, z, facing, totalWidthUnits) {
    const resolvedFacing = (facing !== undefined && facing !== null)
      ? facing
      : this._averageFacing(selected);

    const placements = this._computeLinePlacements(
      selected, resolvedFacing, totalWidthUnits, x, z
    );

    const slots = [];
    for (const p of placements) {
      slots.push(...p.unit.previewFormationSlots(p.cx, p.cz, resolvedFacing, p.width));
    }

    this.orderPreviewView.flashFormation(x, z, resolvedFacing, slots);
  }

// Map-bounds gate for player orders. Reads the same CombatConfig.mapBounds
  // that BoundsSystem clamps against and SceneSetup draws as the yellow
  // border strip — the single authoritative definition of where the field
  // ends. A destination outside this box is refused by _issueGroupOrder.
  _isInsideBounds(x, z) {
    const b = CombatConfig.mapBounds;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  }

  _issueAttackOrder(selectedUnits, enemyUnit) {
    let issued = false;
    for (const unit of selectedUnits) {
      if (unit.id === enemyUnit.id) continue;
      if (unit.teamId === enemyUnit.teamId) continue;
      unit.issueAttackOrder(enemyUnit);
      issued = true;
    }
    if (issued) {
      const c = enemyUnit.getCenter();
      this.orderPreviewView.flashAttackTarget(c.x, c.z);
    }
  }

  _averageFacing(units) {
    return units[0] ? units[0].formationFacing : 0;
  }
}
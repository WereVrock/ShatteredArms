// ===== OrderDragController.js =====
import * as THREE from 'three';
import { CombatConfig } from '../config/CombatConfig.js';
import { SettingsStore } from '../ui/settings/SettingsStore.js';

const LINE_GAP_BETWEEN_UNITS = 1.0;

const DRAG_CORNER_THRESHOLD = 0.3;

const HOLD_TIME_MS = 1000;

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
// point and the cursor.
//
// PICKING
// Unit picking is delegated to SelectionController.pickUnitAtScreen, which
// projects each unit's live center to screen space and returns the nearest
// within a small screen radius. The shared raycaster on SelectionController
// is still aimed (aimRaycasterFromEvent) because this controller needs it
// for the GROUND-PLANE hit — but the raycaster is no longer used to resolve
// which unit was clicked.
export class OrderDragController {
  constructor(canvas, sceneSetup, selectionController, orderPreviewView, deploymentPhase) {
    this.canvas = canvas;
    this.sceneSetup = sceneSetup;
    this.selectionController = selectionController;
    this.orderPreviewView = orderPreviewView;
    this.deploymentPhase = deploymentPhase || null;

    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.isOrderDragging = false;
    this._deploymentDrag = false;
    this.destinationPoint = null;
    this.anchorPoint = null;
    this._dragExceededThreshold = false;
    this._rightDownTime = 0;
    this.previewFacing = 0;
    this.previewWidthUnits = 0;
    this.defaultWidthByUnit = new Map();

    this._cursorOffset = { x: 0, z: 0 };

    // Spatially-sorted selection, captured once at right-mouse-down and
    // reused for the rest of the drag. See _sortByLateralPosition.
    this._orderedSelection = null;

    // Rigid-body layout snapshot, captured once at right-mouse-down.
    // Holds each selected unit's offset from the selection centroid in
    // the frame of the selection's average facing at drag start.
    //
    // This is what makes the group move as a rigid body: the drag
    // rotates that snapshot to the drag's facing and translates it to
    // the destination, so a unit that started in front stays in front
    // and a unit that started behind stays behind. See
    // _captureGroupLayout / _computePreservedPlacements.
    //
    // Null outside a drag, and cleared on _abortDrag. When null,
    // _computeLinePlacements falls back to the legacy line layout.
    this._preserveLayout = null;

    this.leftButtonDown = false;

    const MIN_WIDTH_UNITS = 0.6;
    this.minWidthUnits = MIN_WIDTH_UNITS;

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
        if (this.isOrderDragging) this._abortDrag();
        return;
      }
      if (e.button !== 2) return;
      if (this.leftButtonDown) return;

      const now = performance.now();
      const directMarchEnabled = SettingsStore.get().doubleClickDirectMarch !== false;
      this._isDoubleClick = directMarchEnabled &&
        (now - this._lastRightDownTime) < RIGHT_DOUBLE_CLICK_MS &&
        Math.abs(e.clientX - this._lastRightDownScreenX) < RIGHT_DOUBLE_CLICK_PX &&
        Math.abs(e.clientY - this._lastRightDownScreenY) < RIGHT_DOUBLE_CLICK_PX;
      this._lastRightDownTime = now;
      this._lastRightDownScreenX = e.clientX;
      this._lastRightDownScreenY = e.clientY;

      const rawSelection = Array.from(this.selectionController.selectedUnits);
      if (rawSelection.length === 0) return;

      // Mirroring fix. The raw selection Set iterates in insertion order
      // — for box-select that is the master units array order, for
      // individual picks it is click order — neither of which is spatial.
      // Feeding that order into _computeLinePlacements assigns the
      // leftmost slot to whichever unit happens to be earliest in the
      // Set, which is the exact "right unit goes left, left unit goes
      // right" mirroring the player sees.
      //
      // Sort once, here, by each unit's lateral projection onto the
      // formation's right axis (derived from the current average facing).
      // The sorted array is cached on _orderedSelection and reused for
      // the rest of the drag so the ghost preview, the committed order,
      // and the post-commit flash all agree on which unit takes which
      // slot. Re-sorting per mousemove would let the order flip mid-drag
      // as the drag's facing rotates, which reads as a bug.
      const initialFacing = this._averageFacing(rawSelection);
      const selected = this._sortByLateralPosition(rawSelection, initialFacing);
      this._orderedSelection = selected;

      // Rigid-body snapshot. Captures every selected unit's offset from
      // the selection centroid, in the frame of the selection's average
      // facing at this instant. Replayed (rotated + scaled) for the rest
      // of the drag so the group moves as a body — front stays front.
      //
      // Captured BEFORE the virtual-cursor block below so the snapshot
      // is taken against the units' actual field positions, not against
      // any drag-time cursor offset.
      this._preserveLayout = this._captureGroupLayout(selected, initialFacing);

      const inDeployment = !!(this.deploymentPhase && this.deploymentPhase.isActive());

      // Aim the shared raycaster from THIS click — OrderDragController
      // needs it below for the ground-plane hit.
      this.selectionController.aimRaycasterFromEvent(e);

      if (!inDeployment) {
        // Unit hit resolution is now screen-space projected, so pass the
        // raw client coordinates of the click. See
        // SelectionController.pickUnitAtScreen for the full rationale.
        const clickedUnitId = this.selectionController.pickUnitAtScreen(e.clientX, e.clientY);
        if (clickedUnitId) {
          const clickedUnit = this.selectionController.unitsById.get(clickedUnitId);
          if (clickedUnit && !selected.includes(clickedUnit)) {
            if (clickedUnit.teamId === selected[0].teamId) {
              const center = clickedUnit.getCenter();
              const issued = this._issueGroupOrder(
                selected, center.x, center.z, undefined, null, this._resolveDirectMarch()
              );
              if (issued) {
                this._flashFormationCommit(selected, center.x, center.z, undefined, null);
              }
            } else {
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

      this.anchorPoint = { x: groundPoint.x, z: groundPoint.z };
      this.destinationPoint = { x: groundPoint.x, z: groundPoint.z };
      // Reuse the facing captured before the sort — recomputing from the
      // sorted array would read selected[0].formationFacing, which is a
      // different unit's facing than the raw selection's first entry.
      this.previewFacing = initialFacing;

      for (const u of selected) {
        this.defaultWidthByUnit.set(u.id, u.currentWidthUnits || 3);
      }
      this.previewWidthUnits = this._totalDefaultWidth(selected);

      const useVirtualCursor =
        SettingsStore.get().virtualCursorDragEnabled !== false;
      if (useVirtualCursor) {
        this._cursorOffset.x = -this.previewWidthUnits * Math.cos(this.previewFacing);
        this._cursorOffset.z =  this.previewWidthUnits * Math.sin(this.previewFacing);
        document.body.style.cursor = 'none';
      } else {
        this._cursorOffset.x = 0;
        this._cursorOffset.z = 0;
      }

      this.isOrderDragging = true;
      this._deploymentDrag = inDeployment;
      this._dragExceededThreshold = false;
      this._rightDownTime = performance.now();
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isOrderDragging || !this.anchorPoint) return;
      // Use the spatially-sorted selection captured at mousedown. Re-reading
      // the raw Set here would revert to insertion order and reintroduce
      // the mirroring in the ghost preview the player sees while dragging.
      const selected = this._orderedSelection;
      if (!selected || selected.length === 0) return;

      this.selectionController.aimRaycasterFromEvent(e);
      const groundPoint = new THREE.Vector3();
      this.selectionController.raycaster.ray.intersectPlane(this.groundPlane, groundPoint);
      if (!groundPoint) return;

      const realDx = groundPoint.x - this.anchorPoint.x;
      const realDz = groundPoint.z - this.anchorPoint.z;
      const realDragDist = Math.sqrt(realDx * realDx + realDz * realDz);

      const virtX = groundPoint.x + this._cursorOffset.x;
      const virtZ = groundPoint.z + this._cursorOffset.z;
      const dx = virtX - this.anchorPoint.x;
      const dz = virtZ - this.anchorPoint.z;
      const dragDist = Math.sqrt(dx * dx + dz * dz);

      const elapsedMs = performance.now() - this._rightDownTime;
      const exceededByDist = realDragDist > DRAG_CORNER_THRESHOLD;
      const exceededByTime = elapsedMs >= HOLD_TIME_MS;

      if (exceededByDist || exceededByTime) {
        this._dragExceededThreshold = true;

        if (exceededByDist) {
          this.previewFacing = Math.atan2(dx, dz) + Math.PI / 2;
          this.previewWidthUnits = Math.max(this.minWidthUnits, dragDist);

          this.destinationPoint = {
            x: (this.anchorPoint.x + virtX) / 2,
            z: (this.anchorPoint.z + virtZ) / 2
          };
        } else {
          this.previewWidthUnits = this._totalDefaultWidth(selected);
          this.destinationPoint = {
            x: (this.anchorPoint.x + virtX) / 2,
            z: (this.anchorPoint.z + virtZ) / 2
          };
        }

        this.orderPreviewView.show(
          this.destinationPoint.x,
          this.destinationPoint.z,
          this.previewFacing
        );
        this.orderPreviewView.showUnitHighlights(selected.map(u => u.getCenter()));
        this._updateGhostPreview(selected);
      } else {
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

      // Same cached order the ghost preview has been showing — commits
      // the line in the same left-to-right arrangement the player saw.
      const selected = this._orderedSelection;
      if (selected && selected.length > 0 && this.destinationPoint) {
        if (this._deploymentDrag) {
          this._issueDeploymentOrder(selected);
        } else if (this._dragExceededThreshold) {
          this._issueGroupOrder(
            selected,
            this.destinationPoint.x,
            this.destinationPoint.z,
            this.previewFacing,
            this.previewWidthUnits,
            this._resolveDirectMarch()
          );
        } else {
          const issued = this._issueGroupOrder(
            selected,
            this.anchorPoint.x,
            this.anchorPoint.z,
            undefined,
            null,
            this._resolveDirectMarch()
          );
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

  _abortDrag() {
    this.isOrderDragging = false;
    this._deploymentDrag = false;
    this.destinationPoint = null;
    this.anchorPoint = null;
    this.defaultWidthByUnit.clear();
    this._orderedSelection = null;
    this._preserveLayout = null;
    this._dragExceededThreshold = false;
    this._rightDownTime = 0;
    this._cursorOffset.x = 0;
    this._cursorOffset.z = 0;
    if (document.body.style.cursor === 'none') {
      document.body.style.cursor = '';
    }
    this.orderPreviewView.hide();
  }

  _resolveDirectMarch() {
    const rushMode = SettingsStore.get().rushMode === true;
    return rushMode || this._isDoubleClick;
  }

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

  _computeLinePlacements(selectedUnits, facing, totalWidthUnits, originX, originZ) {
    const n = selectedUnits.length;
    if (n === 0) return [];

    // Rigid-body move. When a layout snapshot exists (i.e. this call is
    // part of a drag that started at mousedown), replay the captured
    // relative offsets instead of recomputing a line. This is what
    // preserves the front/back/left/right arrangement the player
    // selected: the group travels and rotates as a body, it does not
    // reflow into a fresh line.
    //
    // The line-placement path below is still reached for callers that
    // never captured a snapshot — the deployment-drag issue path when
    // the drag was started by MPDeploymentPhase (which has its own
    // controller), and any future caller that wants the old behaviour.
    if (this._preserveLayout) {
      return this._computePreservedPlacements(
        selectedUnits, facing, totalWidthUnits, originX, originZ
      );
    }

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

// Snapshot each unit's offset from the selection centroid, projected
  // onto the selection's local axes at `facing`. Called once, at drag
  // start, so the offsets reflect the units' positions on the field and
  // not any drag-time movement.
  //
  // right  = ( cos(facing), -sin(facing) )  — lateral, left/right
  // forward = ( sin(facing),  cos(facing) )  — depth, back/front
  //
  // Same axis conventions _computeLinePlacements uses for the line, so
  // a preserved-layout placement and a line placement agree on what
  // "left" and "forward" mean at any given facing.
  //
  // The captured offsets are the raw field truth: a unit standing behind
  // another has a positive forward offset, and it will keep a positive
  // forward offset in the target layout. Nothing here re-sorts or
  // normalises — the shape is whatever the player had on the field.
  _captureGroupLayout(units, facing) {
    const n = units.length;
    if (n === 0) return null;

    let cx = 0;
    let cz = 0;
    const centers = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = units[i].getCenter();
      centers[i] = c;
      cx += c.x;
      cz += c.z;
    }
    cx /= n;
    cz /= n;

    const rightX = Math.cos(facing);
    const rightZ = -Math.sin(facing);
    const forwardX = Math.sin(facing);
    const forwardZ = Math.cos(facing);

    const offsets = new Map();
    for (let i = 0; i < n; i++) {
      const dx = centers[i].x - cx;
      const dz = centers[i].z - cz;
      offsets.set(units[i].id, {
        lateral: dx * rightX + dz * rightZ,
        forward: dx * forwardX + dz * forwardZ
      });
    }

    return {
      centroid: { x: cx, z: cz },
      initialFacing: facing,
      offsets
    };
  }

  // Replay the captured layout at (originX, originZ) with the given
  // facing. Each unit lands at:
  //
  //   dest = origin + right(facing) * lateral * widthScale
  //                + forward(facing) * forward
  //
  // widthScale = totalWidthUnits / naturalTotal, matching the line
  // path's own width scaling, so a drag that widens the group widens
  // the preserved layout by the same ratio. Clamped to [0.3, 3.0] so a
  // twitch-drag cannot collapse the group to a point or explode it.
  //
  // No sorting, no reordering. A unit whose captured forward offset is
  // positive (in front of the centroid at drag start) lands in front of
  // the new centroid at the new facing; a unit behind lands behind. A
  // unit on the left lands on the left. This is the whole point.
  //
  // A unit that entered the selection after the snapshot was taken
  // (there is no path to that today — the selection is frozen at
  // mousedown — but the guard keeps this robust) falls back to the
  // centroid so it at least does not land at a stale position.
  _computePreservedPlacements(selectedUnits, facing, totalWidthUnits, originX, originZ) {
    const layout = this._preserveLayout;
    const n = selectedUnits.length;
    if (n === 0) return [];

    const naturalWidths = selectedUnits.map(u =>
      this.defaultWidthByUnit.get(u.id) || u.currentWidthUnits || 3
    );
    const naturalTotal = naturalWidths.reduce((a, b) => a + b, 0);

    let widthScale = 1.0;
    if (totalWidthUnits && naturalTotal > 0) {
      widthScale = totalWidthUnits / naturalTotal;
      widthScale = Math.max(0.3, Math.min(widthScale, 3.0));
    }

    const rightX = Math.cos(facing);
    const rightZ = -Math.sin(facing);
    const forwardX = Math.sin(facing);
    const forwardZ = Math.cos(facing);

    const placements = [];
    for (let i = 0; i < n; i++) {
      const unit = selectedUnits[i];
      const off = layout.offsets.get(unit.id);
      if (!off) {
        placements.push({
          unit,
          cx: originX,
          cz: originZ,
          width: naturalWidths[i]
        });
        continue;
      }
      const lat = off.lateral * widthScale;
      const fwd = off.forward;
      placements.push({
        unit,
        cx: originX + rightX * lat + forwardX * fwd,
        cz: originZ + rightZ * lat + forwardZ * fwd,
        width: naturalWidths[i] * widthScale
      });
    }
    return placements;
  }

// Sort a selection into left-to-right order along the formation's right
  // axis, derived from `facing`.
  //
  // This is the fix for the group-move mirroring bug. The selection Set
  // iterates in insertion order (master units array order for box-select,
  // click order for individual picks), which is unrelated to where the
  // units actually stand on the field. Feeding that order into
  // _computeLinePlacements assigns the leftmost slot to whichever unit
  // happens to be earliest in the Set — producing the "right unit goes
  // left, left unit goes right" mirroring.
  //
  // Sorts by each unit's current center projected onto the formation's
  // right axis, ascending: the unit furthest "left" relative to the
  // formation's facing gets the most negative placement offset, which is
  // the leftmost slot in _computeLinePlacements' output.
  //
  // Intended to run ONCE, at drag start, against the initial average
  // facing — not per mousemove. The drag's own facing is derived from the
  // cursor and rotates during the drag; re-sorting against a live-
  // rotating axis would let the order flip mid-drag. A stable assignment
  // for the whole drag is what the player expects.
  //
  // Tie-break on unit id for determinism — two units whose centers
  // project to the same value (exactly collinear along the facing axis)
  // must still get a consistent relative order across frames.
// Sort a selection into left-to-right order along the formation's right
  // axis, derived from `facing`. Secondary key is depth along the
  // formation's forward axis; tertiary is unit id.
  //
  // This is the fix for the group-move mirroring bug. The selection Set
  // iterates in insertion order (master units array order for box-select,
  // click order for individual picks), which is unrelated to where the
  // units actually stand on the field. Feeding that order into
  // _computeLinePlacements assigns the leftmost slot to whichever unit
  // happens to be earliest in the Set — producing the "right unit goes
  // left, left unit goes right" mirroring.
  //
  // Keys, in order:
  //   1. Lateral projection onto right axis. The unit physically on the
  //      LEFT of the selection (from the formation's frame at `facing`)
  //      sorts first and therefore takes the leftmost slot in
  //      _computeLinePlacements' output. This is what preserves the
  //      relative left/right arrangement of the selected units.
  //   2. Depth projection onto forward axis. Only fires on a lateral
  //      tie — two units stacked directly in front/behind each other
  //      along the drag's forward axis. Ordering back-most first keeps
  //      the arrangement deterministic and matches the field reading
  //      order, instead of falling through to an id tiebreak on
  //      floating-point-equal lateral projections.
  //   3. Id. Full determinism for the (rare) case of two units at the
  //      same lateral AND same depth projection.
  //
  // Intended to run ONCE, at drag start, against the initial average
  // facing — not per mousemove. The drag's own facing is derived from the
  // cursor and rotates during the drag; re-sorting against a live-
  // rotating axis would let the order flip mid-drag. A stable assignment
  // for the whole drag is what the player expects.
  //
  // NOTE on what is NOT preserved: depth stagger. A shallow V or a
  // front/back-staggered selection collapses to a straight line at the
  // destination, because the target formation is a line. Depth is only
  // used as a tiebreak key here; it is not a target position. Preserving
  // a non-line shape requires a template-based formation mode, which is
  // a separate feature from this fix.
  _sortByLateralPosition(units, facing) {
    const rightX = Math.cos(facing);
    const rightZ = -Math.sin(facing);
    const forwardX = Math.sin(facing);
    const forwardZ = Math.cos(facing);

    return [...units].sort((a, b) => {
      const ca = a.getCenter();
      const cb = b.getCenter();

      const lateralA = ca.x * rightX + ca.z * rightZ;
      const lateralB = cb.x * rightX + cb.z * rightZ;
      if (lateralA !== lateralB) return lateralA - lateralB;

      const depthA = ca.x * forwardX + ca.z * forwardZ;
      const depthB = cb.x * forwardX + cb.z * forwardZ;
      if (depthA !== depthB) return depthA - depthB;

      const ida = String(a.id);
      const idb = String(b.id);
      if (ida < idb) return -1;
      if (ida > idb) return 1;
      return 0;
    });
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

  _issueGroupOrder(selectedUnits, x, z, facing, totalWidthUnits, directMarch = false) {
    const explicitFacing = facing !== undefined && facing !== null;
    const opts = (directMarch || explicitFacing)
      ? { directMarch: directMarch, forceFacing: explicitFacing }
      : undefined;

    if (selectedUnits.length === 1) {
      if (!this._isInsideBounds(x, z)) return false;
      if (totalWidthUnits) {
        selectedUnits[0].issueFormationOrder(x, z, facing, totalWidthUnits, opts);
      } else {
        selectedUnits[0].issueMoveOrder(x, z, facing, opts);
      }
      return true;
    }

    const resolvedFacing = explicitFacing
      ? facing
      : this._averageFacing(selectedUnits);

    const placements = this._computeLinePlacements(
      selectedUnits, resolvedFacing, totalWidthUnits, x, z
    );

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
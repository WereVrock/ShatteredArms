import { SoldierView } from './SoldierView.js';
import { ProjectileView } from './ProjectileView.js';
import { ShieldBreakView } from './ShieldBreakView.js';
import { RangeCircleView } from './RangeCircleView.js';
import { PathLineView } from './PathLineView.js';
import { CorridorDebugView } from './CorridorDebugView.js';
import { FormationSlotDebugView } from './FormationSlotDebugView.js';
import { UnitOverlayView } from './UnitOverlayView.js';
import { SelectionRingFactory } from './SelectionRingFactory.js';
import { isRanged, getRangedRange } from '../config/UnitClasses.js';
import { SoldierInstancer } from './SoldierInstancer.js';
import { SettingsStore } from '../ui/settings/SettingsStore.js';
import * as THREE from 'three';

// Owns SoldierViews, active projectiles, short-lived effect views, and
// per-unit range circles, drives per-frame sync from sim state, and
// translates combat events into visuals. No combat logic.

// Initial capacity for the instanced selection-ring pool. It grows on
// demand — the value is a starting allocation, not a hard cap.
const SELECTION_RING_CAPACITY = 512;

// Reusable matrix + dummy object for InstancedMesh updates. Allocating
// these per frame would churn GC during long battles.
const _ringDummy = new THREE.Object3D();
_ringDummy.rotation.x = -Math.PI / 2;
_ringDummy.position.y = 0.02;

export class BattleRenderer {
  constructor(sceneSetup) {
    this.sceneSetup = sceneSetup;
    this.views = new Map();
    this.projectileViews = new Map();
    this._projectileViewPool = [];
    this.shieldBreaks = [];
    this.rangeCircles = new Map();

    this.debugPathLine = new PathLineView(sceneSetup.scene);
    this.corridorDebugView = new CorridorDebugView(sceneSetup.scene);
    this.formationSlotDebugView = new FormationSlotDebugView(sceneSetup.scene);
    this.unitOverlayView = new UnitOverlayView(sceneSetup.scene);

    // One InstancedMesh carrying every selected soldier's ring. Replaces
    // a per-soldier ring mesh, which was one scene-graph node per soldier
    // even when hidden. The pool grows on demand; `count` controls how
    // many instances actually draw each frame.
    this._selectionRingMesh = new THREE.InstancedMesh(
      SelectionRingFactory.getGeometry(),
      SelectionRingFactory.getMaterial(),
      SELECTION_RING_CAPACITY
    );
    this._selectionRingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._selectionRingMesh.count = 0;
    this._selectionRingMesh.frustumCulled = false;
    this._selectionRingMesh.renderOrder = 5;
    sceneSetup.scene.add(this._selectionRingMesh);

    this._debugModeOn = false;

    // Collapses every soldier's model parts into a few instanced draw
    // calls. Enabled state follows the Graphics setting and is re-checked
    // every frame in syncWithSimulation.
    this._instancer = new SoldierInstancer(
      sceneSetup.scene,
      SettingsStore.get().instancedRendering !== false
    );
    this._selectedUnitsProvider = null;
  }

  setDebugPathUnit(unit) {
    this.debugPathLine.setUnit(unit);
  }

  setPlayerTeamId(teamId) {
    this.unitOverlayView.setPlayerTeamId(teamId);
  }

  setDebugModeOn(isOn, selectedUnitsProvider) {
    this._debugModeOn = !!isOn;
    this._selectedUnitsProvider = selectedUnitsProvider || null;
    if (!this._debugModeOn) {
      this.formationSlotDebugView.setUnits([]);
    }
  }

  pushCorridorEvent(evt) {
    this.corridorDebugView.push(evt);
  }

  setDebugCorridorUnit(unit) {
    this.corridorDebugView.setWatchedUnit(unit);
  }

  syncWithSimulation(allSoldiers, unitsById, meleeEvents, rangedEvents, projectiles, deltaSeconds) {
    for (const soldier of allSoldiers) {
      if (!this.views.has(soldier.id)) {
        const view = new SoldierView(soldier, this.sceneSetup.scene);
        this.views.set(soldier.id, view);
        this._instancer.adopt(view);
      }
    }

    for (const event of meleeEvents) {
      this._applyMeleeEvent(event);
    }
    for (const event of rangedEvents) {
      this._applyRangedEvent(event);
    }

    const cameraPos = this.sceneSetup.camera.position;
    for (const view of this.views.values()) {
      view.sync(cameraPos, unitsById, deltaSeconds);
    }

    // Instancing: follow the Graphics toggle, then rebuild the instance
    // buckets from the poses the views just wrote. Runs after every
    // view.sync and before the renderer draws.
    const settings = SettingsStore.get();
    const wantInstancing = settings.instancedRendering !== false;
    if (wantInstancing !== this._instancer.enabled) {
      this._instancer.setEnabled(wantInstancing, this.views.values());
    }
    const shadowRange = parseFloat(settings.soldierShadowRange);
    this._instancer.update(
      this.views.values(),
      this.sceneSetup.camera,
      this.sceneSetup.cameraTarget,
      shadowRange > 0 ? shadowRange : Infinity
    );

    // Force the shadow map to refresh whenever the sim has advanced.
    //
    // The throttle in SceneSetup.render() is fine for stationary
    // soldiers, but not for moving ones: the throttle timer and the sim
    // tick are independent clocks (both ~30 Hz but not phase-locked), so
    // a tick frame can leave the body at its new pose while the shadow
    // map still holds the previous pose. For 1-2 frames the body is
    // visibly offset from its own shadow — the "body flickers / body
    // appears behind its shadow" artifact.
    //
    // deltaSeconds is the visual delta from main.js: 0 while paused,
    // frameDelta otherwise. Any non-zero value means the sim may have
    // advanced (and the instancer has just rewritten its bucket data
    // above), so the shadow must be refreshed this frame to stay in
    // sync. When paused or between ticks, no call is made and the
    // regular throttle continues to govern the update rate.
    if (deltaSeconds > 0) {
      this.sceneSetup.forceShadowUpdate();
    }

    this._syncProjectileViews(projectiles);

    this.shieldBreaks = this.shieldBreaks.filter(effect => {
      const alive = effect.update(deltaSeconds);
      if (!alive) effect.dispose();
      return alive;
    });

    this._syncRangeCircles(unitsById);
    this._syncSelectionRings(allSoldiers, unitsById);
    this.unitOverlayView.update(unitsById, deltaSeconds);
    this.debugPathLine.sync();
    this.corridorDebugView.update(deltaSeconds);

    if (this._debugModeOn && this._selectedUnitsProvider) {
      this.formationSlotDebugView.setUnits(Array.from(this._selectedUnitsProvider()));
    } else {
      this.formationSlotDebugView.setUnits([]);
    }
    this.formationSlotDebugView.sync();
  }

  // Populates the instanced selection-ring mesh from every alive soldier
  // whose unit is currently selected. One instance per soldier; `count`
  // is the number actually drawn this frame.
  //
  // The InstancedMesh's backing buffer is grown only when the live
  // selection exceeds the current capacity, so a battle where the player
  // never selects more than a few dozen soldiers allocates the initial
  // capacity once and never touches it again.
  _syncSelectionRings(allSoldiers, unitsById) {
    // Capacity vs drawn-count: `instanceMatrix.count` is the allocated
    // buffer size and never changes except on an explicit grow. `.count`
    // is how many instances drew LAST frame. An earlier version of this
    // method compared instanceIdx against `.count` — which is 0 on the
    // first frame and equal to the previous frame's instance count on
    // every subsequent frame, so the growth branch fired for every
    // selected soldier on every frame, doubling the buffer each time
    // until the Float32Array allocation failed.
    //
    // The fix compares against the true capacity, and grows at most once
    // per frame. allSoldiers is the entire soldier list including
    // corpses, so its length is a safe upper bound on instances needed
    // this frame: dead soldiers are skipped below, but a frame where
    // every soldier is alive and selected would need exactly that many.
    if (this._selectionRingMesh.instanceMatrix.count < allSoldiers.length) {
      this._growSelectionRingPool(allSoldiers.length);
    }

    let instanceIdx = 0;
    for (const s of allSoldiers) {
      if (s.state === 'dead') continue;
      const unit = unitsById.get(s.unitId);
      if (!unit || !unit.selected) continue;

      _ringDummy.position.x = s.pos.x;
      _ringDummy.position.z = s.pos.z;
      _ringDummy.updateMatrix();
      this._selectionRingMesh.setMatrixAt(instanceIdx, _ringDummy.matrix);
      instanceIdx++;
    }

    this._selectionRingMesh.count = instanceIdx;
    if (instanceIdx > 0) {
      this._selectionRingMesh.instanceMatrix.needsUpdate = true;
    }
  }

  _growSelectionRingPool(needed) {
    const old = this._selectionRingMesh;
    const newCap = Math.max(old.instanceMatrix.count * 2, needed);
    const next = new THREE.InstancedMesh(
      SelectionRingFactory.getGeometry(),
      SelectionRingFactory.getMaterial(),
      newCap
    );
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    next.count = old.count;
    next.frustumCulled = false;
    next.renderOrder = 5;

    // Copy the live instances across so nothing pops.
    for (let i = 0; i < old.count; i++) {
      old.getMatrixAt(i, _ringDummy.matrix);
      next.setMatrixAt(i, _ringDummy.matrix);
    }
    next.instanceMatrix.needsUpdate = true;

    this.sceneSetup.scene.remove(old);
    this.sceneSetup.scene.add(next);
    // The geometry and material are shared with the old mesh — do not
    // dispose them here, they belong to the cache.
    old.dispose();
    this._selectionRingMesh = next;
  }

  _syncRangeCircles(unitsById) {
    const activeUnitIds = new Set();

    for (const [unitId, unit] of unitsById) {
      if (!unit.selected) continue;

      const lead = unit.getAliveSoldiers()[0];
      if (!lead) continue;
      if (!isRanged(lead.unitTypeDef)) continue;

      activeUnitIds.add(unitId);

      let circle = this.rangeCircles.get(unitId);
      if (!circle) {
        circle = new RangeCircleView(this.sceneSetup.scene);
        this.rangeCircles.set(unitId, circle);
      }

      const center = unit.getCenter();
      circle.show(center.x, center.z, getRangedRange(lead.unitTypeDef));
    }

    for (const [unitId, circle] of this.rangeCircles) {
      if (!activeUnitIds.has(unitId)) {
        circle.hide();
      }
    }
  }

  _syncProjectileViews(projectiles) {
    if (!projectiles) return;
    const seen = new Set();
    for (const p of projectiles) {
      seen.add(p.id);
      let view = this.projectileViews.get(p.id);
      if (!view) {
        view = this._projectileViewPool.pop()
          || new ProjectileView(this.sceneSetup.scene);
        view.attach(p);
        this.projectileViews.set(p.id, view);
      } else {
        view.sync(p);
      }
    }
    for (const id of Array.from(this.projectileViews.keys())) {
      if (seen.has(id)) continue;
      const view = this.projectileViews.get(id);
      view.release();
      this._projectileViewPool.push(view);
      this.projectileViews.delete(id);
    }
  }

  _applyMeleeEvent(event) {
    if (event.type === 'attack') {
      const attackerView = this.views.get(event.attackerId);
      if (attackerView) attackerView.triggerAttackAnim();
    }
    if (event.type === 'block') {
      const defenderView = this.views.get(event.defenderId);
      if (defenderView) defenderView.triggerBlockFlash();
    }
    if (event.type === 'shieldBreak') {
      this._spawnShieldBreak(event.defenderId);
    }
  }

  _applyRangedEvent(event) {
    if (event.type === 'fire') {
      if (event.attackerId != null) {
        const shooterView = this.views.get(event.attackerId);
        if (shooterView) shooterView.setAimTarget(event.toPos.x, event.toPos.z);
      }
    }
    if (event.type === 'block') {
      const defenderView = this.views.get(event.defenderId);
      if (defenderView) defenderView.triggerBlockFlash();
    }
    if (event.type === 'shieldBreak') {
      this._spawnShieldBreak(event.defenderId);
    }
  }

  _spawnShieldBreak(defenderId) {
    const view = this.views.get(defenderId);
    if (!view || !view.soldier.isAlive()) return;
    this.shieldBreaks.push(new ShieldBreakView(
      view.soldier.pos.x,
      view.soldier.pos.z,
      this.sceneSetup.scene
    ));
  }

  // Retained for backward compatibility — anything still asking for the
  // old per-soldier pick proxies gets an empty list. Picking now runs
  // through SelectionController.pickUnitAtScreen, which projects soldier
  // positions to the screen and needs no scene geometry.
  getPickableMeshes() {
    return [];
  }

  getInstancingStats() {
    return this._instancer.describe();
  }

  getSoldierView(soldierId) {
    return this.views.get(soldierId);
  }

  render() {
    this.sceneSetup.render();
  }
}
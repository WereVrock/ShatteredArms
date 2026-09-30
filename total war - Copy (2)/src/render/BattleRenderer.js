import { SoldierView } from './SoldierView.js';
import { ProjectileView } from './ProjectileView.js';
import { ShieldBreakView } from './ShieldBreakView.js';
import { RangeCircleView } from './RangeCircleView.js';
import { PathLineView } from './PathLineView.js';
import { CorridorDebugView } from './CorridorDebugView.js';
import { FormationSlotDebugView } from './FormationSlotDebugView.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { isRanged } from '../config/UnitClasses.js';

// Owns SoldierViews, active projectiles, short-lived effect views, and
// per-unit range circles, drives per-frame sync from sim state, and
// translates combat events into visuals. No combat logic.
export class BattleRenderer {
  constructor(sceneSetup) {
    this.sceneSetup = sceneSetup;
    this.views = new Map();
    // Sim-authoritative arrows: one ProjectileView per live projectile,
    // keyed by projectile id. Views are created the first frame a
    // projectile appears in the sim's active list and disposed the first
    // frame it disappears. See _syncProjectileViews.
    this.projectileViews = new Map();
    // Recycled ProjectileView instances. Arrows spawn and despawn
    // constantly during a volley; without pooling, every spawn churns a
    // new mesh into the scene graph and every impact churns one out. The
    // pool keeps released views parented to the scene with visible=false,
    // so spawn/despawn is a Map write plus a visibility flip — no
    // scene-graph mutation, no per-arrow allocation.
    this._projectileViewPool = [];
    this.shieldBreaks = [];
    // One range circle per ranged unit, created lazily and reused. Keyed by
    // unitId. Non-ranged units never get an entry.
    this.rangeCircles = new Map();

    // Debug overlay: a single line from a chosen unit's center to its
    // formationOrigin. Used by the G+click enemy inspect flow — see main.js.
    // Null target hides the line.
    this.debugPathLine = new PathLineView(sceneSetup.scene);

    // Corridor-check debug overlay. Red translucent rectangles along the
    // approach corridors ChargeReadiness refused, fading over 2 seconds of
    // sim-time. Fed from AIDebugLog.onCorridorEvent (wired in main.js).
    // Fully gated on debug mode — see setDebugModeOn.
    this.corridorDebugView = new CorridorDebugView(sceneSetup.scene);

    // Formation-slot debug overlay: dots at each selected soldier's
    // formationSlot plus a line to their current position. Gated on debug
    // mode the same way as the corridor view.
    this.formationSlotDebugView = new FormationSlotDebugView(sceneSetup.scene);

    // Single source of truth for "is debug mode currently on." True exactly
    // while a G+click debug target is selected (see main.js's
    // onDebugSelectionChanged). Both the corridor view and the formation-slot
    // view are only populated while this is true.
    this._debugModeOn = false;
    this._selectedUnitsProvider = null;
  }

  // Set (or clear, with null) the unit whose path is drawn. Called by
  // main.js when the G+click debug target changes.
  setDebugPathUnit(unit) {
    this.debugPathLine.setUnit(unit);
  }

  // Turns debug mode on/off. `selectedUnitsProvider` is a zero-arg function
  // returning the current array/Set of player-selected units (main.js passes
  // () => selectionController.selectedUnits) — read lazily each sync so the
  // formation-slot view always reflects the LIVE selection, not a stale
  // snapshot from the moment debug mode was toggled on.
  setDebugModeOn(isOn, selectedUnitsProvider) {
    this._debugModeOn = !!isOn;
    this._selectedUnitsProvider = selectedUnitsProvider || null;
    if (!this._debugModeOn) {
      this.formationSlotDebugView.setUnits([]);
    }
  }

  // Forward a corridor-check geometry event from AIDebugLog to the view.
  // Wired from main.js via AIDebugLog.onCorridorEvent.
  pushCorridorEvent(evt) {
    this.corridorDebugView.push(evt);
  }

  // Set (or clear, with null) the unit whose corridor tests are shown.
  // When set, CorridorDebugView shows every test from that unit (clean
  // and refused alike); when null, corridor debug shows nothing. Wired from
  // main.js's debug-selection callback.
  setDebugCorridorUnit(unit) {
    this.corridorDebugView.setWatchedUnit(unit);
  }

  syncWithSimulation(allSoldiers, unitsById, meleeEvents, rangedEvents, projectiles, deltaSeconds) {
    for (const soldier of allSoldiers) {
      if (!this.views.has(soldier.id)) {
        this.views.set(soldier.id, new SoldierView(soldier, this.sceneSetup.scene));
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

    this._syncProjectileViews(projectiles);

    this.shieldBreaks = this.shieldBreaks.filter(effect => {
      const alive = effect.update(deltaSeconds);
      if (!alive) effect.dispose();
      return alive;
    });

    this._syncRangeCircles(unitsById);
    this.debugPathLine.sync();
    this.corridorDebugView.update(deltaSeconds);

    if (this._debugModeOn && this._selectedUnitsProvider) {
      this.formationSlotDebugView.setUnits(Array.from(this._selectedUnitsProvider()));
    } else {
      this.formationSlotDebugView.setUnits([]);
    }
    this.formationSlotDebugView.sync();
  }

  // A range circle is shown for every currently-selected ranged unit, centred
  // on that unit's live centre and sized to CombatConfig.rangedRange. Any
  // unit that is no longer selected (or no longer has living ranged soldiers)
  // has its circle hidden. Circles are pooled per-unit and only disposed when
  // the unit itself disappears, which in this codebase is never during a
  // battle.
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
      circle.show(center.x, center.z, CombatConfig.rangedRange);
    }

    for (const [unitId, circle] of this.rangeCircles) {
      if (!activeUnitIds.has(unitId)) {
        circle.hide();
      }
    }
  }

  // One ProjectileView per live sim-side arrow. Views are created the
  // first frame a projectile id appears in the sim's active list and
  // disposed the first frame it vanishes. Positions come straight from
  // sim state — the sim owns the trajectory, the view just mirrors it.
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
    // Concurrent-safe: iterate a snapshot of keys so deletion during the
    // loop cannot disturb the iterator.
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
      // Arrow visuals are no longer spawned here — the sim owns the
      // projectile and BattleRenderer mirrors it via _syncProjectileViews.
      // The 'fire' event survives only to carry the launch target, so the
      // shooter's bow can be pitched to the same launch angle the arrow
      // leaves at.
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

  getPickableMeshes() {
    const result = [];
    for (const v of this.views.values()) {
      if (!v.soldier.isAlive()) continue;
      if (!v.pickProxy) continue;
      result.push(v.pickProxy);
    }
    return result;
  }

  getSoldierView(soldierId) {
    return this.views.get(soldierId);
  }

  render() {
    this.sceneSetup.render();
  }
}
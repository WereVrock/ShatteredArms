// ===== CorridorDebugView.js =====
// Debug overlay: draws each refused charge corridor as a red translucent
// rectangle on the ground, fading over FADE_DURATION seconds of sim-time.
// Freezes while the game is paused because main.js passes visualDelta
// (0 when paused) to update().
//
// Geometry: a flat quad from cavCenter to defCenter, half-width = the
// corridor's halfWidth from CombatConfig, offset perpendicular to the
// approach direction. Four vertices updated in place — no rotation math,
// no parent transform.
//
// Events are pushed via BattleRenderer.pushCorridorEvent() which is fed
// by AIDebugLog.onCorridorEvent (wired in main.js). The view holds a small
// pool of meshes; recycled after each event expires so a long battle with
// many refusals doesn't leak GPU resources.
import * as THREE from 'three';

// Seconds of sim-time a corridor stays visible before fully faded. Two
// seconds at 15Hz = 30 sim ticks. Enough to read the geometry, short
// enough that continuous refusals don't stack into a solid red field.
const FADE_DURATION = 2.0;

// Slightly above ground (Y = 0.02 is the ground decal convention already
// used by SelectionRingFactory and RangeCircleView) so the corridor
// renders over terrain and other decals, but under soldier bodies.
const Y = 0.06;

// Hard cap on simultaneous visible corridors. Excess events evict the
// oldest first, so the most recent refusals are always the ones on screen.
const MAX_EVENTS = 24;

const BASE_OPACITY = 0.42;

export class CorridorDebugView {
  constructor(scene) {
    this.scene = scene;

    // Each entry: { mesh, timeLeft, attackerUnitId }
    this.events = [];

    // Pooled meshes; recycled after fade-out. Acquired on first push.
    this._pool = [];

    // When set, only corridor events from this unit are shown — used by
    // the G+click debug flow so a single unit's corridor tests are
    // visible in isolation. When null, only refused events show (the
    // default behavior: clean charges produce no visual noise).
    this.watchedUnitId = null;
  }

  // Called by BattleRenderer when the debug-selected unit changes.
  // Passing null clears the watch.
  setWatchedUnit(unit) {
    this.watchedUnitId = unit ? unit.id : null;
  }

  // Called by BattleRenderer.pushCorridorEvent. Non-filtered — every
  // refusal produces a rectangle. (Filtering to a selected unit was
  // considered; left out so the view works without any selection flow.)
// Called by BattleRenderer.pushCorridorEvent. Fully gated on debug mode:
  // when no unit is being watched (G+click debug target is not set), NO
  // corridor geometry is drawn at all, refused or clean. Previously this
  // showed refusals unconditionally even with no debug target selected —
  // that partial "always on" behavior is what made it impossible to tell
  // whether corridor drawing was tied to debug mode at all. Now corridor
  // visualization only ever appears while a debug target is active.
  push(evt) {
    const watched = this.watchedUnitId;
    if (watched === null) return;
    if (evt.attackerUnitId !== watched) return;

    const mesh = this._acquire();
    if (!this._setGeometry(mesh, evt)) {
      this._release(mesh);
      return;
    }

    // Three-way verdict, at a glance:
    //   green  — accepted. Charge goes through (clean corridor, or
    //            overwhelmed — the cav outnumbered the corridor's
    //            spearmen past corridorOverwhelmingRatio, so the
    //            corridor is treated as clean).
    //   red    — rejected. A spear in the corridor would brace in time.
    //   yellow — skipped. The corridor sample was bypassed entirely by
    //            ChargeReadiness.shouldSkipCorridor, so there is no
    //            verdict — this is informational only.
    //
    // Skipped is tested FIRST: a skipped corridor also has refused=false
    // and overwhelmed=false, so without this ordering it would render
    // green and read as a verdict it never made.
    if (evt.skipped) {
      mesh.material.color.setHex(0xffff00);
    } else if (evt.refused) {
      mesh.material.color.setHex(0xff2020);
    } else {
      mesh.material.color.setHex(0x00ff00);
    }

    mesh.visible = true;
    mesh.material.opacity = BASE_OPACITY;

    this.events.push({
      mesh,
      timeLeft: FADE_DURATION,
      attackerUnitId: evt.attackerUnitId
    });

    // Evict oldest if over capacity.
    while (this.events.length > MAX_EVENTS) {
      const old = this.events.shift();
      old.mesh.visible = false;
      this._release(old.mesh);
    }
  }

  // deltaSeconds is visualDelta from main.js — 0 while paused, which
  // freezes both the fade and the eventual eviction. Selection changes
  // while paused still work because visibility is recomputed each call.
  update(deltaSeconds) {
    const advancing = deltaSeconds > 0;

    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];

      if (advancing) e.timeLeft -= deltaSeconds;

      if (e.timeLeft <= 0) {
        e.mesh.visible = false;
        this._release(e.mesh);
        this.events.splice(i, 1);
        continue;
      }

      // Opacity tracks remaining time; linearly fades from BASE_OPACITY
      // at T=FADE_DURATION to 0 at T=0.
      e.mesh.material.opacity = BASE_OPACITY * (e.timeLeft / FADE_DURATION);
    }
  }

  dispose() {
    for (const e of this.events) {
      this.scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh.material.dispose();
    }
    for (const m of this._pool) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.events.length = 0;
    this._pool.length = 0;
  }

  _acquire() {
    if (this._pool.length > 0) return this._pool.pop();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    // Quad as two triangles: 0-1-2 and 0-2-3.
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xff2020,
      transparent: true,
      opacity: BASE_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const mesh = new THREE.Mesh(geo, mat);
    // Corridors can span many grid cells; skip frustum culling so a
    // mid-battle zoom-out doesn't accidentally cull a live corridor.
    mesh.frustumCulled = false;
    mesh.renderOrder = 998;
    mesh.visible = false;

    this.scene.add(mesh);
    return mesh;
  }

  _release(mesh) {
    mesh.visible = false;
    this._pool.push(mesh);
  }

  // Writes the four corner positions of the corridor quad in place.
  // Returns false on degenerate geometry (cav and target at same point).
  _setGeometry(mesh, evt) {
    const { cavX, cavZ, defX, defZ, halfWidth } = evt;

    const dx = defX - cavX;
    const dz = defZ - cavZ;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return false;

    // Unit perpendicular to the corridor axis. Left-hand rule: rotate the
    // axis vector by 90 degrees.
    const px = -dz / len;
    const pz = dx / len;
    const hw = halfWidth;

    const arr = mesh.geometry.attributes.position.array;
    // Corner order: cav+, cav-, def-, def+  →  quad 0-1-2-3.
    arr[0]  = cavX + px * hw; arr[1]  = Y; arr[2]  = cavZ + pz * hw;
    arr[3]  = cavX - px * hw; arr[4]  = Y; arr[5]  = cavZ - pz * hw;
    arr[6]  = defX - px * hw; arr[7]  = Y; arr[8]  = defZ - pz * hw;
    arr[9]  = defX + px * hw; arr[10] = Y; arr[11] = defZ + pz * hw;

    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
    return true;
  }
}
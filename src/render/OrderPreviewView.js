import * as THREE from 'three';

const ATTACK_FLASH_DURATION = 1.1;
// One-shot formation-slot flash shown after a plain move order commits.
// Shorter than the attack flash: this is a confirmation, not an effect,
// and it should clear before the player's next interaction most of the
// time.
const GHOST_FLASH_DURATION = 0.55;

// Shows destination ring + facing arrow, per-unit "current position" highlight
// rings, per-soldier chevron ghost markers (future slots, rotated to the new
// facing), and short-lived red rings that pulse on an enemy unit when an
// attack order is issued so the player gets visual confirmation.
export class OrderPreviewView {
  constructor(scene) {
    this.scene = scene;

    this.group = new THREE.Group();
    this.group.visible = false;

    const ringGeo = new THREE.RingGeometry(0.9, 1.05, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.group.add(this.ring);

    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.15);
    arrowShape.lineTo(-0.15, -0.1);
    arrowShape.lineTo(0.15, -0.1);
    arrowShape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.arrow = new THREE.Mesh(arrowGeo, arrowMat);
    this.arrow.rotation.x = -Math.PI / 2;
    this.arrow.position.set(0, 0.04, 1.3);
    this.group.add(this.arrow);

    scene.add(this.group);

    this.unitHighlightRings = [];
    this.ghostMarkers = [];
    // Short-lived ring flashes at ordered destinations. Both attack flashes
    // (red, for attack orders) and move flashes (pale blue, for plain move
    // orders) live here — same lifecycle, different colour.
    this.flashes = [];

    // One-shot formation ghost markers flashed after a plain move commits.
    // Kept in a separate pool from this.ghostMarkers (the persistent drag
    // preview) so a flash never steals a marker from a live drag, and a
    // live drag never blanks a still-fading flash.
    this._ghostFlashPool = [];
    this._ghostFlashTimeLeft = 0;

    // Persistent order-destination markers, shown while Ctrl is held. A
    // third pool, distinct from both the drag-preview pool and the
    // one-shot flash pool, for the same reason those two are separate:
    // the drag preview, the commit flash, and the Ctrl reveal have three
    // independent lifetimes, and sharing a pool would let any one of
    // them hide another's markers mid-frame.
    this._destinationMarkers = [];
  }

show(x, z, facing) {
    this.group.visible = true;
    this.group.position.set(x, 0, z);
    this.group.rotation.y = facing;
    // A live formation drag is starting. Cancel any lingering one-shot
    // ghost flash so the drag's persistent preview reads cleanly — two
    // overlapping sets of chevrons would be confusing.
    this._clearGhostFlash();
  }

  hide() {
    this.group.visible = false;
    for (const ring of this.unitHighlightRings) ring.visible = false;
    for (const marker of this.ghostMarkers) marker.visible = false;
  }

  showUnitHighlights(centers) {
    while (this.unitHighlightRings.length < centers.length) {
      this.unitHighlightRings.push(this._createUnitRing());
    }
    for (let i = 0; i < this.unitHighlightRings.length; i++) {
      const ring = this.unitHighlightRings[i];
      if (i < centers.length) {
        ring.visible = true;
        ring.position.set(centers[i].x, 0.025, centers[i].z);
      } else {
        ring.visible = false;
      }
    }
  }

  // Renders one small chevron per future soldier slot, all rotated to the
  // preview facing so the player can read which way each rank will point.
  showGhostSlots(slots, facing = 0) {
    while (this.ghostMarkers.length < slots.length) {
      this.ghostMarkers.push(this._createGhostMarker());
    }
    for (let i = 0; i < this.ghostMarkers.length; i++) {
      const marker = this.ghostMarkers[i];
      if (i < slots.length) {
        marker.visible = true;
        marker.position.set(slots[i].x, 0.05, slots[i].z);
        marker.rotation.y = facing;
      } else {
        marker.visible = false;
      }
    }
  }

// Persistent order-destination markers, shown while Ctrl is held.
  //
  // `markers` is a flat array of { x, z, facing } — one entry per future
  // soldier slot across every selected unit. Each marker is rotated to
  // its OWN facing (not a shared one), because the selected units can
  // have been given orders in different directions.
  //
  // Tinted the same pale cyan as the commit-flash ring so the reveal
  // reads as "the same thing you saw when you ordered," just longer-
  // lived. Distinct from the drag preview's white chevrons so the two
  // never look like the same overlay.
  //
  // Supersedes any still-active commit flash: the moment the persistent
  // reveal paints, the one-shot flash is cleared. Same semantic ("where
  // you sent them"), longer lifetime — showing both at once produces a
  // doubled-marker frame right after a commit while Ctrl happens to be
  // held.
  showOrderDestinations(markers) {
    if (markers.length > 0) this._clearGhostFlash();

    while (this._destinationMarkers.length < markers.length) {
      const m = this._createGhostMarker();
      m.visible = false;
      this._destinationMarkers.push(m);
    }
    for (let i = 0; i < this._destinationMarkers.length; i++) {
      const marker = this._destinationMarkers[i];
      if (i < markers.length) {
        const spec = markers[i];
        marker.visible = true;
        marker.position.set(spec.x, 0.05, spec.z);
        marker.rotation.y = spec.facing;
        // Color per-marker, per-frame. Selected units read blue, all
        // other controllable units read pale cyan. Set every frame
        // rather than only on creation because a unit's selection state
        // can change while Ctrl is held (clicking with Ctrl held still
        // goes through the normal selection path) and the reveal must
        // follow it without a pool rebuild.
        marker.material.color.setHex(
          spec.selected ? 0x4a9eff : 0x88ddff
        );
      } else {
        marker.visible = false;
      }
    }
  }

  // Hide every persistent order-destination marker. Called every frame
  // in which the reveal is not active — cheap when nothing is visible,
  // and a single unconditional call site rather than a "was visible
  // last frame" bookkeeping problem.
  hideOrderDestinations() {
    for (const m of this._destinationMarkers) m.visible = false;
  }

// Remove every currently-active one-shot flash, disposing GPU resources
  // the same way update() does on natural expiry. Used by main.js on the
  // pause-enter transition so a lingering commit flash does not freeze
  // on screen while the sim is paused (update() is fed a zero delta in
  // that state, so timeLeft would never advance and the flash would sit
  // there indefinitely).
  //
  // Also clears the ghost-flash pool: it is the companion marker set to
  // the move-order ring flash, and the two are always spawned together
  // by flashFormation, so leaving one behind without the other would
  // show a half-cleared confirmation.
  clearFlashes() {
    for (const f of this.flashes) {
      this.scene.remove(f.mesh);
      f.mesh.geometry.dispose();
      f.mesh.material.dispose();
    }
    this.flashes.length = 0;
    this._clearGhostFlash();
  }

// Red ring pulse at (x, z) confirming an attack order.
  flashAttackTarget(x, z) {
    this._spawnFlash(x, z, 0xff3030);
  }

  // Confirmation of a just-committed plain move order: a pale-blue ring
  // pulse at (x, z) plus a one-shot copy of the formation ghost slots at
  // the positions the soldiers will actually occupy. Distinct colour from
  // the attack flash so "marching there" and "attacking that" read
  // differently at a glance.
  //
  // The slot positions are computed by the caller (OrderDragController)
  // using the same line-placement math the order itself uses, so the
  // flash lands exactly where the soldiers will stand.
  flashFormation(x, z, facing, slots) {
    this._spawnFlash(x, z, 0x88ddff);
    this._spawnGhostFlash(slots, facing);
  }

  // Shared ring-flash spawn. Each flash is a freshly-built mesh, disposed
  // on expiry in update() — repeated orders therefore never leak GPU
  // resources.
  _spawnFlash(x, z, colorHex) {
    const mesh = this._createFlashRing(colorHex);
    mesh.position.set(x, 0.06, z);
    this.scene.add(mesh);
    this.flashes.push({ mesh, timeLeft: ATTACK_FLASH_DURATION });
  }

  // One-shot ghost markers at `slots`, all rotated to `facing`. Uses a
  // dedicated pool so it never contends with this.ghostMarkers (the
  // persistent formation-drag preview).
  _spawnGhostFlash(slots, facing) {
    while (this._ghostFlashPool.length < slots.length) {
      const m = this._createGhostMarker();
      m.visible = false;
      this._ghostFlashPool.push(m);
    }
    for (let i = 0; i < this._ghostFlashPool.length; i++) {
      const marker = this._ghostFlashPool[i];
      if (i < slots.length) {
        marker.visible = true;
        marker.position.set(slots[i].x, 0.05, slots[i].z);
        marker.rotation.y = facing;
        marker.material.opacity = 0.75;
      } else {
        marker.visible = false;
      }
    }
    this._ghostFlashTimeLeft = GHOST_FLASH_DURATION;
  }

  _clearGhostFlash() {
    this._ghostFlashTimeLeft = 0;
    for (const marker of this._ghostFlashPool) marker.visible = false;
  }

update(deltaSeconds) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.timeLeft -= deltaSeconds;
      const t = Math.max(0, Math.min(1, 1 - f.timeLeft / ATTACK_FLASH_DURATION));
      const scale = 1 + t * 2.2;
      f.mesh.scale.set(scale, scale, 1);
      f.mesh.material.opacity = 1 - t;

      if (f.timeLeft <= 0) {
        this.scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        f.mesh.material.dispose();
        this.flashes.splice(i, 1);
      }
    }

    if (this._ghostFlashTimeLeft > 0) {
      this._ghostFlashTimeLeft -= deltaSeconds;
      const alpha = Math.max(0, this._ghostFlashTimeLeft / GHOST_FLASH_DURATION) * 0.75;
      for (const marker of this._ghostFlashPool) {
        if (marker.visible) marker.material.opacity = alpha;
      }
      if (this._ghostFlashTimeLeft <= 0) {
        for (const marker of this._ghostFlashPool) marker.visible = false;
      }
    }
  }

  _createUnitRing() {
    const geo = new THREE.RingGeometry(1.1, 1.25, 24);
    const mat = new THREE.MeshBasicMaterial({ color: 0x4caf50, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    this.scene.add(mesh);
    return mesh;
  }

  // Chevron pointing in the unit's facing direction. Built in the XY plane
  // with its tip at +Y; the 'YXZ' rotation order lays it flat (X +90° maps
  // shape +Y to world +Z) and then spins it by mesh.rotation.y — matching the
  // codebase convention that forward = (sin(facing), cos(facing)).
  _createGhostMarker(colorHex = 0xffffff) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.16);
    shape.lineTo(-0.13, -0.12);
    shape.lineTo(0, -0.04);
    shape.lineTo(0.13, -0.12);
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape);
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.x = Math.PI / 2;
    this.scene.add(mesh);
    return mesh;
  }

  _createFlashRing(colorHex) {
    const geo = new THREE.RingGeometry(0.55, 0.75, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }
}
// A visual-only mirror of one sim-side Projectile. The sim owns the
// trajectory — ProjectileSystem advances the arrow each tick — and this
// view simply reads the resulting (x, y, z) and orients the arrowhead
// along its instantaneous velocity.
//
// Instances are POOLED. The constructor no longer takes a projectile: it
// builds a hidden arrow mesh parented to the scene, and the caller binds a
// projectile with attach() and unbinds with release(). BattleRenderer owns
// the pool (see _syncProjectileViews). A volley's worth of arrows therefore
// spawns and despawns with zero scene-graph churn — only a visibility flag
// and a Map entry change.
//
// The arrow itself is a single merged mesh (see mesh/ArrowBuilder.js), so
// each visible arrow is one draw call, not five.
//
// Heading is derived from the per-tick delta (current − previous). At
// spawn, prev == current (the sim has not advanced the arrow yet), so
// the view falls back to the launch yaw/pitch the sim recorded at spawn
// — the arrow never snaps to level facing for a single frame.
import { SoldierMeshFactory } from './SoldierMeshFactory.js';

export class ProjectileView {
  constructor(scene) {
    this.scene = scene;
    this.mesh = SoldierMeshFactory.createArrowProjectile();
    // 'YXZ' lets yaw (horizontal heading) and pitch (nose-up/nose-down
    // along the trajectory) compose the way the arrow visually needs.
    this.mesh.rotation.order = 'YXZ';
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.projectile = null;
  }

  // Bind a live projectile and make the arrow visible. Called by
  // BattleRenderer when a projectile id first appears in the sim's list.
  attach(projectile) {
    this.projectile = projectile;
    this.mesh.visible = true;
    this.sync(projectile);
  }

  // Unbind and hide. The view stays parented to the scene and returns to
  // the pool for reuse.
  release() {
    this.projectile = null;
    this.mesh.visible = false;
  }

  sync(projectile) {
    this.projectile = projectile;
    const p = projectile;

    this.mesh.position.set(p.x, p.y, p.z);

    const dx = p.x - p.prevX;
    const dz = p.z - p.prevZ;
    const dy = p.y - p.prevY;
    const horiz = Math.hypot(dx, dz);

    let yaw;
    let pitch;
    if (horiz > 1e-4) {
      yaw = Math.atan2(dx, dz);
      pitch = Math.atan2(dy, horiz);
    } else {
      yaw = p.yaw;
      pitch = p.launchPitch;
    }

    this.mesh.rotation.y = yaw;
    this.mesh.rotation.x = -pitch;
  }

  // Full teardown — only called on renderer shutdown, not per-arrow.
  dispose() {
    this.scene.remove(this.mesh);
  }
}
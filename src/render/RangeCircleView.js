import * as THREE from 'three';

// A flat ring on the ground marking a ranged unit's effective firing range.
// Authored at unit radius (1.0) and scaled to the actual range, so a single
// geometry/material pair serves any range value and any unit that shares it.
// Visibility is toggled by BattleRenderer based on unit selection state.
export class RangeCircleView {
  constructor(scene) {
    this.scene = scene;

    // Thin bright ring. 0.98-1.0 leaves a 2%-of-radius band, which at range
    // 14 reads as a ~0.28 unit line — visible but not dominating.
    this.geo = new THREE.RingGeometry(0.98, 1.0, 96);
    this.mat = new THREE.MeshBasicMaterial({
      color: 0x6fd6ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
      depthWrite: false
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.02;
    this.mesh.visible = false;

    scene.add(this.mesh);
  }

  show(x, z, radius) {
    this.mesh.visible = true;
    this.mesh.position.x = x;
    this.mesh.position.z = z;
    this.mesh.scale.setScalar(radius);
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
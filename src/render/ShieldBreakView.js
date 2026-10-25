import * as THREE from 'three';

// Short-lived visual effect spawned when a defender's shield breaks.
// Two layered pieces:
//   - an expanding ring at chest height, reading as "the shield popped"
//   - a small spray of wood-coloured fragments that arc outward and fall
// Duration is deliberately short — this is an accent, not a set piece.
const DURATION = 0.4;
const FRAGMENT_COUNT = 6;
const RING_START_RADIUS = 0.15;
const RING_END_RADIUS = 0.7;
const FRAGMENT_SPEED = 2.0;
const FRAGMENT_GRAVITY = 8.0;

export class ShieldBreakView {
  constructor(x, z, scene) {
    this.scene = scene;
    this.timeLeft = DURATION;

    this.group = new THREE.Group();
    this.group.position.set(x, 0.5, z);

    // Expanding ring. Scale is driven per-frame; the geometry is authored at
    // the start radius so scale = 1 is the initial size.
    this.ringGeo = new THREE.RingGeometry(
      RING_START_RADIUS,
      RING_START_RADIUS + 0.06,
      20
    );
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xd4b98a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1
    });
    this.ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring);

    // Fragments share geometry AND material — every fragment fades on the
    // same schedule, so a single material suffices and there's nothing to
    // clone.
    this.fragGeo = new THREE.BoxGeometry(0.08, 0.04, 0.02);
    this.fragMat = new THREE.MeshBasicMaterial({
      color: 0x8b5a2b,
      transparent: true,
      opacity: 1
    });

    this.fragments = [];
    for (let i = 0; i < FRAGMENT_COUNT; i++) {
      const angle = (i / FRAGMENT_COUNT) * Math.PI * 2;
      const frag = new THREE.Mesh(this.fragGeo, this.fragMat);
      frag.userData.vel = {
        x: Math.cos(angle) * FRAGMENT_SPEED,
        y: 1.5,
        z: Math.sin(angle) * FRAGMENT_SPEED
      };
      frag.userData.rotVel = {
        x: (Math.random() - 0.5) * 12,
        y: (Math.random() - 0.5) * 12,
        z: (Math.random() - 0.5) * 12
      };
      this.fragments.push(frag);
      this.group.add(frag);
    }

    scene.add(this.group);
  }

  update(deltaSeconds) {
    this.timeLeft -= deltaSeconds;
    const t = 1 - Math.max(0, this.timeLeft) / DURATION;

    const radius = RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * t;
    this.ring.scale.setScalar(radius / RING_START_RADIUS);
    this.ringMat.opacity = 1 - t;

    this.fragMat.opacity = 1 - t;
    for (const frag of this.fragments) {
      const v = frag.userData.vel;
      frag.position.x += v.x * deltaSeconds;
      frag.position.y += v.y * deltaSeconds;
      frag.position.z += v.z * deltaSeconds;
      v.y -= FRAGMENT_GRAVITY * deltaSeconds;

      const rv = frag.userData.rotVel;
      frag.rotation.x += rv.x * deltaSeconds;
      frag.rotation.y += rv.y * deltaSeconds;
      frag.rotation.z += rv.z * deltaSeconds;
    }

    return this.timeLeft > 0;
  }

  dispose() {
    this.scene.remove(this.group);
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.fragGeo.dispose();
    this.fragMat.dispose();
  }
}
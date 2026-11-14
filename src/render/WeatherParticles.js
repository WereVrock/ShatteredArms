// ===== WeatherParticles.js =====
// Lightweight ambient particle system. One THREE.Points mesh, one kind
// active at a time, positions updated on the CPU.
//
// Size is in PIXELS (sizeAttenuation: false). That is deliberate: with
// size-attenuation on, a 0.3-unit flake is sub-pixel from an overview
// camera and invisible. Pixel-sized particles read the same from every
// camera distance, which is what "atmospheric" needs. Mist uses a large
// pixel size and very low alpha to read as a soft haze rather than dots.

import * as THREE from 'three';

const KIND_CFG = {
  sand:         { count: 500, color: 0xd0b878, size: 6,  alpha: 0.55, spawnYMax: 22 },
  snow:         { count: 400, color: 0xffffff, size: 5,  alpha: 0.85, spawnYMax: 28 },
  mist:         { count: 120, color: 0x9aacb0, size: 30, alpha: 0.08, spawnYMax: 4 },
  'marsh-bugs': { count: 80,  color: 0x4a5a2a, size: 4,  alpha: 0.75, spawnYMax: 4 },
  // Volcanic ash. Warm reddish-brown so it catches the biome's red
  // fog rather than reading as grey dust. Count and speed sit between
  // sand (fast, blowing) and snow (slow, drifting) — ash drifts on
  // thermal updrafts, neither fast nor still.
  ash:          { count: 400, color: 0x5a3020, size: 5,  alpha: 0.60, spawnYMax: 25 }
};

export class WeatherParticles {
  constructor(scene) {
    this.scene = scene;
    this._points = null;
    this._positions = null;
    this._velocities = null;
    this._kind = null;
    this._bounds = 120;
    this._count = 0;
  }

  setKind(kind, bounds) {
    const newBounds = bounds || 120;
    if (kind === this._kind && newBounds === this._bounds) return;
    this._disposeMesh();
    this._kind = kind;
    this._bounds = newBounds;
    if (!kind || !KIND_CFG[kind]) return;
    this._buildMesh(kind);
  }

  _buildMesh(kind) {
    const cfg = KIND_CFG[kind];
    const positions = new Float32Array(cfg.count * 3);
    const velocities = new Float32Array(cfg.count * 3);
    const b = this._bounds;

    for (let i = 0; i < cfg.count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * b * 2;
      positions[i * 3 + 1] = Math.random() * cfg.spawnYMax;
      positions[i * 3 + 2] = (Math.random() - 0.5) * b * 2;

      if (kind === 'sand') {
        velocities[i * 3]     = 2.0 + Math.random() * 2.0;
        velocities[i * 3 + 1] = -0.2 + Math.random() * 0.4;
        velocities[i * 3 + 2] = 0.3 + Math.random() * 0.6;
      } else if (kind === 'snow') {
        velocities[i * 3]     = (Math.random() - 0.5) * 0.6;
        velocities[i * 3 + 1] = -1.2 - Math.random() * 1.0;
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
      } else if (kind === 'mist') {
        velocities[i * 3]     = 0.1 + Math.random() * 0.25;
        velocities[i * 3 + 1] = 0.02;
        velocities[i * 3 + 2] = 0.03 + Math.random() * 0.08;
      } else if (kind === 'ash') {
        // Slow drift downward with slight horizontal wander — thermal
        // updrafts would push some ash up, but for a battlefield the
        // downward read (matching snow) is what the eye expects.
        velocities[i * 3]     = (Math.random() - 0.5) * 0.4;
        velocities[i * 3 + 1] = -0.5 - Math.random() * 0.5;
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
      } else { // marsh-bugs
        velocities[i * 3]     = (Math.random() - 0.5) * 1.5;
        velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.6 + 0.2;
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: cfg.color,
      size: cfg.size,
      transparent: true,
      opacity: cfg.alpha,
      depthWrite: false,
      sizeAttenuation: false   // pixels, not world units
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 10;
    this.scene.add(points);

    this._points = points;
    this._positions = positions;
    this._velocities = velocities;
    this._count = cfg.count;
    this._spawnYMax = cfg.spawnYMax;
  }

  update(deltaSeconds, cameraTarget) {
    if (!this._points || !(deltaSeconds > 0)) return;

    const pos = this._positions;
    const vel = this._velocities;
    const b = this._bounds;
    const cx = cameraTarget.x;
    const cz = cameraTarget.z;
    const yMax = this._spawnYMax;
    const kind = this._kind;

    for (let i = 0; i < this._count; i++) {
      const ix = i * 3;
      const iy = ix + 1;
      const iz = ix + 2;

      pos[ix] += vel[ix] * deltaSeconds;
      pos[iy] += vel[iy] * deltaSeconds;
      pos[iz] += vel[iz] * deltaSeconds;

      if (pos[ix] - cx > b) pos[ix] -= b * 2;
      else if (pos[ix] - cx < -b) pos[ix] += b * 2;
      if (pos[iz] - cz > b) pos[iz] -= b * 2;
      else if (pos[iz] - cz < -b) pos[iz] += b * 2;

      if (kind === 'snow' || kind === 'sand' || kind === 'ash') {
        if (pos[iy] < 0) pos[iy] = yMax;
      } else {
        if (pos[iy] < 0) pos[iy] = yMax;
        else if (pos[iy] > yMax) pos[iy] = 0;
      }
    }

    this._points.geometry.attributes.position.needsUpdate = true;
  }

  _disposeMesh() {
    if (this._points) {
      this.scene.remove(this._points);
      this._points.geometry.dispose();
      this._points.material.dispose();
      this._points = null;
    }
    this._positions = null;
    this._velocities = null;
    this._count = 0;
  }

  dispose() {
    this._disposeMesh();
    this._kind = null;
  }
}
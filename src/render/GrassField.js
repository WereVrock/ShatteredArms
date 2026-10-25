// ===== GrassField.js =====
import * as THREE from 'three';

// Scattered grass tufts as a single InstancedMesh. One draw call regardless
// of tuft count. Each tuft is two crossed vertical quads with an alpha-tested
// canvas texture — crossed planes give a full silhouette from any horizontal
// angle without any per-frame billboarding, which keeps the whole thing
// static and cheap.
//
// The material uses alphaTest with transparent: false. Alpha testing discards
// fully-transparent fragments without enabling blending, which avoids the
// sorting cost and depth-order artefacts that grass with real transparency
// would otherwise cause at this instance count.
//
// Scatter region: a rectangle defined by `bounds` (typically
// CombatConfig.mapBounds — the same box routing soldiers exit at) expanded
// outward by `margin`. This is what makes grass cover the full playable
// field plus a skirt, rather than a hardcoded square that may not line up
// with the actual map edge.
//
// Shadows: receiveShadow is on so tufts darken correctly under soldier and
// terrain shadows. castShadow is deliberately off — thousands of
// shadow-casting instances would roughly double the shadow-pass cost for a
// nearly invisible contribution (grass shadows are sub-pixel at battle zoom).
export class GrassField {
  constructor(scene, options = {}) {
    this.scene = scene;

    const count = options.count ?? 2000;

    // Rectangle to fill with grass. Defaults match a typical scenario but
    // callers pass CombatConfig.mapBounds in practice.
    const b = options.bounds ?? { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    const margin = options.margin ?? 20;

    const x0 = b.minX - margin;
    const x1 = b.maxX + margin;
    const z0 = b.minZ - margin;
    const z1 = b.maxZ + margin;
    const spanX = x1 - x0;
    const spanZ = z1 - z0;

    const geo = this._buildCrossedPlanes();
    const tex = this._createGrassTexture();
    const mat = new THREE.MeshLambertMaterial({
      map: tex,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      transparent: false
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.receiveShadow = true;
    // Selection rays only ever test pick proxies (see BattleRenderer's
    // getPickableMeshes), so grass is invisible to them today. Setting
    // raycast to a no-op keeps it invisible even if that ever changes.
    this.mesh.raycast = () => {};

    // Deterministic scatter: a seeded LCG, so the field is identical every
    // page load. Uniform over the (expanded) bounds rectangle — not a disc —
    // so the corners of the field boundary are covered by grass rather than
    // bare ground.
    const rng = this._mulberry32(0xCAFE);
    const dummy = new THREE.Object3D();

    for (let i = 0; i < count; i++) {
      const x = x0 + rng() * spanX;
      const z = z0 + rng() * spanZ;
      dummy.position.set(x, 0, z);
      dummy.rotation.y = rng() * Math.PI * 2;
      // Height variation: short tufts dominate, occasional taller clumps.
      dummy.scale.setScalar(0.35 + rng() * 0.35);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    scene.add(this.mesh);
  }

  setVisible(visible) {
    this.mesh.visible = !!visible;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    if (this.mesh.material.map) this.mesh.material.map.dispose();
    this.mesh.material.dispose();
  }

  // Two quads crossed at 90° around the Y axis. Both run from y = 0 (base)
  // to y = 1 (tip), so an instance's scale directly sets the tuft's height
  // in world units.
  _buildCrossedPlanes() {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array([
      // plane 1 — in the XY plane
      -0.5, 0, 0,   0.5, 0, 0,   0.5, 1, 0,   -0.5, 1, 0,
      // plane 2 — in the ZY plane
      0, 0, -0.5,   0, 0, 0.5,   0, 1, 0.5,   0, 1, -0.5
    ]);
    const uvs = new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
      0, 0, 1, 0, 1, 1, 0, 1
    ]);
    const indices = new Uint16Array([
      0, 1, 2, 0, 2, 3,
      4, 5, 6, 4, 6, 7
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    return geo;
  }

  // Hand-drawn grass tuft: a few tapered blades rising from the bottom of
  // the canvas, on a fully transparent background. Deterministic (seeded
  // RNG) so every page load produces the same texture — easier to review
  // and tune.
  //
  // Default texture flipY places canvas top at UV v=1 and canvas bottom at
  // v=0, so blades drawn from y=SIZE (base) up to y=tipY (tip) end up with
  // their roots at the bottom of the quad and tips pointing up. Exactly
  // what we want, no flip needed.
  _createGrassTexture() {
    const SIZE = 64;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');

    const rng = this._mulberry32(0x1234);

    const bladeCount = 8;
    for (let i = 0; i < bladeCount; i++) {
      const baseX = SIZE * (0.10 + rng() * 0.80);
      const tipX = baseX + (rng() - 0.5) * SIZE * 0.50;
      const tipY = SIZE * (0.05 + rng() * 0.35);
      const baseW = SIZE * (0.06 + rng() * 0.04);
      const ctrlX = baseX + (tipX - baseX) * 0.4;

      // Per-blade green variation so the tuft doesn't read as one flat hue.
      const r = 40 + Math.floor(rng() * 30);
      const g = 90 + Math.floor(rng() * 60);
      const b = 30 + Math.floor(rng() * 20);

      ctx.beginPath();
      ctx.moveTo(baseX - baseW / 2, SIZE);
      ctx.quadraticCurveTo(ctrlX - baseW / 3, (SIZE + tipY) / 2, tipX, tipY);
      ctx.quadraticCurveTo(ctrlX + baseW / 3, (SIZE + tipY) / 2, baseX + baseW / 2, SIZE);
      ctx.closePath();

      // Vertical gradient: darker at the root, brighter at the tip, so the
      // tuft has implied depth under directional light.
      const grad = ctx.createLinearGradient(0, SIZE, 0, tipY);
      grad.addColorStop(0, `rgb(${r - 15}, ${g - 25}, ${b})`);
      grad.addColorStop(1, `rgb(${r + 15}, ${g + 20}, ${b + 10})`);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace !== undefined) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    return tex;
  }

  // Deterministic PRNG (mulberry32). Local copy rather than a shared import
  // so GrassField has no cross-file dependency for one 6-line helper.
  _mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}
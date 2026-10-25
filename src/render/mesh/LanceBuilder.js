// Cavalry lance. Deliberately and unmistakably distinct from the spear:
// tapered shaft, dark grip wrap, flared vamplate, pennon.
//
// MERGE STRATEGY
// Shaft, grip, vamplate, tip, and pennon are all rigidly attached and
// share nothing but position. They merge into a SINGLE vertex-coloured
// mesh — one draw call per lance instead of five. DoubleSide is needed
// because the vamplate (open-ended cone) and pennon (flat ShapeGeometry)
// have visible back faces; the shaft and tip tolerate the flag without
// any visual change.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeColoredGeometries, partMatrix, paint } from './MeshMerge.js';

const SHAFT_LEN = 2.4;

const WOOD_COLOR     = 0x5a3d20;
const GRIP_COLOR     = 0x2a1a0e;
const VAMPLATE_COLOR = 0x8a6a3a;
const TIP_COLOR      = 0xaaaaaa;
const PENNON_COLOR   = 0xb03030;

export function createLance() {
  const geo = cachedGeometry('lance.mergedGeo', buildMergedLance);
  const mat = cachedMaterial('lance.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0.26, 0.70, 0);
  return mesh;
}

function buildMergedLance() {
  const entries = [];

  // Shaft: tapered. The +Y end of the cylinder (radius 0.014) becomes the
  // tip after the X rotation.
  {
    const g = new THREE.CylinderGeometry(0.014, 0.038, SHAFT_LEN, 8);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, WOOD_COLOR),
      matrix: partMatrix(0, 0, SHAFT_LEN / 2 - 0.5)
    });
  }

  // Grip wrap.
  {
    const g = new THREE.CylinderGeometry(0.048, 0.048, 0.45, 8);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, GRIP_COLOR),
      matrix: partMatrix(0, 0, -0.15)
    });
  }

  // Vamplate: flared hand guard, open-ended.
  {
    const g = new THREE.ConeGeometry(0.15, 0.24, 10, 1, true);
    g.rotateX(-Math.PI / 2);
    entries.push({
      geometry: paint(g, VAMPLATE_COLOR),
      matrix: partMatrix(0, 0, 0.25)
    });
  }

  // Steel head.
  {
    const g = new THREE.ConeGeometry(0.04, 0.38, 8);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, TIP_COLOR),
      matrix: partMatrix(0, 0, SHAFT_LEN - 0.5 + 0.38 / 2 - 0.03)
    });
  }

  // Pennon: flat triangular cloth.
  {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0, -0.20);
    shape.lineTo(-0.28, -0.06);
    shape.closePath();
    entries.push({
      geometry: paint(new THREE.ShapeGeometry(shape), PENNON_COLOR),
      matrix: partMatrix(0, 0, SHAFT_LEN - 0.7)
    });
  }

  return mergeColoredGeometries(entries);
}
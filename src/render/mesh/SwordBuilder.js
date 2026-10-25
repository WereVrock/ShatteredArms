// Swords. Two variants live here:
//
//   createSword      — the standard steel sword used by every non-goblin
//                      sword-armed soldier.
//   createCrudeSword — the crude goblin sword. Short, rusty, chipped,
//                      hand-wrapped.
//
// MERGE STRATEGY
// Both swords are multi-part: blade + hilt for the standard, and
// extruded blade + collar + grip for the crude one. Every part is
// rigidly attached and every material is a plain untextured Lambert, so
// the entire weapon merges into ONE vertex-coloured mesh. One draw call
// per sword instead of two or three.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeColoredGeometries, partMatrix, paint } from './MeshMerge.js';

const BLADE_COLOR = 0xaaaaaa;
const HILT_COLOR  = 0x4a3018;

export function createSword() {
  const geo = cachedGeometry('sword.mergedGeo', buildMergedSword);
  const mat = cachedMaterial('sword.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0.22, 0.65, 0);
  return mesh;
}

function buildMergedSword() {
  const entries = [];

  // Blade.
  {
    const g = new THREE.BoxGeometry(0.05, 0.7, 0.12);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, BLADE_COLOR),
      matrix: partMatrix(0, 0, 0.45)
    });
  }

  // Hilt.
  {
    const g = new THREE.CylinderGeometry(0.03, 0.03, 0.16, 6);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, HILT_COLOR),
      matrix: partMatrix(0, 0, 0.05)
    });
  }

  return mergeColoredGeometries(entries);
}

// --- crude goblin sword ----------------------------------------------------
//
// Built as ONE extruded profile rather than a stack of primitives: the
// taper, the point, the belly, and the chip are all vertices of the
// outline, so the silhouette and the geometry are the same thing by
// construction.

const CRUDE_BLADE_COLOR  = 0x6a5e52;
const CRUDE_COLLAR_COLOR = 0x2a1a0e;
const CRUDE_GRIP_COLOR   = 0x3a2510;
const CRUDE_BLADE_THICKNESS = 0.018;

export function createCrudeSword() {
  const geo = cachedGeometry('crudeSword.mergedGeo', buildMergedCrudeSword);
  const mat = cachedMaterial('crudeSword.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}

function buildMergedCrudeSword() {
  const entries = [];

  // Blade: extruded 9-vertex outline.
  entries.push({
    geometry: paint(buildCrudeBladeGeometry(), CRUDE_BLADE_COLOR)
  });

  // Collar: hand-wrapped band at the hilt/blade junction.
  {
    const g = new THREE.BoxGeometry(0.035, 0.095, 0.028);
    entries.push({
      geometry: paint(g, CRUDE_COLLAR_COLOR),
      matrix: partMatrix(0, 0, 0.045)
    });
  }

  // Grip: short tapered pentagonal handle.
  {
    const g = new THREE.CylinderGeometry(0.016, 0.013, 0.11, 5);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, CRUDE_GRIP_COLOR),
      matrix: partMatrix(0, 0, -0.010)
    });
  }

  return mergeColoredGeometries(entries);
}

function buildCrudeBladeGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0.000, -0.040);
  shape.lineTo(0.080, -0.044);
  shape.lineTo(0.140, -0.031);
  shape.lineTo(0.175, -0.040);
  shape.lineTo(0.320, -0.012);
  shape.lineTo(0.350,  0.003);
  shape.lineTo(0.300,  0.024);
  shape.lineTo(0.100,  0.038);
  shape.lineTo(0.000,  0.040);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: CRUDE_BLADE_THICKNESS,
    bevelEnabled: false,
    curveSegments: 1
  });
  geo.translate(0, 0, -CRUDE_BLADE_THICKNESS / 2);
  geo.rotateY(-Math.PI / 2);
  geo.translate(0, 0, 0.05);
  return geo;
}
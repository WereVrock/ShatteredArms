// Single-mesh arrow. Shaft, head and three fletches are baked into ONE
// BufferGeometry with per-vertex colours, so a whole quiver's worth of
// arrows costs one draw call each instead of five. Geometry and material
// are cached (see MeshCache.js) — every arrow in the game shares both.
//
// The original build was a Group containing five meshes (shaft cylinder,
// head cone, three fin boxes hung off three pivot Groups). At 50+ arrows in
// flight that's 250+ scene-graph nodes and 250+ draw calls for what is, at
// battle zoom, a single small visual. Merging trades that for one mesh per
// arrow with the exact same silhouette and colours.
//
// The merge is done locally rather than via three/examples/jsm's
// mergeGeometries so this file has no dependency on the examples/jsm
// subpath — that path is a bare specifier that only resolves under a
// bundler, not against a browser import map. A hand-rolled merge is
// trivial here: every part has the same attribute set (position, normal,
// colour), no UVs, and small vertex counts.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

const SHAFT_LEN = 0.7;
const SHAFT_COLOR = 0x8a5a24;
const HEAD_COLOR = 0xf0f0f0;
const FIN_COLOR = 0xdddddd;

export function createArrowProjectile() {
  const geo = cachedGeometry('arrow.mergedGeo', buildMergedArrowGeometry);
  const mat = cachedMaterial('arrow.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  return new THREE.Mesh(geo, mat);
}

function buildMergedArrowGeometry() {
  const parts = [];

  // Shaft — centred at origin, spanning Z from -SHAFT_LEN/2 to +SHAFT_LEN/2.
  // CylinderGeometry builds along +Y, so rotate 90° around X to lay it on Z.
  const shaft = new THREE.CylinderGeometry(0.02, 0.02, SHAFT_LEN, 5);
  shaft.rotateX(Math.PI / 2);
  parts.push(paint(shaft, SHAFT_COLOR));

  // Head — cone at the front tip.
  const head = new THREE.ConeGeometry(0.055, 0.18, 6);
  head.rotateX(Math.PI / 2);
  head.translate(0, 0, SHAFT_LEN / 2 + 0.09);
  parts.push(paint(head, HEAD_COLOR));

  // Three fletches fanned around the tail.
  //
  // Original transform chain per fin was:
  //   fin.position = (0, 0.07, -SHAFT_LEN/2 + 0.1)   — local offset
  //   pivot.rotation.z = (i / 3) * 2π                — fan around shaft axis
  // so the world position of each vertex v was R_z(angle) * (P + v).
  // Bake that same chain into the geometry by translating first, then
  // rotating — geometry.translate moves the vertices, geometry.rotateZ then
  // spins the translated result around Z through the origin.
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.BoxGeometry(0.012, 0.13, 0.16);
    fin.translate(0, 0.07, -SHAFT_LEN / 2 + 0.1);
    fin.rotateZ((i / 3) * Math.PI * 2);
    parts.push(paint(fin, FIN_COLOR));
  }

  const merged = mergeParts(parts);
  for (const p of parts) p.dispose();
  return merged;
}

// Strips UVs (the arrow material has no map, so UVs are dead weight in the
// merged buffer) and adds a flat per-vertex colour attribute.
function paint(geo, hex) {
  geo.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// Concatenates an array of {position, normal, color}-bearing BufferGeometries
// into a single indexed BufferGeometry. Assumes every part carries exactly
// those three attributes (paint() guarantees position/normal come from the
// primitive builders and colour is added by paint). Total vertex count is
// tiny (under 130 here), so Uint16 indices are plenty.
function mergeParts(geos) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geos) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const index = new Uint16Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    position.set(p.array, vOff * 3);
    normal.set(g.attributes.normal.array, vOff * 3);
    color.set(g.attributes.color.array, vOff * 3);

    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) index[iOff + i] = gi[i] + vOff;
      iOff += gi.length;
    } else {
      for (let i = 0; i < p.count; i++) index[iOff + i] = vOff + i;
      iOff += p.count;
    }
    vOff += p.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}
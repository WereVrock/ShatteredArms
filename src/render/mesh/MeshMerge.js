// ===== src/render/mesh/MeshMerge.js =====
// Static geometry merge for the model builders.
//
// A soldier is a small tree of meshes where most parts never move
// relative to each other: torso + head, a skeleton's pelvis + spine +
// ribs + skull, a horse's chest + haunch + neck + head. Each such group
// of rigidly-attached, single-material parts can be flattened into ONE
// mesh without any visual change, cutting a soldier's draw calls from a
// dozen or more down to the handful of parts that genuinely need their
// own transform (leg pivots, shield tint, weapon aim/swing).
//
// UVs and per-vertex colour are dropped by mergeGeometries: every caller
// uses a plain MeshLambertMaterial with no map and no vertex colours, so
// those attributes would be pure dead weight in the merged buffer.
//
// mergeColoredGeometries is the multi-material variant: callers paint
// each part with a flat hex via paint(), and the merge keeps the colour
// attribute so a single shared vertexColors material can cover every
// part. This is what lets QuiverBuilder, LanceBuilder, SwordBuilder,
// SpearBuilder and FlagBuilder collapse 2-19 meshes into one.
//
// Input geometries are CLONED before their matrix is applied, so a
// cached shared geometry can be merged without being mutated. The clones
// are disposed inside the merge — the caller only owns the result.
import * as THREE from 'three';

// Builds a transform matrix from a position + XYZ Euler rotation.
export function partMatrix(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
  m.setPosition(x, y, z);
  return m;
}

// Composed transform, for parts whose final pose is expressed as
// position + quaternion + scale (e.g. the goblin ear).
export function poseMatrix(position, quaternion, scale) {
  return new THREE.Matrix4().compose(position, quaternion, scale);
}

// Merges `entries` (each { geometry, matrix? }) into a single indexed
// BufferGeometry carrying position and normal only.
export function mergeGeometries(entries) {
  const prepared = entries.map(({ geometry, matrix }) => {
    const g = geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    return g;
  });

  let vertexCount = 0;
  let indexCount = 0;
  for (const g of prepared) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const index = new Uint32Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  for (const g of prepared) {
    const p = g.attributes.position;
    position.set(p.array, vOff * 3);
    normal.set(g.attributes.normal.array, vOff * 3);

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

  for (const g of prepared) g.dispose();

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}

// Attaches a flat per-vertex colour attribute to `geo`, stripping UVs
// (the merged vertexColors material has no map). Mutates and returns the
// geometry — callers pass a freshly-built geometry, never a cached one.
export function paint(geo, hex) {
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

// Merges `entries` (each { geometry, matrix? }) into one indexed
// BufferGeometry carrying position, normal, and color. Any entry lacking
// a color attribute gets flat white.
export function mergeColoredGeometries(entries) {
  const prepared = entries.map(({ geometry, matrix }) => {
    const g = geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.color) {
      const count = g.attributes.position.count;
      const colors = new Float32Array(count * 3);
      colors.fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    return g;
  });

  let vertexCount = 0;
  let indexCount = 0;
  for (const g of prepared) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const index = new Uint32Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  for (const g of prepared) {
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

  for (const g of prepared) g.dispose();

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}